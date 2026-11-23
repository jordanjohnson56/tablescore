// Put a snapshot back as the live database. Run it with the server stopped.
// Usage: npm run restore -- [--check] <YYYY-MM-DD | /path/to/snapshot.db>
// A date names that day's snapshot in DATA_DIR/backups. --check only verifies the
// snapshot and prints what it holds; it changes nothing and is safe while the server runs.
//
// The live database can be three files: tablescore.db plus the -wal and -shm a
// server leaves when it is killed. SQLite reads a -wal into whatever tablescore.db
// sits beside it, so a snapshot copied in next to a stale -wal comes back as the
// old data or as a corrupt file. A restore therefore moves all three aside together,
// into DATA_DIR/replaced/<time>/, and never deletes them.
import { DatabaseSync } from "node:sqlite";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CRITERIA } from "../public/js/rubric.js";
import { SNAPSHOT_NAME, openDb, snapshotName } from "./db.js";
import { checkFile } from "./files.js";

const LIVE = "tablescore.db";
const LIVE_FILES = [LIVE, `${LIVE}-wal`, `${LIVE}-shm`];
const SIDECARS = ["-journal", "-wal", "-shm"];

/** A YYYY-MM-DD argument names that day's snapshot in dataDir/backups; anything else is a path. */
export function resolveSnapshot(dataDir, arg) {
  return /^\d{4}-\d{2}-\d{2}$/.test(arg) ? join(dataDir, "backups", snapshotName(arg)) : arg;
}

