import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { openDb } from "../server/db.js";
import { BggClient } from "../server/bgg.js";
import { createApp } from "../server/app.js";
import { readWorkbook, importInto } from "../server/import-xlsx.js";

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

async function startApp({ withBgg = true } = {}) {
  const store = openDb(":memory:");
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
  return { store, calls, call, close: () => server.close() };
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
