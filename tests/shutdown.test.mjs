import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.js";
import { BggClient } from "../server/bgg.js";
import { createApp } from "../server/app.js";
import { createShutdown } from "../server/shutdown.js";

const SEARCH = `<?xml version="1.0" encoding="utf-8"?>
<items total="1"><item type="boardgame" id="13"><name type="primary" value="Catan"/><yearpublished value="1995"/></item></items>`;

const tempDb = () => join(mkdtempSync(join(tmpdir(), "tablescore-shutdown-")), "tablescore.db");
const quiet = { log() {}, error() {} };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** A BGG client whose every request waits for `release()`. */
function gatedBgg() {
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchImpl = async () => {
    await gate;
    return new Response(SEARCH, { status: 200 });
  };
  return { bgg: new BggClient({ token: "tok", fetchImpl, spacingMs: 0, retryMs: 0, sleep: async () => {} }), release };
}

async function startApp({ file = tempDb(), bgg = new BggClient({}), graceMs, timers = [] } = {}) {
  const store = openDb(file);
  const app = createApp({ store, bgg, bggUsername: "tester" });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const exits = [];
  const shutdown = createShutdown({ server, scheduler: app.scheduler, store, timers, graceMs, exit: (code) => exits.push(code), log: quiet });
  return { file, store, app, server, base, exits, shutdown };
}

async function until(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}

test("Store.close() leaves the database as one file", () => {
  const file = tempDb();
  const store = openDb(file);
  store.createGame({ name: "Catan" });
  assert.ok(existsSync(`${file}-wal`));
  store.close();
  assert.ok(!existsSync(`${file}-wal`));
  assert.ok(!existsSync(`${file}-shm`));
  const again = openDb(file);
  try {
    assert.deepEqual(again.listGames().map((g) => g.name), ["Catan"]);
  } finally {
    again.close();
  }
});

test("an idle shutdown stops the timers, closes the store and the port, and exits 0", async () => {
  let fired = 0;
  const backupTimer = setInterval(() => fired++, 5);
  const { store, app, base, exits, shutdown } = await startApp({ timers: [backupTimer] });
  app.scheduler.start();
  shutdown("SIGTERM");
  await until(() => exits.length > 0);
  assert.deepEqual(exits, [0]);
  assert.equal(app.scheduler.timer, null);
  const before = fired;
  await tick(30);
  assert.equal(fired, before);
  assert.throws(() => store.listGames());
  await assert.rejects(fetch(base + "/api/games"));
});

test("a request in flight finishes before the exit", async () => {
  const { bgg, release } = gatedBgg();
  const { base, exits, shutdown } = await startApp({ bgg });
  const pending = fetch(base + "/api/bgg/search?q=catan");
  await tick(50);
  shutdown("SIGTERM");
  await tick(50);
  assert.deepEqual(exits, []);
  release();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal((await res.json())[0].name, "Catan");
  await until(() => exits.length > 0);
  assert.deepEqual(exits, [0]);
});

test("a stuck request is cut off at the grace limit", async () => {
  const { bgg } = gatedBgg();
  const { store, base, exits, shutdown } = await startApp({ bgg, graceMs: 50 });
  const pending = fetch(base + "/api/bgg/search?q=catan");
  await tick(50);
  shutdown("SIGTERM");
  await assert.rejects(pending);
  await until(() => exits.length > 0);
  assert.deepEqual(exits, [0]);
  assert.throws(() => store.listGames());
});

test("a running prediction and Run are marked failed on shutdown", async () => {
  const { file, store, exits, shutdown } = await startApp();
  const pred = store.createPrediction({ name: "Catan", model: "m" });
  const run = store.createRecommendationRun({ model: "m" });
  shutdown("SIGTERM");
  await until(() => exits.length > 0);
  const again = openDb(file);
  try {
    assert.equal(again.getPrediction(pred.id).status, "failed");
    assert.match(again.getPrediction(pred.id).error, /restarted/);
    assert.equal(again.getRecommendationRun(run.id).status, "failed");
    assert.match(again.getRecommendationRun(run.id).error, /restarted/);
  } finally {
    again.close();
  }
});

test("a second signal does not shut down twice", async () => {
  const { exits, shutdown } = await startApp();
  shutdown("SIGTERM");
  shutdown("SIGINT");
  await until(() => exits.length > 0);
  await tick(30);
  assert.deepEqual(exits, [0]);
});

test("the server exits 0 on SIGTERM and leaves no WAL file", { timeout: 10000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tablescore-sigterm-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir, PORT: "0", HOST: "127.0.0.1", ANTHROPIC_API_KEY: "", BGG_TOKEN: "", BACKUP_KEEP: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let out = "";
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("Tablescore listening")) resolve();
      });
      child.on("exit", () => reject(new Error(`server exited early: ${out}`)));
    });
    const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
    child.kill("SIGTERM");
    const result = await Promise.race([exited, tick(3000).then(() => "timeout")]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(existsSync(join(dataDir, "tablescore.db")));
    assert.deepEqual(readdirSync(dataDir).filter((f) => /-(wal|shm)$/.test(f)), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