/** The daily snapshots in dataDir/backups, newest first, as { date, file }. */
export function listSnapshots(dataDir) {
  const dir = join(dataDir, "backups");
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .map((f) => f.match(SNAPSHOT_NAME))
    .filter(Boolean)
    .map((m) => ({ date: m[1], file: join(dir, m[0]) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Verify a snapshot (a date or a path) without touching the live database, and
 * count what it holds. The snapshot itself is never opened: a copy in dataDir is
 * checked and then removed. Throws with a clear message if it isn't usable.
 */
export function checkSnapshot(dataDir, arg) {
  const { snapshot, copy, counts } = prepare(dataDir, arg);
  removeWithSidecars(copy);
  return { snapshot, counts };
}

/**
 * Replace the live database with a snapshot. The snapshot is checked first, then
 * tablescore.db and any -wal and -shm are moved into dataDir/replaced/<time>/, the
 * checked copy is renamed into place and migrated. Refuses, changing nothing, if
 * the snapshot is unusable or the live database is open in another process.
 * Returns { snapshot, replacedDir, replaced, counts }; replacedDir is null when
 * there was nothing to replace.
 */
export function restoreSnapshot({ dataDir, snapshot: arg, now = new Date() }) {
  const { snapshot, copy, counts } = prepare(dataDir, arg);
  const live = join(dataDir, LIVE);
  const present = LIVE_FILES.filter((f) => existsSync(join(dataDir, f)));
  let replacedDir = null;
  const moved = [];
  try {
    ensureNotInUse(live);
    if (present.length) {
      replacedDir = join(dataDir, "replaced", now.toISOString().replace(/:/g, "-"));
      mkdirSync(join(dataDir, "replaced"), { recursive: true });
      mkdirSync(replacedDir);
      // ensureNotInUse may have folded the -wal into tablescore.db, so look again.
      for (const f of LIVE_FILES.filter((f) => existsSync(join(dataDir, f)))) {
        renameSync(join(dataDir, f), join(replacedDir, f));
        moved.push(f);
      }
    }
    renameSync(copy, live);
    fsyncPath(dataDir);
  } catch (e) {
    // Put back whatever was moved, so the data folder is exactly as it was.
    for (const f of moved) renameSync(join(replacedDir, f), join(dataDir, f));
    if (replacedDir && existsSync(replacedDir)) rmdirSync(replacedDir);
    removeWithSidecars(copy);
    throw e;
  }
  try {
    openDb(live).close(); // runs the migrations, then folds the WAL back in
  } catch (e) {
    const err = new Error(`the snapshot is in place but would not open (${e.message}). The database it replaced is in ${replacedDir}.`);
    err.changed = true;
    throw err;
  }
  return { snapshot, replacedDir, replaced: moved, counts };
}

// Check the snapshot and leave a checked copy beside the live database, on the
// same filesystem so the final rename is atomic. The caller removes the copy.
function prepare(dataDir, arg) {
  const snapshot = resolveSnapshot(dataDir, arg);
  checkFile(snapshot, "a snapshot");
  const live = join(dataDir, LIVE);
  if (sameFile(snapshot, live)) throw new Error(`${snapshot} is the live database. Name a snapshot from ${join(dataDir, "backups")} instead.`);
  if (size(`${snapshot}-wal`) > 0) {
    throw new Error(`${snapshot}-wal sits beside the snapshot and may hold edits that are not in the file itself, so restoring the file alone could lose them. Use a snapshot from ${join(dataDir, "backups")} instead.`);
  }
  mkdirSync(dataDir, { recursive: true });
  const copy = `${live}.restoring`;
  removeWithSidecars(copy);
  try {
    copyFileSync(snapshot, copy);
    const counts = inspect(copy, snapshot);
    removeSidecars(copy);
    fsyncPath(copy);
    return { snapshot, copy, counts };
  } catch (e) {
    removeWithSidecars(copy);
    throw e;
  }
}

// Open with a plain connection, not openDb, which would switch the file to WAL and migrate it.
function inspect(file, snapshot) {
  const refuse = (why) => new Error(`${snapshot} is not a Tablescore snapshot: ${why}`);
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (e) {
    throw refuse(e.message);
  }
  try {
    let result;
    try {
      result = db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
    } catch (e) {
      throw refuse(e.message);
    }
    if (result.length !== 1 || result[0] !== "ok") throw refuse(`its integrity check failed (${result.slice(0, 3).join("; ")})`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ["games", "settings"]) if (!tables.has(t)) throw refuse(`it has no ${t} table`);
    const cols = new Set(db.prepare("PRAGMA table_info(games)").all().map((c) => c.name));
    const scoreCols = CRITERIA.map((c) => `s_${c.key}`);
    const count = (table, where = "") => (tables.has(table) ? db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get().n : 0);
    return {
      games: count("games"),
      scored: scoreCols.every((c) => cols.has(c)) ? count("games", `WHERE ${scoreCols.map((c) => `${c} IS NOT NULL`).join(" AND ")}`) : 0,
      watched: cols.has("watch_stage") ? count("games", "WHERE watch_stage IS NOT NULL") : 0,
      predictions: count("predictions"),
      runs: count("recommendation_runs"),
      notInterested: count("dismissed_games"),
    };
  } finally {
    db.close();
  }
}

// Refuse if another connection has the live database open, as a running server
// does: an exclusive lock can't be had while it holds its shared lock. Works
// across processes and across containers sharing the bind mount. When the lock
// is free, closing this connection checkpoints a stale -wal into tablescore.db,
// as a clean server stop would, so the replaced database ends up as one file.
// A file SQLite can't read at all is left alone, to be moved aside as it is.
function ensureNotInUse(live) {
  if (!existsSync(live)) return;
  let db;
  try {
    db = new DatabaseSync(live, { timeout: 0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
  } catch (e) {
    const code = e.errcode & 0xff;
    if (code === 5 || code === 6) {
      throw new Error(`${live} is in use, so the server looks to be running. Stop the server (docker compose stop), then run the restore again.`);
    }
    if (code !== 11 && code !== 26) throw new Error(`could not check that the server is stopped: ${e.message}`);
  } finally {
    db?.close();
  }
}

function sameFile(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function size(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function removeSidecars(file) {
  for (const s of SIDECARS) rmSync(file + s, { force: true });
}

function removeWithSidecars(file) {
  rmSync(file, { force: true });
  removeSidecars(file);
}

function fsyncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** One line saying what a snapshot holds. */
export function describeCounts(c) {
  return [
    `${plural(c.games, "game")} (${c.scored} scored, ${c.watched} watched)`,
    plural(c.predictions, "prediction"),
    plural(c.runs, "Run"),
    `${c.notInterested} Not interested`,
  ].join(", ");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR || "data";
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const rest = args.filter((a) => a !== "--check");
  if (rest.length !== 1) {
    console.error("Usage: npm run restore -- [--check] <YYYY-MM-DD | /path/to/snapshot.db>");
    const snapshots = listSnapshots(dataDir);
    console.error(snapshots.length ? `Snapshots in ${join(dataDir, "backups")}, newest first:` : `No snapshots in ${join(dataDir, "backups")}.`);
    for (const s of snapshots) console.error(`  ${s.date}  ${s.file}`);
    process.exit(1);
  }
  if (check) {
    try {
      const { snapshot, counts } = checkSnapshot(dataDir, rest[0]);
      console.log(`Snapshot OK: ${snapshot}`);
      console.log(`  ${describeCounts(counts)}`);
      console.log("Nothing was changed.");
    } catch (e) {
      console.error(`Check failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    let result;
    try {
      result = restoreSnapshot({ dataDir, snapshot: rest[0] });
    } catch (e) {
      console.error(e.changed ? `Restore failed: ${e.message}` : `Restore failed, nothing changed: ${e.message}`);
      process.exit(1);
    }
    console.log(`Restored ${result.snapshot}`);
    console.log(`  ${describeCounts(result.counts)}`);
    console.log(
      result.replacedDir
        ? `The database it replaced is in ${result.replacedDir}. Delete that folder once you are happy with the restore.`
        : "There was no database to replace.",
    );
    console.log("Start the server: docker compose up -d, or npm start without Docker.");
  }
}
