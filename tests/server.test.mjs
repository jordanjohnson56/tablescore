import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { openDb } from "../server/db.js";
import { BggClient } from "../server/bgg.js";
import { createApp } from "../server/app.js";
import { readWorkbook, importInto } from "../server/import-xlsx.js";
import { watchlistExport, writeWatchlist } from "../server/export-watchlist.js";
import { importWatchlist, readWatchlistFile } from "../server/import-watchlist.js";

// ---------- synthetic BGG responses (shapes copied from the XML API2 docs) ----------

const COLLECTION_BASE = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<items totalitems="2" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item objecttype="thing" objectid="13" subtype="boardgame" collid="1">
    <name sortindex="1">Catan</name>
    <yearpublished>1995</yearpublished>
    <image>https://cf.geekdo-images.com/catan.jpg</image>
    <thumbnail>https://cf.geekdo-images.com/catan_t.jpg</thumbnail>
    <stats minplayers="3" maxplayers="4" minplaytime="60" maxplaytime="120" playingtime="120" numowned="1">
      <rating value="7.5"><usersrated value="1"/><average value="7.0912"/><bayesaverage value="7"/></rating>
    </stats>
    <status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" wishlist="0" preordered="0" lastmodified="2026-01-01 00:00:00"/>
    <numplays>9</numplays>
  </item>
  <item objecttype="thing" objectid="999" subtype="boardgame" collid="2">
    <name sortindex="5">The Test &amp; Game&#039;s Return</name>
    <yearpublished>2024</yearpublished>
    <stats minplayers="1" maxplayers="5" playingtime="90" numowned="1">
      <rating value="N/A"><average value="7.5"/></rating>
    </stats>
    <status own="0" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" wishlist="1" wishlistpriority="2" preordered="0" lastmodified="2026-01-01 00:00:00"/>
    <numplays>0</numplays>
  </item>
</items>`;

const COLLECTION_EXP = `<?xml version="1.0" encoding="utf-8"?><items totalitems="0"></items>`;

const thingXml = (id, name, best = "3") => `<?xml version="1.0" encoding="utf-8"?>
<items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgame" id="${id}">
    <thumbnail>https://cf.geekdo-images.com/${id}_t.jpg</thumbnail>
    <image>https://cf.geekdo-images.com/${id}.jpg</image>
    <name type="primary" sortindex="1" value="${name}"/>
    <name type="alternate" sortindex="1" value="Alt ${name}"/>
    <yearpublished value="2020"/>
    <minplayers value="2"/><maxplayers value="4"/>
    <poll name="suggested_numplayers" title="User Suggested Number of Players" totalvotes="10">
      <results numplayers="2"><result value="Best" numvotes="1"/><result value="Recommended" numvotes="5"/><result value="Not Recommended" numvotes="1"/></results>
      <results numplayers="3"><result value="Best" numvotes="${best === "3" ? 8 : 0}"/><result value="Recommended" numvotes="2"/><result value="Not Recommended" numvotes="0"/></results>
      <results numplayers="4"><result value="Best" numvotes="3"/><result value="Recommended" numvotes="5"/><result value="Not Recommended" numvotes="0"/></results>
    </poll>
    <playingtime value="75"/>
    <statistics page="1"><ratings>
      <usersrated value="100"/><average value="7.81234"/><averageweight value="2.3456"/>
    </ratings></statistics>
  </item>
</items>`;

const SEARCH = `<?xml version="1.0" encoding="utf-8"?>
<items total="2" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgame" id="13"><name type="primary" value="Catan"/><yearpublished value="1995"/></item>
  <item type="boardgameexpansion" id="926"><name type="primary" value="Catan: Seafarers"/><yearpublished value="1997"/></item>
