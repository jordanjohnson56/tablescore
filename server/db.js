// SQLite storage. One file holds every game, its rubric scores and the settings.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CRITERIA, DEFAULT_SETTINGS, finalScore } from "../public/js/rubric.js";
import { PLATFORMS, STAGE_KEYS } from "../public/js/watchlist.js";

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
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
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
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO games (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
      .run(...Object.values(cols));
    return this.getGame(Number(lastInsertRowid));
  }

  /** Patch user-editable fields and scores. Unknown keys are rejected. */
  updateGame(id, patch) {
    const sets = [];
    const vals = [];
    const watch = checkWatchFields(patch);
    for (const [k, v] of Object.entries(patch)) {
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
      } else if (USER_FIELDS[k]) {
        if (k === "name" && !String(v).trim()) throw new HttpError(400, "name is required");
        sets.push(`${USER_FIELDS[k]} = ?`);
        vals.push(toSql(v));
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
   */
  predictionAccuracy() {
    const settings = this.getSettings();
    const pairs = [];
    for (const row of this.db.prepare("SELECT * FROM games WHERE scored_at IS NOT NULL").all()) {
      const game = toGame(row);
      const actual = finalScore(game.scores, settings);
      if (actual == null) continue;
      const before = this.db
        .prepare(
          `SELECT * FROM predictions WHERE status = 'done' AND created_at < ? AND (bgg_id = ? OR game_id = ?)
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(row.scored_at, game.bggId, game.id);
      if (!before) continue;
      const p = toPrediction(before, settings);
      pairs.push({ gameId: game.id, name: game.name, predictionId: p.id, predicted: p.final, actual, error: Math.round((p.final - actual) * 10) / 10 });
    }
    const n = pairs.length;
    const meanAbsError = n ? Math.round((pairs.reduce((t, x) => t + Math.abs(x.predicted - x.actual), 0) / n) * 100) / 100 : null;
    return { n, meanAbsError, pairs };
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
