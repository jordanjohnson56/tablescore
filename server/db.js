// SQLite storage. One file holds every game, its rubric scores and the settings.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CRITERIA, DEFAULT_SETTINGS, finalScore } from "../public/js/rubric.js";
import { GAME_TYPES, PLATFORMS, STAGE_KEYS, STATUSES } from "../public/js/watchlist.js";

const SCORE_COLS = CRITERIA.map((c) => `s_${c.key}`);

// Editable through the API. Everything BGG owns is written only by sync.
const USER_FIELDS = {
  name: "name",
  type: "type",
  status: "status",
  plays: "plays",
  avoidTheme: "avoid_theme",
  wontScore: "wont_score",
  calibration: "calibration",
  notes: "notes",
  bestPlayers: "best_players",
};

// Watch fields, also user-editable, with their column types. Added to existing
// databases by migrate(); BGG sync never writes them.
export const WATCH_FIELDS = {
  watchStage: ["watch_stage", "TEXT"],
  campaignUrl: ["campaign_url", "TEXT"],
  platform: ["platform", "TEXT"],
  campaignEnd: ["campaign_end", "TEXT"],
  deliveryEst: ["delivery_est", "TEXT"],
  predictedScore: ["predicted_score", "REAL"],
  targetPrice: ["target_price", "REAL"],
  targetCurrency: ["target_currency", "TEXT"],
};

// One check per watch field: true if the (non-null) value is allowed, plus the
// message a 400 carries otherwise.
// One decimal at most, allowing for float error (7.3 * 10 isn't exactly 73).
const oneDecimal = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
// A real calendar day: 2026-02-30 rolls over to March, and 2026-13-01 is Invalid Date.
const isDate = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};
const WATCH_RULES = {
  watchStage: [(v) => STAGE_KEYS.includes(v), `watchStage must be one of ${STAGE_KEYS.join(", ")} or null`],
  campaignUrl: [(v) => typeof v === "string" && /^https?:\/\/\S+$/.test(v), "campaignUrl must be an http(s) URL or null"],
  platform: [(v) => PLATFORMS.some((p) => p.key === v), `platform must be one of ${PLATFORMS.map((p) => p.key).join(", ")} or null`],
  campaignEnd: [(v) => typeof v === "string" && isDate(v), "campaignEnd must be a date like 2026-10-30 or null"],
  deliveryEst: [(v) => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v), "deliveryEst must be a month like 2027-09 or null"],
  predictedScore: [(v) => typeof v === "number" && v >= 0 && v <= 10 && oneDecimal(v), "predictedScore must be 0-10 with at most one decimal, or null"],
  targetPrice: [(v) => typeof v === "number" && Number.isFinite(v) && v >= 0, "targetPrice must be a non-negative number or null"],
  targetCurrency: [(v) => typeof v === "string" && /^[A-Z]{3}$/.test(v), "targetCurrency must be a three-letter code like USD or null"],
};

/**
 * Validate watch fields in a patch or new game and return their normalized
 * values (an empty string means null). Throws a 400 HttpError on a bad value.
 * Keys that aren't watch fields are ignored.
 */
export function checkWatchFields(fields) {
  const out = {};
  for (const [k, [ok, msg]] of Object.entries(WATCH_RULES)) {
    if (fields[k] === undefined) continue;
    const v = fields[k] === "" ? null : fields[k];
    if (v !== null && !ok(v)) throw new HttpError(400, msg);
    out[k] = v;
  }
  return out;
}

