// SQLite storage. One file holds every game, its rubric scores and the settings.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CRITERIA, DEFAULT_SETTINGS } from "../public/js/rubric.js";
import { PLATFORMS, STAGE_KEYS } from "../public/js/watchlist.js";

const SCORE_COLS = CRITERIA.map((c) => `s_${c.key}`);

// Editable through the API. Everything BGG owns is written only by sync.
const USER_FIELDS = {
  name: "name",
  type: "type",
  status: "status",
  plays: "plays",
  avoidTheme: "avoid_theme",
  calibration: "calibration",
  notes: "notes",
  bestPlayers: "best_players",
};

// Watch fields, also user-editable, with their column types. Added to existing
// databases by migrate(); BGG sync never writes them.
const WATCH_FIELDS = {
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
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const WATCH_RULES = {
  watchStage: [(v) => STAGE_KEYS.includes(v), `watchStage must be one of ${STAGE_KEYS.join(", ")} or null`],
  campaignUrl: [(v) => typeof v === "string" && /^https?:\/\/\S+$/.test(v), "campaignUrl must be an http(s) URL or null"],
  platform: [(v) => PLATFORMS.some((p) => p.key === v), `platform must be one of ${PLATFORMS.map((p) => p.key).join(", ")} or null`],
  campaignEnd: [(v) => typeof v === "string" && isDate(v), "campaignEnd must be a date like 2026-10-30 or null"],
  deliveryEst: [(v) => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v), "deliveryEst must be a month like 2027-09 or null"],
  predictedScore: [(v) => typeof v === "number" && v >= 0 && v <= 10, "predictedScore must be 0-10 or null"],
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
  `);
  migrate(db);
  return new Store(db);
}

/** Add any missing watch columns. Safe to repeat; existing rows get nulls. */
function migrate(db) {
  const have = new Set(db.prepare("PRAGMA table_info(games)").all().map((c) => c.name));
  for (const [col, type] of Object.values(WATCH_FIELDS)) {
    if (!have.has(col)) db.exec(`ALTER TABLE games ADD COLUMN ${col} ${type}`);
  }
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
    for (const key of ["weights", "stretch", "hideExpansions", "includeWatching"]) {
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
    updatedAt: r.updated_at,
  };
}
