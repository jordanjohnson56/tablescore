// Putting a snapshot back: npm run restore. Every test works in its own temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../server/db.js";
import { checkSnapshot, listSnapshots, resolveSnapshot, restoreSnapshot } from "../server/restore.js";

const REPO = join(import.meta.dirname, "..");
const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const SCORES = { desire: 8, table: 7, depth: 6, interaction: 5, replay: 7, art: 6, theme: 8 };

const tempDataDir = () => mkdtempSync(join(tmpdir(), "ts-restore-"));
const liveFile = (dataDir) => join(dataDir, "tablescore.db");
const names = (store) => store.listGames().map((g) => g.name).sort();

// Open a database, read from it and close it again, so no handle is left behind.
function read(file, fn) {
  const store = openDb(file);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function integrity(file) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]).join("\n");
  } finally {
    db.close();
  }
}

// What a server killed mid-run leaves: run fn against the live database in a child
// process, then SIGKILL it before it can close, so -wal and -shm stay behind.
function runAndKill(dataDir, body) {
  const code = `
    import { openDb } from ${JSON.stringify(join(REPO, "server/db.js"))};
    const store = openDb(${JSON.stringify(liveFile(dataDir))});
    const backups = ${JSON.stringify(join(dataDir, "backups"))};
    ${body}
    process.kill(process.pid, "SIGKILL");
  `;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(r.signal, "SIGKILL", r.stderr);
}