</items>`;

function fakeBgg(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const u = new URL(url);
    const key = u.pathname.split("/").pop();
    const body = routes[key](u.searchParams, calls.length);
    if (typeof body === "number") return new Response("", { status: body });
    return new Response(body, { status: 200 });
  };
  const client = new BggClient({ token: "tok", fetchImpl, spacingMs: 0, retryMs: 0, sleep: async () => {} });
  return { client, calls };
}

const defaultRoutes = () => {
  let collectionHits = 0;
  return {
    collection: (p) => {
      collectionHits++;
      if (collectionHits === 1) return 202; // BGG queues the first request
      return p.get("subtype") === "boardgameexpansion" ? COLLECTION_EXP : COLLECTION_BASE;
    },
    thing: (p) => {
      const ids = p.get("id").split(",");
      return `<items>${ids.map((id) => thingXml(id, `Game ${id}`).replace(/^[\s\S]*?<items[^>]*>|<\/items>\s*$/g, "")).join("")}</items>`;
    },
    search: () => SEARCH,
  };
};

async function startApp({ withBgg = true, file = ":memory:" } = {}) {
  const store = openDb(file);
  const { client, calls } = fakeBgg(defaultRoutes());
  const bgg = withBgg ? client : new BggClient({});
  const app = createApp({ store, bgg, bggUsername: "tester" });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { store, calls, call, close: () => (server.close(), store.db.close()) };
}

// ---------- BGG client ----------

test("collection retries the 202 queue response, sends the token, parses items", async () => {
  const { client, calls } = fakeBgg(defaultRoutes());
  const items = await client.collection("tester");
  assert.equal(calls.length, 3); // 202, base, expansions
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
  assert.deepEqual(items[0], {
    bggId: 13, name: "Catan", type: "Base", status: "Owned", plays: 9, bggRating: 7.5, bggAvg: 7.09,
    year: 1995, minPlayers: 3, maxPlayers: 4, playTime: 120,
    image: "https://cf.geekdo-images.com/catan.jpg", thumbnail: "https://cf.geekdo-images.com/catan_t.jpg",
  });
  assert.equal(items[1].name, "The Test & Game's Return");
  assert.equal(items[1].status, "Wishlist");
  assert.equal(items[1].bggRating, null);
});

test("thing parses details and best player counts", async () => {
  const { client } = fakeBgg(defaultRoutes());
  const [t] = await client.things([42]);
  assert.equal(t.name, "Game 42");
  assert.equal(t.bggWeight, 2.35);
  assert.equal(t.bggAvg, 7.81);
  assert.equal(t.bestPlayers, "3");
  assert.equal(t.playTime, 75);
});

test("things batches ids 20 at a time", async () => {
  const { client, calls } = fakeBgg(defaultRoutes());
  const out = await client.things(Array.from({ length: 45 }, (_, i) => i + 1));
  assert.equal(out.length, 45);
  assert.equal(calls.length, 3);
});

test("a missing token fails clearly without calling BGG", async () => {
  await assert.rejects(new BggClient({}).search("catan"), /BGG_TOKEN/);
});

// ---------- API ----------

test("score a game through the API and read it back", async () => {
  const t = await startApp();
  try {
    const { body: g } = await t.call("POST", "/api/games", { name: "Root" });
    const r = await t.call("PATCH", `/api/games/${g.id}`, { scores: { desire: 9, table: 4 }, plays: 4, avoidTheme: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.scores.desire, 9);
    assert.equal(r.body.scores.theme, null);
    assert.equal(r.body.avoidTheme, true);
    const { body: state } = await t.call("GET", "/api/state");
    assert.equal(state.games.length, 1);
    assert.equal(state.settings.stretch, 1.25);
  } finally {
    t.close();
  }
});

test("API rejects bad scores, BGG-owned fields and non-JSON writes", async () => {
  const t = await startApp();
  try {
    const { body: g } = await t.call("POST", "/api/games", { name: "X" });
    assert.equal((await t.call("PATCH", `/api/games/${g.id}`, { scores: { desire: 11 } })).status, 400);
    assert.equal((await t.call("PATCH", `/api/games/${g.id}`, { scores: { bogus: 1 } })).status, 400);
    assert.equal((await t.call("PATCH", `/api/games/${g.id}`, { bggRating: 10 })).status, 400);
    assert.equal((await t.call("PATCH", "/api/games/9999", { plays: 1 })).status, 404);
    assert.equal((await t.call("PUT", "/api/settings", { stretch: -1 })).status, 400);
  } finally {
    t.close();
  }
});

test("marking a game rated on BGG records the rating and nothing else", async () => {
  const t = await startApp();
  try {
    const g = t.store.createGame({ name: "Catan", bggId: 13, bggRating: 6, scores: { desire: 8 }, notes: "keep" });
    const r = await t.call("POST", `/api/games/${g.id}/bgg-rated`, { rating: 7.4 });
    assert.equal(r.status, 200);
    assert.equal(r.body.bggRating, 7.4);
    assert.equal(r.body.scores.desire, 8);
    assert.equal(r.body.notes, "keep");
    assert.equal((await t.call("POST", `/api/games/${g.id}/bgg-rated`, { rating: 11 })).status, 400);
    assert.equal((await t.call("POST", `/api/games/${g.id}/bgg-rated`, { rating: "7" })).status, 400);
    assert.equal((await t.call("POST", "/api/games/9999/bgg-rated", { rating: 7 })).status, 404);
    const { body: local } = await t.call("POST", "/api/games", { name: "No BGG" });
    assert.equal((await t.call("POST", `/api/games/${local.id}/bgg-rated`, { rating: 7 })).status, 400);
  } finally {
    t.close();
  }
});

test("writes without a JSON content type are refused", async () => {
  const t = await startApp();
  try {
    const { body: g } = await t.call("POST", "/api/games", { name: "X" });
    const res = await t.call("DELETE", `/api/games/${g.id}`); // no body, so no JSON content type
    assert.equal(res.status, 415);
    assert.equal(t.store.listGames().length, 1);
  } finally {
    t.close();
  }
});

test("sync adds new games, updates existing ones and leaves scores alone", async () => {
  const t = await startApp();
  try {
    t.store.createGame({ name: "Catan (my name)", bggId: 13, plays: 6, scores: { desire: 7 }, notes: "keep" });
    const start = await t.call("POST", "/api/bgg/sync", {});
    assert.equal(start.status, 202);
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await t.call("GET", "/api/bgg/sync")).body;
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(job.error, null);
    assert.deepEqual(job.result, { collection: 2, added: 1, updated: 1, enriched: 2 });
    const catan = t.store.getByBggId(13);
    assert.equal(catan.name, "Catan (my name)");
    assert.equal(catan.plays, 9);
    assert.equal(catan.bggRating, 7.5);
    assert.equal(catan.scores.desire, 7);
    assert.equal(catan.notes, "keep");
    assert.equal(catan.bggWeight, 2.35);
    assert.equal(catan.bestPlayers, "3");
    assert.equal(t.store.getByBggId(999).status, "Wishlist");
  } finally {
    t.close();
  }
});

test("add from BGG fills in details and is idempotent", async () => {
  const t = await startApp();
  try {
    const a = await t.call("POST", "/api/games/from-bgg", { bggId: 266192 });
    assert.equal(a.status, 201);
    assert.equal(a.body.name, "Game 266192");
    assert.equal(a.body.bggWeight, 2.35);
    const b = await t.call("POST", "/api/games/from-bgg", { bggId: 266192 });
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id);
    const s = await t.call("GET", "/api/bgg/search?q=catan");
    assert.equal(s.body.length, 2);
    assert.equal(s.body[1].type, "Expansion");
  } finally {
    t.close();
  }
});

test("BGG endpoints explain a missing token", async () => {
  const t = await startApp({ withBgg: false });
  try {
    const r = await t.call("POST", "/api/bgg/sync", {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /BGG_TOKEN/);
  } finally {
    t.close();
  }
});

// ---------- import + backups ----------

test("imports the spreadsheet layout, skipping games already present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-"));
  const file = join(dir, "rubric.xlsx");
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Scores");
  s.addRow(["Game", "BGG ID", "Type", "Status in collection", "Plays", "Old Rating", "BGG Avg", "Calibration",
    "Desire to Play", "Table Appeal", "Decision Depth & Tension", "Interaction Quality",
    "Replayability & Strategic Variety", "Art & Production", "Theme & Narrative", "Avoid Theme?", "Raw Average", "New Score",
    "Change vs Old", "Provisional", "Rescore Status", "Notes"]);
  s.addRow(["Alpha", 1, "Base", "Owned", 5, 8, 7.5, "Yes", 8, 7, 6, 5, 4, 3, 2, "Yes", { formula: "1+1", result: 2 }, null, null, null, null, "note"]);
  s.addRow(["Beta", 2, "Expansion", null, 0, null, 7, null]);
  s.addRow([]);
  const w = wb.addWorksheet("Weights");
  const keys = ["Desire", "Table", "Depth", "Interaction", "Replay", "Art", "Theme"];
  const vals = [30, 20, 10, 10, 10, 10, 10];
  keys.forEach((k, i) => {
    w.getCell(4 + i, 1).value = k;
    w.getCell(4 + i, 3).value = vals[i];
  });
  w.getCell("C14").value = 1.5;
  await wb.xlsx.writeFile(file);

  const store = openDb(":memory:");
  const parsed = await readWorkbook(file);
  assert.deepEqual(importInto(store, parsed), { added: 2, replaced: 0, skipped: 0, settings: true });
  const alpha = store.getByBggId(1);
  assert.deepEqual(alpha.scores, { desire: 8, table: 7, depth: 6, interaction: 5, replay: 4, art: 3, theme: 2 });
  assert.equal(alpha.avoidTheme, true);
  assert.equal(alpha.calibration, true);
  assert.equal(alpha.oldRating, 8);
  assert.equal(alpha.bggRating, 8);
  assert.equal(alpha.notes, "note");
  assert.equal(store.getByBggId(2).type, "Expansion");
  assert.equal(store.getSettings().stretch, 1.5);
  assert.equal(store.getSettings().weights.desire, 30);

  store.updateGame(alpha.id, { scores: { desire: 1 } });
  assert.deepEqual(importInto(store, parsed), { added: 0, replaced: 0, skipped: 2, settings: true });
  assert.equal(store.getByBggId(1).scores.desire, 1);
  importInto(store, parsed, { overwrite: true });
  assert.equal(store.getByBggId(1).scores.desire, 8);
});

test("backups keep only the newest N daily files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-bk-"));
  const store = openDb(":memory:");
  store.createGame({ name: "A" });
  writeFileSync(join(dir, "unrelated.txt"), "x");
  for (let d = 1; d <= 5; d++) store.backup(dir, 3, new Date(Date.UTC(2026, 0, d)));
  assert.deepEqual(readdirSync(dir).sort(), [
    "tablescore-2026-01-03.db", "tablescore-2026-01-04.db", "tablescore-2026-01-05.db", "unrelated.txt",
  ]);
  const copy = openDb(join(dir, "tablescore-2026-01-05.db"));
  assert.equal(copy.listGames()[0].name, "A");
});

test("import explains a folder or missing path instead of crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-imp-"));
  await assert.rejects(readWorkbook(dir), /is a folder, not a spreadsheet/);
  await assert.rejects(readWorkbook(join(dir, "nope.xlsx")), /No file at/);
});

test("includeWatching setting persists and is validated", async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call("GET", "/api/state")).body.settings.includeWatching, false);
    const r = await t.call("PUT", "/api/settings", { includeWatching: true });
    assert.equal(r.body.includeWatching, true);
    assert.equal(r.body.stretch, 1.25);
    assert.equal((await t.call("PUT", "/api/settings", { includeWatching: "yes" })).status, 400);
    assert.equal((await t.call("PUT", "/api/settings", { includeWatching: 1 })).status, 400);
    assert.equal((await t.call("PUT", "/api/settings", { stretch: 1.5 })).body.includeWatching, true);
  } finally {
    t.close();
  }
});

test("hideExpansions setting persists and is validated", async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call("GET", "/api/state")).body.settings.hideExpansions, false);
    const r = await t.call("PUT", "/api/settings", { hideExpansions: true });
    assert.equal(r.body.hideExpansions, true);
    assert.equal(r.body.stretch, 1.25);
    assert.equal((await t.call("PUT", "/api/settings", { hideExpansions: "yes" })).status, 400);
    assert.equal((await t.call("PUT", "/api/settings", { stretch: 1.5 })).body.hideExpansions, true);
  } finally {
    t.close();
  }
});

// ---------- watchlist ----------

const pick = (obj, like) => Object.fromEntries(Object.keys(like).map((k) => [k, obj[k]]));

const WATCH_NULLS = {
  watchStage: null, campaignUrl: null, platform: null, campaignEnd: null,
  deliveryEst: null, predictedScore: null, targetPrice: null, targetCurrency: null,
};

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

test("an old database opens with its games intact and the watch fields present and null, twice", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ts-mig-")), "old.db");
  writeOldDb(file);
  for (let open = 1; open <= 2; open++) {
    const t = await startApp({ file });
    try {
      const { body } = await t.call("GET", "/api/state");
      assert.equal(body.games.length, 1);
      const [g] = body.games;
      assert.equal(g.name, "Catan");
      assert.equal(g.notes, "classic");
      assert.equal(g.plays, 9);
      assert.deepEqual(g.scores, { desire: 8, table: 6.5, depth: null, interaction: null, replay: null, art: null, theme: 5 });
      assert.deepEqual(pick(g, WATCH_NULLS), WATCH_NULLS);
    } finally {
      t.close();
    }
  }
});

const WATCHED = {
  watchStage: "campaign", campaignUrl: "https://www.kickstarter.com/projects/x/bookwyrm", platform: "kickstarter",
  campaignEnd: "2026-10-15", deliveryEst: "2027-09", predictedScore: 7.3, targetPrice: 45.5, targetCurrency: "EUR",
};

test("PATCH saves watch fields, and stopping watching clears only the stage", async () => {
  const t = await startApp();
  try {
    const { body: g } = await t.call("POST", "/api/games", { name: "Bookwyrm" });
    assert.deepEqual(pick(g, WATCH_NULLS), WATCH_NULLS);
    const r = await t.call("PATCH", `/api/games/${g.id}`, WATCHED);
    assert.equal(r.status, 200);
    assert.deepEqual(pick(r.body, WATCHED), WATCHED);
    const stopped = await t.call("PATCH", `/api/games/${g.id}`, { watchStage: null });
    assert.equal(stopped.body.watchStage, null);
    assert.equal(stopped.body.predictedScore, 7.3);
    assert.equal(stopped.body.campaignEnd, "2026-10-15");
  } finally {
    t.close();
  }
});

test("PATCH rejects each kind of bad watch value with a 400 and a clear message", async () => {
  const t = await startApp();
  try {
    const { body: g } = await t.call("POST", "/api/games", { name: "Bookwyrm" });
    const bad = [
      [{ watchStage: "watching" }, /watchStage/],
      [{ predictedScore: 10.5 }, /predictedScore/],
      [{ predictedScore: -1 }, /predictedScore/],
      [{ deliveryEst: "2027-13" }, /deliveryEst/],
      [{ deliveryEst: "Sept 2027" }, /deliveryEst/],
      [{ campaignEnd: "2026-02-30" }, /campaignEnd/],
      [{ campaignEnd: "30/10/2026" }, /campaignEnd/],
      [{ platform: "indiegogo" }, /platform/],
      [{ targetPrice: -5 }, /targetPrice/],
      [{ targetPrice: "40" }, /targetPrice/],
      [{ targetCurrency: "usd" }, /targetCurrency/],
      [{ targetCurrency: "EURO" }, /targetCurrency/],
      [{ campaignUrl: "javascript:alert(1)" }, /campaignUrl/],
    ];
    for (const [patch, msg] of bad) {
      const r = await t.call("PATCH", `/api/games/${g.id}`, { ...patch, notes: "should not save" });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match(r.body.error, msg);
    }
    assert.equal(t.store.getGame(g.id).notes, "");
  } finally {
    t.close();
  }
});

test("sync over a watched game on the BGG wishlist updates its status and leaves its watch fields alone", async () => {
  const t = await startApp();
  try {
    const g = t.store.createGame({ name: "The Test Game", bggId: 999, status: "" });
    await t.call("PATCH", `/api/games/${g.id}`, WATCHED);
    await t.call("POST", "/api/bgg/sync", {});
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await t.call("GET", "/api/bgg/sync")).body;
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(job.error, null);
    const after = (await t.call("GET", "/api/state")).body.games.find((x) => x.bggId === 999);
    assert.equal(after.status, "Wishlist");
    assert.deepEqual(pick(after, WATCHED), WATCHED);
  } finally {
    t.close();
  }
});

test("the full JSON export and backups include the watch fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-wbk-"));
  const t = await startApp();
  try {
    const { body: g } = await t.call("POST", "/api/games", { name: "Bookwyrm" });
    await t.call("PATCH", `/api/games/${g.id}`, WATCHED);
    const [exported] = (await t.call("GET", "/api/export")).body.games;
    assert.deepEqual(pick(exported, WATCHED), WATCHED);
    const copy = openDb(t.store.backup(dir));
    const [backedUp] = copy.listGames();
    assert.deepEqual(pick(backedUp, WATCHED), WATCHED);
  } finally {
    t.close();
  }
});

test("adding a game with a watch stage creates it Watching at that stage", async () => {
  const t = await startApp();
  try {
    const r = await t.call("POST", "/api/games", { name: "Bookwyrm", watchStage: "campaign" });
    assert.equal(r.status, 201);
    assert.equal(r.body.watchStage, "campaign");
    const [g] = (await t.call("GET", "/api/state")).body.games;
    assert.equal(g.watchStage, "campaign");
  } finally {
    t.close();
  }
});

test("adding a game with an invalid watch stage is a 400 and adds nothing", async () => {
  const t = await startApp();
  try {
    for (const [path, body] of [
      ["/api/games", { name: "Bookwyrm", watchStage: "watching" }],
      ["/api/games/from-bgg", { bggId: 266192, watchStage: "watching" }],
    ]) {
      const r = await t.call("POST", path, body);
      assert.equal(r.status, 400, path);
      assert.match(r.body.error, /watchStage/);
    }
    assert.equal(t.store.listGames().length, 0);
  } finally {
    t.close();
  }
});

test("adding from BGG with a watch stage creates a watched game with BGG details, but leaves one already in the list alone", async () => {
  const t = await startApp();
  try {
    const a = await t.call("POST", "/api/games/from-bgg", { bggId: 266192, watchStage: "campaign" });
    assert.equal(a.status, 201);
    assert.equal(a.body.watchStage, "campaign");
    assert.equal(a.body.name, "Game 266192");
    assert.equal(a.body.bggWeight, 2.35);
    assert.equal(a.body.bestPlayers, "3");

    const plain = await t.call("POST", "/api/games/from-bgg", { bggId: 13 });
    const again = await t.call("POST", "/api/games/from-bgg", { bggId: 13, watchStage: "campaign" });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, plain.body.id);
    assert.equal(again.body.watchStage, null);
    assert.equal(t.store.getGame(plain.body.id).watchStage, null);
  } finally {
    t.close();
  }
});

test("GET /api/watchlist returns only watched games in Watchlist order, with decided flags, weights, stretch and a timestamp", async () => {
  const t = await startApp();
  try {
    t.store.createGame({ name: "Catan", bggId: 13, status: "Owned" });
    t.store.createGame({ name: "Excursions", watchStage: "pass", notes: "too long" });
    t.store.createGame({ name: "Bookwyrm", ...WATCHED, watchStage: "awaiting", deliveryEst: "2027-09" });
    t.store.createGame({ name: "King's Gambit", bggId: 4242, watchStage: "awaiting", deliveryEst: "2027-03", predictedScore: 8.8, targetPrice: 60 });
    t.store.createGame({ name: "Infamous Traffic", watchStage: "campaign" });
    const weights = { desire: 30, table: 20, depth: 10, interaction: 10, replay: 10, art: 10, theme: 10 };
    await t.call("PUT", "/api/settings", { weights, stretch: 1.5 });

    const before = Date.now();
    const r = await t.call("GET", "/api/watchlist");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["exportedAt", "games", "settings"]);
    assert.ok(Date.parse(r.body.exportedAt) >= before - 1000);
    assert.deepEqual(r.body.settings, { weights, stretch: 1.5 });
    assert.deepEqual(r.body.games.map((g) => [g.name, g.decided]), [
      ["Infamous Traffic", false],
      ["King's Gambit", false],
      ["Bookwyrm", false],
      ["Excursions", true],
    ]);
    assert.deepEqual(r.body.games[1], {
      name: "King's Gambit", bggId: 4242, watchStage: "awaiting", decided: false,
      campaignUrl: null, platform: null, campaignEnd: null, deliveryEst: "2027-03",
      predictedScore: 8.8, targetPrice: 60, targetCurrency: "USD", notes: "",
    });
    assert.deepEqual(r.body.games[2], { name: "Bookwyrm", bggId: null, ...WATCHED, watchStage: "awaiting", decided: false, notes: "" });
    assert.equal(r.body.games[3].notes, "too long");
  } finally {
    t.close();
  }
});

test("the watchlist endpoint is GET only and writes nothing", async () => {
  const t = await startApp();
  try {
    t.store.createGame({ name: "Bookwyrm", watchStage: "campaign" });
    const state = (await t.call("GET", "/api/state")).body;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await t.call(method, "/api/watchlist", { games: [] });
      assert.equal(r.status, 404, method);
    }
    await t.call("GET", "/api/watchlist");
    assert.deepEqual((await t.call("GET", "/api/state")).body, state);
  } finally {
    t.close();
  }
});

test("the export-watchlist CLI's function writes the same JSON as the endpoint", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ts-wexp-")), "watchlist.json");
  const t = await startApp();
  try {
    t.store.createGame({ name: "Catan", bggId: 13 });
    t.store.createGame({ name: "Bookwyrm", ...WATCHED });
    t.store.createGame({ name: "Excursions", watchStage: "buy" });
    const returned = writeWatchlist(t.store, file);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(written, returned);
    const { body: served } = await t.call("GET", "/api/watchlist");
    assert.ok(!Number.isNaN(Date.parse(written.exportedAt)));
    assert.deepEqual({ ...written, exportedAt: null }, { ...served, exportedAt: null });
    assert.deepEqual(written.games.map((g) => g.name), ["Bookwyrm", "Excursions"]);
  } finally {
    t.close();
  }
});

test("importing watched games creates each one with every watch field and its notes, and reports it added", async () => {
  const t = await startApp();
  try {
    const result = importWatchlist(t.store, [
      { name: "Bookwyrm", bggId: 777, ...WATCHED, decided: false, notes: "art looks great" },
      { name: "Infamous Traffic", watchStage: "reviews" },
    ]);
    assert.deepEqual(result, { added: ["Bookwyrm", "Infamous Traffic"], skipped: [] });
    const { body } = await t.call("GET", "/api/state");
    const book = body.games.find((g) => g.name === "Bookwyrm");
    assert.deepEqual(pick(book, WATCHED), WATCHED);
    assert.equal(book.bggId, 777);
    assert.equal(book.notes, "art looks great");
    const traffic = body.games.find((g) => g.name === "Infamous Traffic");
    assert.deepEqual(pick(traffic, WATCH_NULLS), { ...WATCH_NULLS, watchStage: "reviews" });
  } finally {
    t.close();
  }
});

test("importing skips games already present, by BGG ID or by name ignoring case, and never overwrites them", async () => {
  const t = await startApp();
  try {
    t.store.createGame({ name: "Catan", bggId: 13, status: "Owned", notes: "classic" });
    t.store.createGame({ name: "Bookwyrm", watchStage: "awaiting", targetPrice: 40 });
    const result = importWatchlist(t.store, [
      { name: "Catan Renamed", bggId: 13, watchStage: "campaign" },
      { name: "BOOKWYRM", watchStage: "buy", targetPrice: 99 },
      { name: "King's Gambit", bggId: 4242, watchStage: "campaign" },
      { name: "king's gambit", watchStage: "reviews" },
      { name: "Excursions", watchStage: "delivered" },
      { name: "Excursions", bggId: 4242, watchStage: "delivered" },
    ]);
    assert.deepEqual(result, {
      added: ["King's Gambit", "Excursions"],
      skipped: ["Catan Renamed", "BOOKWYRM", "king's gambit", "Excursions"],
    });
    const games = t.store.listGames();
    assert.equal(games.length, 4);
    const catan = t.store.getByBggId(13);
    assert.deepEqual([catan.name, catan.watchStage, catan.notes], ["Catan", null, "classic"]);
    const book = games.find((g) => g.name === "Bookwyrm");
    assert.deepEqual([book.watchStage, book.targetPrice], ["awaiting", 40]);
  } finally {
    t.close();
  }
});

test("exporting the watchlist and importing it into an empty database reproduces the watched games", async () => {
  const from = await startApp();
  const to = await startApp();
  try {
    from.store.createGame({ name: "Catan", bggId: 13, status: "Owned" });
    from.store.createGame({ name: "Bookwyrm", bggId: 777, ...WATCHED, notes: "art looks great" });
    from.store.createGame({ name: "King's Gambit", watchStage: "awaiting", deliveryEst: "2027-03", targetPrice: 60 });
    from.store.createGame({ name: "Excursions", watchStage: "pass", notes: "too long" });
    const exported = watchlistExport(from.store);
    assert.deepEqual(importWatchlist(to.store, exported.games).added, ["Bookwyrm", "King's Gambit", "Excursions"]);
    assert.deepEqual(watchlistExport(to.store, new Date(exported.exportedAt)).games, exported.games);
  } finally {
    from.close();
    to.close();
  }
});

test("importing bad input fails with a clear message and writes nothing", async () => {
  const t = await startApp();
  try {
    t.store.createGame({ name: "Catan", bggId: 13 });
    const good = { name: "Bookwyrm", watchStage: "campaign" };
    const cases = [
      [{ games: "nope" }, /array/],
      ["Bookwyrm", /array/],
      [[good, "Infamous Traffic"], /game 2 .*object/],
      [[good, { watchStage: "campaign" }], /game 2 .*name/],
      [[good, { name: "  ", watchStage: "campaign" }], /game 2 .*name/],
      [[good, { name: "Infamous Traffic", watchStage: "maybe" }], /Infamous Traffic.*watchStage must be one of/],
      [[good, { name: "Infamous Traffic" }], /Infamous Traffic.*watchStage/],
      [[good, { name: "Infamous Traffic", watchStage: "campaign", targetPrice: -3 }], /Infamous Traffic.*targetPrice/],
      [[good, { name: "Infamous Traffic", bggId: "abc", watchStage: "campaign" }], /Infamous Traffic.*bggId/],
    ];
    for (const [input, message] of cases) {
      assert.throws(() => importWatchlist(t.store, input), message, JSON.stringify(input));
    }
    assert.deepEqual(t.store.listGames().map((g) => g.name), ["Catan"]);
  } finally {
    t.close();
  }
});

test("the import-watchlist CLI reads an array or an export file, and explains a missing file or bad JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-wimp-"));
  const t = await startApp();
  try {
    t.store.createGame({ name: "Bookwyrm", ...WATCHED });
    const exportFile = join(dir, "export.json");
    writeWatchlist(t.store, exportFile);
    assert.deepEqual(readWatchlistFile(exportFile).map((g) => g.name), ["Bookwyrm"]);

    const arrayFile = join(dir, "seed.json");
    writeFileSync(arrayFile, JSON.stringify([{ name: "Excursions", watchStage: "campaign" }]));
    assert.deepEqual(readWatchlistFile(arrayFile), [{ name: "Excursions", watchStage: "campaign" }]);

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "[{ name: ");
    assert.throws(() => readWatchlistFile(broken), /broken\.json is not valid JSON/);
    assert.throws(() => readWatchlistFile(join(dir, "nope.json")), /No file at .*nope\.json/);
    assert.throws(() => readWatchlistFile(dir), /is a folder/);
  } finally {
    t.close();
  }
});