// One check per user field, as for watch fields, but null is never allowed:
// every user column is NOT NULL.
const isText = (max) => (v) => typeof v === "string" && v.length <= max;
const isFlag = (v) => typeof v === "boolean";
const USER_RULES = {
  name: [(v) => isText(200)(v) && v.trim() !== "", "name must be text of 1 to 200 characters"],
  type: [(v) => GAME_TYPES.includes(v), `type must be one of ${GAME_TYPES.join(", ")}`],
  status: [(v) => STATUSES.includes(v), `status must be one of ${STATUSES.filter(Boolean).join(", ")} or empty`],
  plays: [(v) => Number.isInteger(v) && v >= 0, "plays must be a whole number from 0"],
  avoidTheme: [isFlag, "avoidTheme must be true or false"],
  wontScore: [isFlag, "wontScore must be true or false"],
  calibration: [isFlag, "calibration must be true or false"],
  notes: [isText(10000), "notes must be text of at most 10000 characters"],
  bestPlayers: [isText(40), "bestPlayers must be text of at most 40 characters"],
};

/**
 * Validate user fields in a patch or new game from the API and return their
 * normalized values (name trimmed). Throws a 400 HttpError on a bad value.
 * Keys that aren't user fields are ignored.
 */
export function checkUserFields(fields) {
  const out = {};
  for (const [k, [ok, msg]] of Object.entries(USER_RULES)) {
    if (fields[k] === undefined) continue;
    if (!ok(fields[k])) throw new HttpError(400, msg);
    out[k] = k === "name" ? fields[k].trim() : fields[k];
  }
  return out;
}

const BGG_FIELDS = {
  bggId: "bgg_id",
  name: "name",
  type: "type",
  status: "status",
  plays: "plays",
  bggRating: "bgg_rating",
  bggAvg: "bgg_avg",
  year: "year",
  minPlayers: "min_players",
  maxPlayers: "max_players",
  bestPlayers: "best_players",
  playTime: "play_time",
  bggWeight: "bgg_weight",
  image: "image",
  thumbnail: "thumbnail",
};

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY,
      bgg_id INTEGER UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Base',
      status TEXT NOT NULL DEFAULT '',
      plays INTEGER NOT NULL DEFAULT 0,
      old_rating REAL,
      bgg_rating REAL,
      bgg_avg REAL,
      calibration INTEGER NOT NULL DEFAULT 0,
      avoid_theme INTEGER NOT NULL DEFAULT 0,
      wont_score INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      year INTEGER,
      min_players INTEGER,
      max_players INTEGER,
      best_players TEXT NOT NULL DEFAULT '',
      play_time INTEGER,
      bgg_weight REAL,
      image TEXT,
      thumbnail TEXT,
      ${SCORE_COLS.map((c) => `${c} REAL`).join(",\n      ")},
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Claude's predicted scores. Keyed by BGG ID so a game can be predicted
    -- without adding it; game_id covers games in the list that have no BGG ID.
    -- A deleted game's predictions keep its game_id, and createGame never
    -- gives a new game an id a prediction still holds.
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY,
      bgg_id INTEGER,
      game_id INTEGER,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      model TEXT NOT NULL,
      scored_games INTEGER NOT NULL DEFAULT 0,
      ${SCORE_COLS.map((c) => `${c} REAL`).join(",\n      ")},
      confidence TEXT,
      avoid_theme INTEGER NOT NULL DEFAULT 0,
      avoid_theme_reason TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      two_player TEXT NOT NULL DEFAULT '',
      sources TEXT NOT NULL DEFAULT '[]',
      usage TEXT,
      thumbnail TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS predictions_bgg ON predictions (bgg_id);
    CREATE INDEX IF NOT EXISTS predictions_game ON predictions (game_id);
    -- Recommendation runs: Claude nominates games, each is predicted, and the
    -- best are picked. Every nominee is kept with why it was or wasn't shown.
    CREATE TABLE IF NOT EXISTS recommendation_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      trigger TEXT NOT NULL DEFAULT 'schedule',
      error TEXT,
      model TEXT NOT NULL,
      usage TEXT,
      predicted INTEGER NOT NULL DEFAULT 0,
      reused INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
      bgg_id INTEGER,
      name TEXT NOT NULL,
      year INTEGER,
      type TEXT NOT NULL DEFAULT 'Base',
      thumbnail TEXT,
      reason TEXT NOT NULL DEFAULT '',
      prediction_id INTEGER,
      rank INTEGER,
      dropped TEXT
    );
    CREATE INDEX IF NOT EXISTS recommendations_run ON recommendations (run_id);
    -- Games the user marked Not interested. They are never recommended again.
    CREATE TABLE IF NOT EXISTS dismissed_games (
      bgg_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  migrate(db);
  return new Store(db);
}