// The games table as it was before the watchlist, holding one scored game.
function writeOldDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY, bgg_id INTEGER UNIQUE, name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Base', status TEXT NOT NULL DEFAULT '', plays INTEGER NOT NULL DEFAULT 0,
      old_rating REAL, bgg_rating REAL, bgg_avg REAL,
      calibration INTEGER NOT NULL DEFAULT 0, avoid_theme INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
      year INTEGER, min_players INTEGER, max_players INTEGER, best_players TEXT NOT NULL DEFAULT '',
      play_time INTEGER, bgg_weight REAL, image TEXT, thumbnail TEXT,
      s_desire REAL, s_table REAL, s_depth REAL, s_interaction REAL, s_replay REAL, s_art REAL, s_theme REAL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO games (bgg_id, name, status, plays, notes, s_desire, s_table, s_theme)
      VALUES (13, 'Catan', 'Owned', 9, 'classic', 8, 6.5, 5);
  `);
  db.close();
}

// A data folder with game A (weights changed) in the 2026-01-01 snapshot, and
// game B added to the live database after it. Returns the snapshot's path.
function seed(dataDir) {
  const store = openDb(liveFile(dataDir));
  store.createGame({ name: "A" });
  store.setSettings({ weights: { ...store.getSettings().weights, desire: 3 } });
  const snapshot = store.backup(join(dataDir, "backups"), 14, day(2026, 1, 1));
  store.createGame({ name: "B" });
  store.close();
  return snapshot;
}

test("a restore puts a snapshot back and keeps what it replaced", () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  const snapshotBytes = readFileSync(snapshot);

  const now = new Date("2026-03-04T05:06:07.890Z");
  const result = restoreSnapshot({ dataDir, snapshot, now });

  assert.equal(result.snapshot, snapshot);
  assert.equal(result.replacedDir, join(dataDir, "replaced", "2026-03-04T05-06-07.890Z"));
  assert.deepEqual(result.replaced, ["tablescore.db"]);
  assert.equal(result.counts.games, 1);
  read(liveFile(dataDir), (store) => {
    assert.deepEqual(names(store), ["A"]);
    assert.equal(store.getSettings().weights.desire, 3);
  });
  assert.deepEqual(read(join(result.replacedDir, "tablescore.db"), names), ["A", "B"]);
  assert.deepEqual(readFileSync(snapshot), snapshotBytes);
  assert.deepEqual(readdirSync(join(dataDir, "backups")), ["tablescore-2026-01-01.db"]);
  assert.deepEqual(readdirSync(dataDir).sort(), ["backups", "replaced", "tablescore.db"]);
});

test("a stale -wal from a killed server is moved aside, not paired with the snapshot", () => {
  const dataDir = tempDataDir();
  // Enough deleted rows that VACUUM INTO lays the snapshot's pages out differently
  // from the live file, and a checkpoint so the -wal holds only a few later pages.
  runAndKill(dataDir, `
    for (let i = 0; i < 300; i++) store.createGame({ name: "G" + String(i).padStart(3, "0"), notes: "x".repeat(1500) });
    for (let id = 1; id <= 300; id += 2) store.deleteGame(id);
    store.backup(backups, 14, new Date(Date.UTC(2026, 0, 1)));
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (let id = 2; id <= 300; id += 20) store.updateGame(id, { notes: "after the snapshot" });
    store.createGame({ name: "After" });
  `);
  assert.ok(existsSync(liveFile(dataDir) + "-wal"), "a killed server leaves its -wal behind");
  assert.ok(existsSync(liveFile(dataDir) + "-shm"), "a killed server leaves its -shm behind");
  const snapshot = join(dataDir, "backups", "tablescore-2026-01-01.db");
  const snapshotGames = read(snapshot, names);
  assert.equal(snapshotGames.length, 150);

  // The hazard itself: copying the snapshot over tablescore.db beside that -wal.
  const naive = tempDataDir();
  cpSync(dataDir, naive, { recursive: true });
  cpSync(snapshot, liveFile(naive));
  assert.notEqual(integrity(liveFile(naive)), "ok", "the snapshot plus the stale -wal is a corrupt database");

  const result = restoreSnapshot({ dataDir, snapshot });
  assert.equal(integrity(liveFile(dataDir)), "ok");
  assert.deepEqual(read(liveFile(dataDir), names), snapshotGames);
  assert.deepEqual(readdirSync(dataDir).sort(), ["backups", "replaced", "tablescore.db"]);
  // The replaced database still has everything, including the edits that were only in its -wal.
  const old = join(result.replacedDir, "tablescore.db");
  assert.equal(integrity(old), "ok");
  read(old, (store) => {
    assert.ok(names(store).includes("After"));
    assert.equal(store.getGame(2).notes, "after the snapshot");
  });
});

test("sidecars with no database at all are moved aside", () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  const keep = join(tempDataDir(), "snap.db");
  cpSync(snapshot, keep);
  const empty = tempDataDir();
  writeFileSync(liveFile(empty) + "-wal", "junk");
  writeFileSync(liveFile(empty) + "-shm", "junk");
  const result = restoreSnapshot({ dataDir: empty, snapshot: keep });
  assert.deepEqual(result.replaced.sort(), ["tablescore.db-shm", "tablescore.db-wal"]);
  assert.deepEqual(read(liveFile(empty), names), ["A"]);
  assert.deepEqual(readdirSync(empty).sort(), ["replaced", "tablescore.db"]);
});

test("bad input is refused with a clear message and nothing on disk changes", () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  const other = tempDataDir();
  const live = liveFile(dataDir);
  const half = join(other, "half.db");
  const big = openDb(join(other, "big.db"));
  for (let i = 0; i < 200; i++) big.createGame({ name: `G${i}`, notes: "x".repeat(500) });
  const bigSnapshot = big.backup(join(other, "bk"), 14, day(2026, 1, 1));
  big.close();
  const bytes = readFileSync(bigSnapshot);
  writeFileSync(half, bytes.subarray(0, bytes.length / 2));
  const text = join(other, "notes.txt");
  writeFileSync(text, "these are not scores\n".repeat(200));
  const empty = join(other, "empty.db");
  writeFileSync(empty, "");
  const foreign = join(other, "foreign.db");
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE stuff (x)");
  db.close();
  // A file that opens but fails its integrity check: the games index emptied.
  const damaged = join(other, "damaged.db");
  cpSync(snapshot, damaged);
  const page = read(damaged, (s) => s.db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'sqlite_autoindex_games_1'").get().rootpage);
  const damagedBytes = readFileSync(damaged);
  const pageSize = damagedBytes.readUInt16BE(16);
  const at = (page - 1) * pageSize;
  damagedBytes.fill(0, at, at + pageSize);
  damagedBytes[at] = 0x0a; // an empty index leaf page
  damagedBytes.writeUInt16BE(pageSize, at + 5);
  writeFileSync(damaged, damagedBytes);
  const withWal = join(other, "with-wal.db");
  cpSync(snapshot, withWal);
  writeFileSync(withWal + "-wal", "edits that are not in the file");

  const cases = [
    [join(other, "missing.db"), /No file at/],
    [other, /is a folder, not a snapshot/],
    [text, /not a Tablescore snapshot/],
    [empty, /not a Tablescore snapshot/],
    [half, /not a Tablescore snapshot/],
    [foreign, /not a Tablescore snapshot: it has no games table/],
    [damaged, /not a Tablescore snapshot: its integrity check failed \(.*missing from index/],
    [live, /is the live database/],
    [join(dataDir, ".", "backups", "..", "tablescore.db"), /is the live database/],
    [withWal, /-wal/],
  ];
  const before = readFileSync(live);
  const listing = readdirSync(dataDir).sort();
  for (const [file, message] of cases) {
    assert.throws(() => restoreSnapshot({ dataDir, snapshot: file }), message, file);
    assert.throws(() => checkSnapshot(dataDir, file), message, file);
    assert.deepEqual(readFileSync(live), before, file);
    assert.deepEqual(readdirSync(dataDir).sort(), listing, file);
  }
  assert.deepEqual(listing, ["backups", "tablescore.db"]);
});

test("a restore onto an empty data folder replaces nothing", () => {
  const source = tempDataDir();
  const snapshot = seed(source);
  const dataDir = tempDataDir();
  const result = restoreSnapshot({ dataDir, snapshot });
  assert.equal(result.replacedDir, null);
  assert.deepEqual(result.replaced, []);
  assert.deepEqual(readdirSync(dataDir), ["tablescore.db"]);
  assert.deepEqual(read(liveFile(dataDir), names), ["A"]);
});

test("a current database that SQLite cannot read is moved aside and replaced", () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  writeFileSync(liveFile(dataDir), "the disk ate this".repeat(500));
  const junk = readFileSync(liveFile(dataDir));
  const result = restoreSnapshot({ dataDir, snapshot });
  assert.deepEqual(read(liveFile(dataDir), names), ["A"]);
  assert.deepEqual(readFileSync(join(result.replacedDir, "tablescore.db")), junk);
});

test("an old snapshot is migrated when it is restored", () => {
  const source = tempDataDir();
  const snapshot = join(source, "old.db");
  writeOldDb(snapshot);
  const dataDir = tempDataDir();
  restoreSnapshot({ dataDir, snapshot });
  const db = new DatabaseSync(liveFile(dataDir));
  const cols = db.prepare("PRAGMA table_info(games)").all().map((c) => c.name);
  db.close();
  assert.ok(cols.includes("watch_stage") && cols.includes("wont_score") && cols.includes("scored_at"));
  const [g] = read(liveFile(dataDir), (s) => s.listGames());
  assert.equal(g.name, "Catan");
  assert.equal(g.notes, "classic");
  assert.equal(g.watchStage, null);
  assert.equal(g.targetPrice, null);
  assert.equal(g.wontScore, false);
});

test("a snapshot carries the predictions, Runs and Not interested list that Export JSON leaves out", () => {
  const dataDir = tempDataDir();
  const store = openDb(liveFile(dataDir));
  const a = store.createGame({ name: "A" });
  store.updateGame(a.id, { scores: SCORES });
  store.createGame({ name: "Watched", watchStage: "campaign" });
  const p = store.createPrediction({ bggId: 42, name: "Predicted", model: "m" });
  store.finishPrediction(p.id, {
    name: "Predicted", scoredGames: 1, scores: SCORES, confidence: "high",
    avoidTheme: false, avoidThemeReason: "", rationale: "", twoPlayer: "", sources: [],
  });
  const run = store.createRecommendationRun({ model: "m", trigger: "manual" });
  store.addRecommendation(run.id, { bggId: 42, name: "Predicted", reason: "fits", predictionId: p.id, rank: 1 });
  store.finishRecommendationRun(run.id, { usage: null, predicted: 1, reused: 0 });
  store.dismissGame(77, "Nope");
  const snapshot = store.backup(join(dataDir, "backups"), 14, day(2026, 1, 1));
  store.db.exec("DELETE FROM predictions; DELETE FROM recommendations; DELETE FROM recommendation_runs; DELETE FROM dismissed_games");
  store.close();

  const { counts } = restoreSnapshot({ dataDir, snapshot });
  assert.deepEqual(counts, { games: 2, scored: 1, watched: 1, predictions: 1, runs: 1, notInterested: 1 });
  read(liveFile(dataDir), (s) => {
    assert.deepEqual(s.latestPredictions().map((x) => x.name), ["Predicted"]);
    assert.equal(s.listRecommendationRuns().length, 1);
    assert.deepEqual(s.runNominees(run.id).map((x) => x.name), ["Predicted"]);
    assert.deepEqual(s.listDismissed().map((x) => x.name), ["Nope"]);
  });
});

test("--check reports a snapshot's counts and leaves the live database alone, even while it is open", () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  const store = openDb(liveFile(dataDir));
  try {
    const before = readdirSync(dataDir).sort();
    const bytes = readFileSync(liveFile(dataDir));
    const result = checkSnapshot(dataDir, "2026-01-01");
    assert.equal(result.snapshot, snapshot);
    assert.deepEqual(result.counts, { games: 1, scored: 0, watched: 0, predictions: 0, runs: 0, notInterested: 0 });
    assert.deepEqual(readFileSync(liveFile(dataDir)), bytes);
    assert.deepEqual(readdirSync(dataDir).sort(), before);
    assert.deepEqual(names(store), ["A", "B"]);
  } finally {
    store.close();
  }
});

test("a restore refuses while the database is open in this process", () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  const store = openDb(liveFile(dataDir));
  try {
    const before = readdirSync(dataDir).sort();
    assert.throws(() => restoreSnapshot({ dataDir, snapshot }), /in use.*Stop the server/s);
    assert.deepEqual(readdirSync(dataDir).sort(), before);
    assert.deepEqual(names(store), ["A", "B"]);
  } finally {
    store.close();
  }
});

test("a restore refuses while a server in another process has the database open", async () => {
  const dataDir = tempDataDir();
  const snapshot = seed(dataDir);
  const code = `
    import { openDb } from ${JSON.stringify(join(REPO, "server/db.js"))};
    const store = openDb(${JSON.stringify(liveFile(dataDir))});
    store.createGame({ name: "C" });
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code]);
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", () => reject(new Error("the child server exited early")));
    });
    const before = readdirSync(dataDir).sort();
    assert.ok(before.includes("tablescore.db-wal"));
    assert.throws(() => restoreSnapshot({ dataDir, snapshot }), /in use.*Stop the server/s);
    assert.deepEqual(readdirSync(dataDir).sort(), before);
  } finally {
    child.kill("SIGKILL");
  }
});

