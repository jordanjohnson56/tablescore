import express from "express";
import { fileURLToPath } from "node:url";
import { HttpError } from "./db.js";
import { BggError } from "./bgg.js";
import { syncCollection, addFromBgg } from "./sync.js";
import { CRITERIA } from "../public/js/rubric.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

export function createApp({ store, bgg, bggUsername }) {
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

  const job = { running: false, phase: "", done: 0, total: 0, error: null, result: null, finishedAt: null };

  app.get("/api/state", (req, res) => {
    res.json({
      settings: store.getSettings(),
      games: store.listGames(),
      bgg: { configured: bgg.configured, username: bggUsername || null },
    });
  });

  app.put("/api/settings", (req, res) => {
    const { weights, stretch, hideExpansions } = req.body;
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
    res.json(store.setSettings({ weights, stretch, hideExpansions }));
  });

  app.post("/api/games", (req, res) => {
    const { name, bggId, type = "Base", status = "" } = req.body;
    if (!name?.trim()) throw new HttpError(400, "name is required");
    if (bggId && store.getByBggId(bggId)) throw new HttpError(409, "that BGG game is already in your list");
    res.status(201).json(store.createGame({ name: name.trim(), bggId: bggId || null, type, status }));
  });

  app.post("/api/games/from-bgg", async (req, res) => {
    const bggId = Number(req.body.bggId);
    if (!Number.isInteger(bggId) || bggId <= 0) throw new HttpError(400, "bggId must be a positive integer");
    const { game, existed } = await addFromBgg(store, bgg, bggId);
    if (!game) throw new HttpError(404, "BGG has no game with that id");
    res.status(existed ? 200 : 201).json(game);
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

  app.get("/api/export", (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.attachment(`tablescore-${stamp}.json`);
    res.json({ exportedAt: new Date().toISOString(), settings: store.getSettings(), games: store.listGames() });
  });

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