/** Add any missing columns. Safe to repeat; existing rows get nulls (watch fields) or 0 (wont_score). */
function migrate(db) {
  const have = new Set(db.prepare("PRAGMA table_info(games)").all().map((c) => c.name));
  for (const [col, type] of Object.values(WATCH_FIELDS)) {
    if (!have.has(col)) db.exec(`ALTER TABLE games ADD COLUMN ${col} ${type}`);
  }
  if (!have.has("wont_score")) db.exec("ALTER TABLE games ADD COLUMN wont_score INTEGER NOT NULL DEFAULT 0");
  // When all seven scores were first entered in the app. Null for games scored
  // before this column existed, which keeps them out of prediction accuracy.
  if (!have.has("scored_at")) db.exec("ALTER TABLE games ADD COLUMN scored_at TEXT");
  // BGG's thumbnail for a predicted game that isn't in the list.
  const predCols = new Set(db.prepare("PRAGMA table_info(predictions)").all().map((c) => c.name));
  if (!predCols.has("thumbnail")) db.exec("ALTER TABLE predictions ADD COLUMN thumbnail TEXT");
  // Before createGame stopped reusing ids, a deleted game's predictions could
  // land on the next game. Where the BGG IDs disagree that is provable (a
  // game's BGG ID is only ever set from empty), so detach them; their BGG ID
  // still finds them.
  db.exec(`UPDATE predictions SET game_id = NULL WHERE bgg_id IS NOT NULL AND game_id IN
    (SELECT id FROM games g WHERE g.bgg_id IS NOT NULL AND g.bgg_id != predictions.bgg_id)`);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  getSettings() {
    const rows = this.db.prepare("SELECT key, value FROM settings").all();
    const s = structuredClone(DEFAULT_SETTINGS);
    for (const { key, value } of rows) s[key] = JSON.parse(value);
    return s;
  }

  setSettings(patch) {
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const key of ["weights", "stretch", "hideExpansions", "includeWatching", "tasteProfile", "recommendFrequency", "recommendNominees"]) {
      if (patch[key] !== undefined) stmt.run(key, JSON.stringify(patch[key]));
    }
    return this.getSettings();
  }

  listGames() {
    return this.db.prepare("SELECT * FROM games ORDER BY name COLLATE NOCASE").all().map(toGame);
  }

  getGame(id) {
    const row = this.db.prepare("SELECT * FROM games WHERE id = ?").get(id);
    return row ? toGame(row) : null;
  }

  getByBggId(bggId) {
    const row = this.db.prepare("SELECT * FROM games WHERE bgg_id = ?").get(bggId);
    return row ? toGame(row) : null;
  }

  /** Insert a game. Accepts user fields, BGG fields, oldRating, scores and watch fields. */
  createGame(game) {
    const cols = {};
    for (const [k, col] of Object.entries({ ...USER_FIELDS, ...BGG_FIELDS, oldRating: "old_rating" })) {
      if (game[k] !== undefined) cols[col] = toSql(game[k]);
    }
    for (const [k, v] of Object.entries(checkWatchFields(game))) cols[WATCH_FIELDS[k][0]] = v;
    for (const c of CRITERIA) {
      if (game.scores?.[c.key] !== undefined) cols[`s_${c.key}`] = game.scores[c.key];
    }
    if (!cols.name) throw new HttpError(400, "name is required");
    const names = Object.keys(cols);
    // A deleted game's predictions keep its id, and SQLite would hand a deleted
    // highest id to the next game, which would then show them as its own. So
    // the new id is above every game id and every prediction's game_id. One
    // statement, so the CLIs writing to the same file can't race it.
    const nextId =
      "(SELECT MAX(IFNULL((SELECT MAX(id) FROM games), 0), IFNULL((SELECT MAX(game_id) FROM predictions), 0)) + 1)";
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO games (id, ${names.join(", ")}) VALUES (${nextId}, ${names.map(() => "?").join(", ")})`)
      .run(...Object.values(cols));
    return this.getGame(Number(lastInsertRowid));
  }

  /** Patch user-editable fields and scores. Unknown keys are rejected. */
  updateGame(id, patch) {
    const sets = [];
    const vals = [];
    const watch = checkWatchFields(patch);
    const user = checkUserFields(patch);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue; // an internal caller's absent field
      if (k in watch) {
        sets.push(`${WATCH_FIELDS[k][0]} = ?`);
        vals.push(watch[k]);
      } else if (k === "scores") {
        for (const [ck, cv] of Object.entries(v || {})) {
          if (!CRITERIA.some((c) => c.key === ck)) throw new HttpError(400, `unknown criterion ${ck}`);
          if (cv !== null && !(typeof cv === "number" && cv >= 0 && cv <= 10)) {
            throw new HttpError(400, `${ck} must be 0-10 or null`);
          }
          sets.push(`s_${ck} = ?`);
          vals.push(cv);
        }
      } else if (k in user) {
        sets.push(`${USER_FIELDS[k]} = ?`);
        vals.push(toSql(user[k]));
      } else {
        throw new HttpError(400, `field ${k} is not editable`);
      }
    }
    if (!this.getGame(id)) throw new HttpError(404, "game not found");
    if (sets.length) {
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      this.db.prepare(`UPDATE games SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      if (patch.scores && CRITERIA.every((c) => this.getGame(id).scores[c.key] != null)) {
        this.db.prepare("UPDATE games SET scored_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND scored_at IS NULL").run(id);
      }
    }
    return this.getGame(id);
  }

  /** Overwrite BGG-owned fields only; scores, notes and flags are untouched. */
  applyBgg(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!BGG_FIELDS[k] || v === undefined) continue;
      sets.push(`${BGG_FIELDS[k]} = ?`);
      vals.push(toSql(v));
    }
    if (sets.length) this.db.prepare(`UPDATE games SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getGame(id);
  }

  deleteGame(id) {
    const { changes } = this.db.prepare("DELETE FROM games WHERE id = ?").run(id);
    if (!changes) throw new HttpError(404, "game not found");
  }

  /** Start a prediction row in the running state. */
  createPrediction({ bggId = null, gameId = null, name, model }) {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO predictions (bgg_id, game_id, name, model) VALUES (?, ?, ?, ?)")
      .run(bggId, gameId, name, model);
    return this.getPrediction(Number(lastInsertRowid));
  }

  finishPrediction(id, p) {
    this.db
      .prepare(
        `UPDATE predictions SET status = 'done', name = ?, scored_games = ?, ${SCORE_COLS.map((c) => `${c} = ?`).join(", ")},
         confidence = ?, avoid_theme = ?, avoid_theme_reason = ?, rationale = ?, two_player = ?, sources = ?, usage = ?, thumbnail = ?,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(
        p.name, p.scoredGames, ...CRITERIA.map((c) => p.scores[c.key]),
        p.confidence, p.avoidTheme ? 1 : 0, p.avoidThemeReason, p.rationale, p.twoPlayer,
        JSON.stringify(p.sources), JSON.stringify(p.usage ?? null), p.thumbnail ?? null, id,
      );
    return this.getPrediction(id);
  }

  failPrediction(id, error) {
    this.db
      .prepare("UPDATE predictions SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(error, id);
    return this.getPrediction(id);
  }

  /** On startup: a prediction still running was cut off by a restart. */
  failRunningPredictions() {
    return this.db
      .prepare("UPDATE predictions SET status = 'failed', error = 'The server restarted before it finished.', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'")
      .run().changes;
  }

  getPrediction(id) {
    const row = this.db.prepare("SELECT * FROM predictions WHERE id = ?").get(id);
    return row ? toPrediction(row, this.getSettings()) : null;
  }

  /** Every prediction for a BGG ID or a game in the list, newest first. */
  listPredictions({ bggId = null, gameId = null }) {
    const settings = this.getSettings();
    return this.db
      .prepare("SELECT * FROM predictions WHERE bgg_id = ? OR game_id = ? ORDER BY created_at DESC, id DESC")
      .all(bggId, gameId)
      .map((r) => toPrediction(r, settings));
  }

  /** BGG IDs with a prediction but no thumbnail, for a backfill. */
  predictionBggIdsWithoutThumbnail() {
    return this.db
      .prepare("SELECT DISTINCT bgg_id FROM predictions WHERE bgg_id IS NOT NULL AND thumbnail IS NULL")
      .all()
      .map((r) => r.bgg_id);
  }

  setPredictionThumbnail(bggId, thumbnail) {
    this.db.prepare("UPDATE predictions SET thumbnail = ? WHERE bgg_id = ?").run(thumbnail, bggId);
  }

  /**
   * One prediction per game, for the predictions screen: the latest finished
   * one, or the latest of any status when none finished. A game in the list
   * gathers predictions made for it and for its BGG ID, and its gameId is set
   * even when the prediction was made from search. `count` is every attempt;
   * `running` says a newer one is under way.
   */
  latestPredictions() {
    const settings = this.getSettings();
    const ids = new Set();
    const byBgg = new Map();
    for (const r of this.db.prepare("SELECT id, bgg_id FROM games").all()) {
      ids.add(r.id);
      if (r.bgg_id != null) byBgg.set(r.bgg_id, r.id);
    }
    const groups = new Map();
    for (const row of this.db.prepare("SELECT * FROM predictions ORDER BY created_at DESC, id DESC").all()) {
      // A deleted game's predictions fall back to their BGG ID.
      const gameId = (ids.has(row.game_id) ? row.game_id : byBgg.get(row.bgg_id)) ?? null;
      const key = gameId != null ? `g${gameId}` : row.bgg_id != null ? `b${row.bgg_id}` : `x${row.game_id}`;
      const group = groups.get(key) || { gameId, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].map(({ gameId, rows }) => {
      const pick = rows.find((r) => r.status === "done") || rows[0];
      return { ...toPrediction(pick, settings), gameId, count: rows.length, running: rows[0].status === "running" };
    });
  }

  /**
   * Predicted vs actual for every game scored in the app after a prediction:
   * the latest finished prediction made before the game's first full score.
   * Besides the error on the final it reports bias (positive = Claude scores
   * higher), the error on each criterion and by Claude's confidence, and two
   * free baselines to compare with, each worked out without the judged game.
   */
  predictionAccuracy() {
    const settings = this.getSettings();
    const games = this.db.prepare("SELECT * FROM games").all().map((row) => {
      const game = toGame(row);
      return { game, scoredAt: row.scored_at, tablescore: finalScore(game.scores, settings) };
    });
    const withScore = games.filter((g) => g.tablescore != null);
    // A prediction is taken by game id only when it names no other BGG game, so
    // one left on a reused id by a deleted BGG game can't pair with this one.
    const latestBefore = this.db.prepare(
      `SELECT * FROM predictions WHERE status = 'done' AND created_at < ?
         AND (bgg_id = ? OR (game_id = ? AND bgg_id IS NULL))
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const pairs = [];
    for (const { game, scoredAt, tablescore: actual } of games) {
      if (!scoredAt || actual == null) continue;
      const before = latestBefore.get(scoredAt, game.bggId, game.id);
      if (!before) continue;
      const p = toPrediction(before, settings);
      if (p.final == null) continue;
      const others = withScore.filter((g) => g.game.id !== game.id);
      pairs.push({
        gameId: game.id,
        name: game.name,
        predictionId: p.id,
        predicted: p.final,
        actual,
        error: round1(p.final - actual),
        confidence: p.confidence,
        criteria: Object.fromEntries(CRITERIA.map((c) => [c.key, round1(p.scores[c.key] - game.scores[c.key])])),
        baselines: { mean: meanBaseline(others), bggAvg: bggAvgBaseline(others, game.bggAvg) },
      });
    }
    const finalErrors = (list) => list.map((x) => x.predicted - x.actual);
    const baseline = (kind) => {
      const covered = pairs.filter((x) => x.baselines[kind] != null);
      return {
        ...summarise(covered.map((x) => x.baselines[kind] - x.actual)),
        claudeMeanAbsError: summarise(finalErrors(covered)).meanAbsError,
      };
    };
    const all = summarise(finalErrors(pairs));
    return {
      n: all.n,
      meanAbsError: all.meanAbsError,
      bias: all.bias,
      criteria: CRITERIA.map((c) => ({ key: c.key, ...summarise(pairs.map((x) => x.criteria[c.key])) })),
      byConfidence: CONFIDENCES.map((confidence) => ({
        confidence,
        ...summarise(finalErrors(pairs.filter((x) => x.confidence === confidence))),
      })),
      baselines: { mean: baseline("mean"), bggAvg: baseline("bggAvg") },
      pairs,
    };
  }

  // ---------- recommendations ----------

  createRecommendationRun({ model, trigger = "schedule", startedAt = null }) {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO recommendation_runs (model, trigger, started_at) VALUES (?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))")
      .run(model, trigger, startedAt);
    return this.getRecommendationRun(Number(lastInsertRowid));
  }

  /** Record a nominee. `dropped` says why it isn't shown; `rank` is its place when it is. */
  addRecommendation(runId, r) {
    this.db
      .prepare(
        `INSERT INTO recommendations (run_id, bgg_id, name, year, type, thumbnail, reason, prediction_id, rank, dropped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, r.bggId ?? null, r.name, r.year ?? null, r.type || "Base", r.thumbnail ?? null, r.reason || "", r.predictionId ?? null, r.rank ?? null, r.dropped ?? null);
  }

  finishRecommendationRun(id, { usage, predicted, reused }) {
    this.db
      .prepare("UPDATE recommendation_runs SET status = 'done', usage = ?, predicted = ?, reused = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(JSON.stringify(usage ?? null), predicted, reused, id);
    return this.getRecommendationRun(id);
  }

  failRecommendationRun(id, error, { usage = null, predicted = 0, reused = 0 } = {}) {
    this.db
      .prepare("UPDATE recommendation_runs SET status = 'failed', error = ?, usage = ?, predicted = ?, reused = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(error, JSON.stringify(usage), predicted, reused, id);
    return this.getRecommendationRun(id);
  }

  /** On startup: a run still going was cut off by a restart. */
  failRunningRecommendationRuns() {
    return this.db
      .prepare("UPDATE recommendation_runs SET status = 'failed', error = 'The server restarted before it finished.', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'")
      .run().changes;
  }

  getRecommendationRun(id) {
    const row = this.db.prepare("SELECT * FROM recommendation_runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  /** Every run, newest first, with its nominees. */
  listRecommendationRuns(limit = 50) {
    return this.db
      .prepare("SELECT * FROM recommendation_runs ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ ...toRun(r), nominees: this.runNominees(r.id) }));
  }

  runNominees(runId) {
    return this.db
      .prepare("SELECT * FROM recommendations WHERE run_id = ? ORDER BY rank IS NULL, rank, id")
      .all(runId)
      .map(toRecommendation);
  }

  /** The newest finished run, or null. */
  lastRecommendationRun(status = "done") {
    const row = this.db
      .prepare("SELECT * FROM recommendation_runs WHERE status = ? ORDER BY finished_at DESC, id DESC LIMIT 1")
      .get(status);
    return row ? toRun(row) : null;
  }

  /**
   * The picks to show: the newest finished run's ranked nominees, with their
   * predictions, minus games since added to the list or dismissed.
   */
  currentRecommendations() {
    const run = this.lastRecommendationRun();
    if (!run) return { run: null, picks: [] };
    const settings = this.getSettings();
    const inList = new Set(this.db.prepare("SELECT bgg_id FROM games WHERE bgg_id IS NOT NULL").all().map((r) => r.bgg_id));
    const dismissed = new Set(this.db.prepare("SELECT bgg_id FROM dismissed_games").all().map((r) => r.bgg_id));
    const picks = this.db
      .prepare(
        `SELECT r.*, p.id AS p_id, p.confidence AS p_confidence, p.thumbnail AS p_thumbnail, p.created_at AS p_created_at,
                ${SCORE_COLS.map((c) => `p.${c} AS p_${c}`).join(", ")}
         FROM recommendations r LEFT JOIN predictions p ON p.id = r.prediction_id
         WHERE r.run_id = ? AND r.rank IS NOT NULL ORDER BY r.rank`,
      )
      .all(run.id)
      .filter((r) => !inList.has(r.bgg_id) && !dismissed.has(r.bgg_id))
      .map((r) => ({
        ...toRecommendation(r),
        thumbnail: r.thumbnail ?? r.p_thumbnail,
        final: r.p_id ? finalScore(Object.fromEntries(CRITERIA.map((c) => [c.key, r[`p_s_${c.key}`]])), settings) : null,
        confidence: r.p_confidence ?? null,
        predictedAt: r.p_created_at ?? null,
      }));
    return { run, picks };
  }

  /** Games shown in the newest `runs` finished runs, for the nominator to steer away from. */
  recentRecommendations(runs = 3) {
    return this.db
      .prepare(
        `SELECT DISTINCT r.bgg_id, r.name FROM recommendations r
         JOIN (SELECT id FROM recommendation_runs WHERE status = 'done' ORDER BY finished_at DESC, id DESC LIMIT ?) x ON x.id = r.run_id
         WHERE r.rank IS NOT NULL ORDER BY r.name COLLATE NOCASE`,
      )
      .all(runs)
      .map((r) => ({ bggId: r.bgg_id, name: r.name }));
  }

  /** The newest finished prediction for a BGG ID made after `since` (an ISO time), or null. */
  recentPrediction(bggId, since) {
    const row = this.db
      .prepare("SELECT * FROM predictions WHERE bgg_id = ? AND status = 'done' AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(bggId, since);
    return row ? toPrediction(row, this.getSettings()) : null;
  }

  dismissGame(bggId, name) {
    this.db
      .prepare("INSERT INTO dismissed_games (bgg_id, name) VALUES (?, ?) ON CONFLICT(bgg_id) DO UPDATE SET name = excluded.name")
      .run(bggId, name);
    return this.listDismissed();
  }

  undismissGame(bggId) {
    this.db.prepare("DELETE FROM dismissed_games WHERE bgg_id = ?").run(bggId);
    return this.listDismissed();
  }

  listDismissed() {
    return this.db
      .prepare("SELECT * FROM dismissed_games ORDER BY dismissed_at DESC")
      .all()
      .map((r) => ({ bggId: r.bgg_id, name: r.name, dismissedAt: r.dismissed_at }));
  }

  isDismissed(bggId) {
    return !!this.db.prepare("SELECT 1 FROM dismissed_games WHERE bgg_id = ?").get(bggId);
  }

  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Daily snapshot into dir, keeping the newest `keep` files. */
  backup(dir, keep = 14, now = new Date()) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `tablescore-${now.toISOString().slice(0, 10)}.db`);
    rmSync(file, { force: true });
    this.db.prepare("VACUUM INTO ?").run(file);
    const old = readdirSync(dir)
      .filter((f) => /^tablescore-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of old) rmSync(join(dir, f));
    return file;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toSql(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v ?? null;
}

function toGame(r) {
  return {
    id: r.id,
    bggId: r.bgg_id,
    name: r.name,
    type: r.type,
    status: r.status,
    plays: r.plays,
    oldRating: r.old_rating,
    bggRating: r.bgg_rating,
    bggAvg: r.bgg_avg,
    calibration: !!r.calibration,
    avoidTheme: !!r.avoid_theme,
    wontScore: !!r.wont_score,
    notes: r.notes,
    year: r.year,
    minPlayers: r.min_players,
    maxPlayers: r.max_players,
    bestPlayers: r.best_players,
    playTime: r.play_time,
    bggWeight: r.bgg_weight,
    image: r.image,
    thumbnail: r.thumbnail,
    ...Object.fromEntries(Object.entries(WATCH_FIELDS).map(([k, [col]]) => [k, r[col]])),
    scores: Object.fromEntries(CRITERIA.map((c) => [c.key, r[`s_${c.key}`]])),
    scoredAt: r.scored_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r) {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    error: r.error,
    model: r.model,
    usage: r.usage ? JSON.parse(r.usage) : null,
    predicted: r.predicted,
    reused: r.reused,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function toRecommendation(r) {
  return {
    id: r.id,
    runId: r.run_id,
    bggId: r.bgg_id,
    name: r.name,
    year: r.year,
    type: r.type,
    thumbnail: r.thumbnail,
    reason: r.reason,
    predictionId: r.prediction_id,
    rank: r.rank,
    dropped: r.dropped,
  };
}

// ---------- prediction accuracy ----------

const CONFIDENCES = ["high", "medium", "low"];
/** The BGG average baseline needs at least this many other games to fit its line. */
const BASELINE_MIN_GAMES = 10;

const round1 = (x) => Math.round(x * 10) / 10 || 0; // `|| 0` turns -0 into 0
const round2 = (x) => Math.round(x * 100) / 100 || 0;

/** Mean absolute and mean signed error, to two decimals; null means when there are none. */
function summarise(errors) {
  const n = errors.length;
  if (!n) return { n, meanAbsError: null, bias: null };
  return {
    n,
    meanAbsError: round2(errors.reduce((t, e) => t + Math.abs(e), 0) / n),
    bias: round2(errors.reduce((t, e) => t + e, 0) / n),
  };
}

/** Guessing the mean Tablescore of the other games every time. */
function meanBaseline(others) {
  if (!others.length) return null;
  return round1(others.reduce((t, g) => t + g.tablescore, 0) / others.length);
}

/** A least-squares line from BGG average to Tablescore over the other games, read at this game's BGG average. */
function bggAvgBaseline(others, bggAvg) {
  if (bggAvg == null) return null;
  const line = fitLine(others.filter((g) => g.game.bggAvg != null).map((g) => [g.game.bggAvg, g.tablescore]));
  if (!line) return null;
  return round1(Math.max(0, Math.min(10, line.a + line.b * bggAvg)));
}

/** Tablescore = a + b × x, or null with too few points or every x the same. */
function fitLine(points) {
  if (points.length < BASELINE_MIN_GAMES) return null;
  const mx = points.reduce((t, [x]) => t + x, 0) / points.length;
  const my = points.reduce((t, [, y]) => t + y, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** The final score is worked out with the current weights, like a game's. */
function toPrediction(r, settings) {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c.key, r[`s_${c.key}`]]));
  return {
    id: r.id,
    bggId: r.bgg_id,
    gameId: r.game_id,
    name: r.name,
    status: r.status,
    error: r.error,
    model: r.model,
    scoredGames: r.scored_games,
    scores,
    final: r.status === "done" ? finalScore(scores, settings) : null,
    confidence: r.confidence,
    avoidTheme: !!r.avoid_theme,
    avoidThemeReason: r.avoid_theme_reason,
    rationale: r.rationale,
    twoPlayer: r.two_player,
    sources: JSON.parse(r.sources),
    usage: r.usage ? JSON.parse(r.usage) : null,
    thumbnail: r.thumbnail,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}