test("a date names that day's snapshot in DATA_DIR/backups, and the snapshots list newest first", () => {
  const dataDir = tempDataDir();
  assert.equal(resolveSnapshot(dataDir, "2026-11-20"), join(dataDir, "backups", "tablescore-2026-11-20.db"));
  assert.equal(resolveSnapshot(dataDir, "/x/y.db"), "/x/y.db");
  assert.deepEqual(listSnapshots(dataDir), []);
  mkdirSync(join(dataDir, "backups"));
  for (const f of ["tablescore-2026-01-02.db", "tablescore-2026-01-10.db", "tablescore-2026-01-03.db.tmp", "notes.txt"]) {
    writeFileSync(join(dataDir, "backups", f), "");
  }
  assert.deepEqual(listSnapshots(dataDir), [
    { date: "2026-01-10", file: join(dataDir, "backups", "tablescore-2026-01-10.db") },
    { date: "2026-01-02", file: join(dataDir, "backups", "tablescore-2026-01-02.db") },
  ]);
});

test("the restore CLI lists snapshots, checks, restores and explains a failure", () => {
  const dataDir = tempDataDir();
  seed(dataDir);
  read(liveFile(dataDir), (s) => s.backup(join(dataDir, "backups"), 14, day(2026, 1, 2)));
  const cli = (...args) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "server/restore.js", ...args], {
      cwd: REPO,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
    });

  const usage = cli();
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: npm run restore -- \[--check\]/);
  assert.match(usage.stderr, /2026-01-02[\s\S]*2026-01-01/);

  const check = cli("--check", "2026-01-01");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /1 game/);
  assert.match(check.stdout, /Nothing was changed/);
  assert.deepEqual(read(liveFile(dataDir), names), ["A", "B"]);

  const bad = cli("2025-12-31");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Restore failed, nothing changed: No file at/);

  const ok = cli("2026-01-01");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Restored .*tablescore-2026-01-01\.db/);
  assert.match(ok.stdout, /replaced/);
  assert.match(ok.stdout, /Start the server/);
  assert.deepEqual(read(liveFile(dataDir), names), ["A"]);
  assert.equal(readdirSync(join(dataDir, "replaced")).length, 1);
});
