import express from "express";
import { fileURLToPath } from "node:url";
import { HttpError } from "./db.js";
import { BggError } from "./bgg.js";
import { syncCollection, addFromBgg, linkToBgg } from "./sync.js";
import { watchlistExport } from "./export-watchlist.js";
import { Predictor, PredictError, buildSystem, buildTarget } from "./predict.js";
import { CRITERIA, finalScore } from "../public/js/rubric.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const TASTE_PROFILE_LIMIT = 4000;

export function createApp({ store, bgg, bggUsername, predictor = new Predictor() }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Mutations must be JSON. Browsers can't send that cross-site without a CORS
  // preflight, which this server never answers, so other sites can't write here.
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      return res.status(415).json({ error: "Content-Type must be application/json" });
    }
    next();
  });

  let predicting = null; // id of the running Claude prediction
  const job = { running: false, phase: "", done: 0, total: 0, error: null, result: null, finishedAt: null };

  app.get("/api/state", (req, res) => {
    res.json({
      settings: store.getSettings(),
      games: store.listGames(),
      bgg: { configured: bgg.configured, username: bggUsername || null },
      claude: { configured: predictor.configured, model: predictor.model, running: predicting },
    });
  });

  app.put("/api/settings", (req, res) => {
    const { weights, stretch, hideExpansions, includeWatching, tasteProfile } = req.body;
    if (weights !== undefined) {
      const ok = CRITERIA.every((c) => typeof weights[c.key] === "number" && weights[c.key] >= 0);
      if (!ok) throw new HttpError(400, "weights needs a non-negative number for every criterion");
    }
    if (stretch !== undefined && !(typeof stretch === "number" && stretch > 0 && stretch <= 5)) {
      throw new HttpError(400, "stretch must be a number between 0 and 5");
    }
    if (hideExpansions !== undefined && typeof hideExpansions !== "boolean") {
      throw new HttpError(400, "hideExpansions must be true or false");
    }
    if (includeWatching !== undefined && typeof includeWatching !== "boolean") {
      throw new HttpError(400, "includeWatching must be true or false");
    }
    if (tasteProfile !== undefined && !(typeof tasteProfile === "string" && tasteProfile.length <= TASTE_PROFILE_LIMIT)) {
      throw new HttpError(400, `tasteProfile must be text of at most ${TASTE_PROFILE_LIMIT} characters`);
    }
    res.json(store.setSettings({ weights, stretch, hideExpansions, includeWatching, tasteProfile }));
  });

  app.post("/api/games", (req, res) => {
    const { name, bggId, type = "Base", status = "", watchStage } = req.body;
    if (!name?.trim()) throw new HttpError(400, "name is required");
    if (bggId && store.getByBggId(bggId)) throw new HttpError(409, "that BGG game is already in your list");
    res.status(201).json(store.createGame({ name: name.trim(), bggId: bggId || null, type, status, watchStage }));
  });

  app.post("/api/games/from-bgg", async (req, res) => {
    const bggId = Number(req.body.bggId);
    if (!Number.isInteger(bggId) || bggId <= 0) throw new HttpError(400, "bggId must be a positive integer");
    // createGame validates the watch stage, so a bad one is a 400 that adds nothing.
    const { game, existed } = await addFromBgg(store, bgg, bggId, { watchStage: req.body.watchStage });
    if (!game) throw new HttpError(404, "BGG has no game with that id");
    res.status(existed ? 200 : 201).json(existed ? game : carryPrediction(game));
  });

  // Attach a game that has no BGG ID (a watched game, say) to its BGG entry.
  app.post("/api/games/:id/link-bgg", async (req, res) => {
    const id = Number(req.params.id);
    const bggId = Number(req.body.bggId);
    if (!Number.isInteger(bggId) || bggId <= 0) throw new HttpError(400, "bggId must be a positive integer");
    const taken = () => {
      const owner = store.getByBggId(bggId);
      if (owner && owner.id !== id) throw new HttpError(409, "that BGG game is already in your list");
    };
    const current = store.getGame(id);
    if (!current) throw new HttpError(404, "game not found");
    if (current.bggId) throw new HttpError(400, "that game is already linked to BGG");
    taken();
    const details = await bgg.things([bggId]);
    if (!details.length) throw new HttpError(404, "BGG has no game with that id");
    taken(); // another request may have claimed it while BGG was answering
    res.json(linkToBgg(store, id, details[0]));
  });

  app.patch("/api/games/:id", (req, res) => {
    res.json(store.updateGame(Number(req.params.id), req.body));
  });

  // BGG's API is read-only, so the user rates on BGG by hand and reports it here.
  // This only echoes what BGG should now hold; the next sync overwrites it.
  app.post("/api/games/:id/bgg-rated", (req, res) => {
    const id = Number(req.params.id);
    const { rating } = req.body;
    if (!(typeof rating === "number" && rating >= 1 && rating <= 10)) {
      throw new HttpError(400, "rating must be a number from 1 to 10");
    }
    const g = store.getGame(id);
    if (!g) throw new HttpError(404, "game not found");
    if (!g.bggId) throw new HttpError(400, "that game isn't linked to BGG");
    res.json(store.applyBgg(id, { bggRating: rating }));
  });

  app.delete("/api/games/:id", (req, res) => {
    store.deleteGame(Number(req.params.id));
    res.status(204).end();
  });

  app.get("/api/bgg/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json([]);
    const results = await bgg.search(q);
    const have = new Set(store.listGames().map((g) => g.bggId));
    res.json(results.slice(0, 30).map((r) => ({ ...r, inList: have.has(r.bggId) })));
  });

  app.get("/api/bgg/sync", (req, res) => res.json(job));

  app.post("/api/bgg/sync", (req, res) => {
    if (!bgg.configured) throw new HttpError(400, "BGG_TOKEN is not set on the server");
    if (!bggUsername) throw new HttpError(400, "BGG_USERNAME is not set on the server");
    if (!job.running) {
      Object.assign(job, { running: true, phase: "Starting", done: 0, total: 0, error: null, result: null });
      syncCollection(store, bgg, bggUsername, (p) => Object.assign(job, p))
        .then((result) => Object.assign(job, { result }))
        .catch((e) => Object.assign(job, { error: e.message }))
        .finally(() => Object.assign(job, { running: false, phase: "", finishedAt: new Date().toISOString() }));
    }
    res.status(202).json(job);
  });

  // ---------- Claude predictions ----------
  // One runs at a time. Each is a job: POST answers at once and the client polls
  // the prediction, so a locked phone doesn't lose it.
  app.post("/api/predictions", (req, res) => {
    if (!predictor.configured) throw new HttpError(400, "ANTHROPIC_API_KEY is not set on the server");
    if (predicting) throw new HttpError(409, "a prediction is already running");
    const target = predictionTarget(req.body);
    const prediction = store.createPrediction({ ...target, model: predictor.model });
    predicting = prediction.id;
    runPrediction(prediction.id, target)
      .catch((e) => {
        if (!(e instanceof PredictError || e instanceof BggError)) console.error("prediction failed:", e);
        store.failPrediction(prediction.id, e.message || "prediction failed");
      })
      .finally(() => {
        predicting = null;
      });
    res.status(202).json(prediction);
  });

  app.get("/api/predictions", (req, res) => {
    const bggId = Number(req.query.bggId) || null;
    const gameId = Number(req.query.gameId) || null;
    if (!bggId && !gameId) throw new HttpError(400, "give bggId or gameId");
    // A game in the list also matches predictions made for its BGG ID from search.
    const game = gameId ? store.getGame(gameId) : null;
    res.json(store.listPredictions({ bggId: bggId ?? game?.bggId ?? null, gameId }));
  });

  app.get("/api/predictions/accuracy", (req, res) => res.json(store.predictionAccuracy()));

  app.get("/api/predictions/latest", (req, res) => res.json(store.latestPredictions()));

  app.get("/api/predictions/:id", (req, res) => {
    const p = store.getPrediction(Number(req.params.id));
    if (!p) throw new HttpError(404, "prediction not found");
    res.json(p);
  });

  /** Which game to predict, from a request body of { gameId } or { bggId, name }. */
  function predictionTarget({ gameId, bggId, name }) {
    if (gameId != null) {
      const game = store.getGame(Number(gameId));
      if (!game) throw new HttpError(404, "game not found");
      return checkUnscored({ gameId: game.id, bggId: game.bggId, name: game.name }, game);
    }
    const id = Number(bggId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "give a gameId, or a bggId that is a positive integer");
    const game = store.getByBggId(id);
    const label = game?.name || (typeof name === "string" && name.trim()) || `BGG game ${id}`;
    return checkUnscored({ gameId: game?.id ?? null, bggId: id, name: label }, game);
  }

  function checkUnscored(target, game) {
    if (game && finalScore(game.scores, store.getSettings()) != null) {
      throw new HttpError(409, "that game is already scored");
    }
    return target;
  }

  async function runPrediction(id, target) {
    // BGG details are a bonus: if BGG fails, Claude works from the name and the web.
    let details = null;
    if (target.bggId && bgg.configured) {
      try {
        details = await bgg.details(target.bggId);
      } catch (e) {
        console.error(`BGG details for ${target.bggId} failed, predicting by name:`, e.message);
      }
    }
    const settings = store.getSettings();
    const games = store.listGames();
    const system = buildSystem(games, settings, target);
    const result = await predictor.predict({
      system: system.text,
      target: buildTarget({ name: target.name, details, games, settings }),
    });
    const done = store.finishPrediction(id, { ...result, name: details?.name || target.name, scoredGames: system.scoredGames });
    // A watched game in the list takes the prediction only if its own is empty.
    const game = target.gameId ? store.getGame(target.gameId) : target.bggId ? store.getByBggId(target.bggId) : null;
    if (game?.watchStage && game.predictedScore == null && done.final != null) {
      store.updateGame(game.id, { predictedScore: done.final });
    }
  }

  /**
   * A game just added from BGG takes its latest prediction: the avoid-theme
   * flag, and the predicted score if it's being watched.
   */
  function carryPrediction(game) {
    const latest = store.listPredictions({ bggId: game.bggId }).find((p) => p.status === "done");
    if (!latest) return game;
    const patch = {};
    if (latest.avoidTheme && !game.avoidTheme) patch.avoidTheme = true;
    if (game.watchStage && game.predictedScore == null) patch.predictedScore = latest.final;
    return Object.keys(patch).length ? store.updateGame(game.id, patch) : game;
  }

  app.get("/api/export", (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.attachment(`tablescore-${stamp}.json`);
    res.json({ exportedAt: new Date().toISOString(), settings: store.getSettings(), games: store.listGames() });
  });

  // Read-only, for the monthly watchlist routine (ADR 0001) and local scripts.
  app.get("/api/watchlist", (req, res) => res.json(watchlistExport(store)));

  app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof BggError) return res.status(502).json({ error: err.message });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
