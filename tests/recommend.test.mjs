import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { BggClient } from "../server/bgg.js";
import { createApp } from "../server/app.js";
import { Predictor, parseNominees } from "../server/predict.js";
import { DROP, RecommendScheduler, buildNominateSystem, buildNominateUser, matchNominee, matches, nextRunAt } from "../server/recommend.js";
import { DEFAULT_SETTINGS } from "../public/js/rubric.js";

const all = (v) => ({ desire: v, table: v, depth: v, interaction: v, replay: v, art: v, theme: v });

// ---------- fakes ----------

/**
 * A fake Anthropic client that answers by the tool it is offered: one
 * `nominees` reply for submit_nominees, and one `predictions` reply per game
 * name (a function of the user message, or a fixed message).
 */
function fakeClaude({ nominees = [], predictions = {} }) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const tool = params.tools.find((t) => t.name !== "web_search").name;
          let reply;
          if (tool === "submit_nominees") {
            reply = typeof nominees === "function" ? nominees(params) : toolMsg(tool, { nominees });
          } else {
            const name = /^Name: (.*?)(?: \(\d{4}\))?$/m.exec(params.messages[0].content)?.[1];
            const r = predictions[name];
            if (!r) throw new Error(`fake Claude has no prediction for ${name}`);
            reply = typeof r === "function" ? r(params) : toolMsg(tool, submission(r));
          }
          return { finalMessage: async () => reply };
        },
      },
    },
  };
  return { client, calls };
}

const toolMsg = (name, input, usage = { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } }) => ({
  stop_reason: "tool_use",
  usage,
  content: [{ type: "tool_use", id: "t1", name, input }],
});

const submission = ({ score = 8, avoid = false } = {}) => ({
  scores: all(score),
  confidence: "medium",
  rationale: "Like Brass.",
  two_player: "Fine at two.",
  avoid_theme: avoid,
  avoid_theme_reason: avoid ? "Demons." : "",
  sources: [],
});

/** A nominee as Claude would submit it, with the year BGG's fixture has for it (or 2025 when unknown). */
const nominee = (name, extra = {}) => ({
  name,
  year: Object.values(THINGS).find((t) => t.name === name)?.year ?? 2025,
  bgg_id: 0,
  expansion: false,
  reason: `Like Brass: ${name}.`,
  ...extra,
});

const thingXml = ({ id, name, year = 2025, type = "boardgame", base = null }) => `
  <item type="${type}" id="${id}">
    <name type="primary" sortindex="1" value="${name}"/>
    <yearpublished value="${year}"/>
    <minplayers value="2"/><maxplayers value="4"/><playingtime value="90"/>
    <thumbnail>https://img/${id}.jpg</thumbnail>
    ${base ? `<link type="boardgameexpansion" id="${base.id}" value="${base.name}" inbound="true"/>` : ""}
    <statistics page="1"><ratings><average value="7.5"/><averageweight value="3.0"/></ratings></statistics>
  </item>`;

const searchXml = (items) =>
  `<items>${items.map((i) => `<item type="${i.type || "boardgame"}" id="${i.id}"><name type="primary" value="${i.name}"/><yearpublished value="${i.year || 2025}"/></item>`).join("")}</items>`;

const hotXml = (items) =>
  `<items>${items.map((i, n) => `<item id="${i.id}" rank="${n + 1}"><thumbnail value="https://img/${i.id}.jpg"/><name value="${i.name}"/><yearpublished value="${i.year || 2025}"/></item>`).join("")}</items>`;

/** A fake BGG holding `things` (by id). Search matches by a case-insensitive substring. */
function fakeBgg(things, { hot = [], failHot = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const path = u.pathname.split("/").pop();
    calls.push(`${path}?${u.searchParams}`);
    if (path === "hot") return new Response(failHot ? "oops" : hotXml(hot), { status: failHot ? 500 : 200 });
    if (path === "thing") {
      const ids = u.searchParams.get("id").split(",").map(Number);
      return new Response(`<items>${ids.map((id) => things[id]).filter(Boolean).map(thingXml).join("")}</items>`, { status: 200 });
    }
    if (path === "search") {
      const q = u.searchParams.get("query").toLowerCase();
      return new Response(searchXml(Object.values(things).filter((t) => t.name.toLowerCase().includes(q))), { status: 200 });
    }
    return new Response("<items></items>", { status: 200 });
  };
  return { client: new BggClient({ token: "tok", fetchImpl, spacingMs: 0, retryMs: 0, sleep: async () => {} }), calls };
}

const THINGS = {
  100: { id: 100, name: "Brass: Birmingham", year: 2018 },
  101: { id: 101, name: "Brass: Extra", year: 2026, type: "boardgameexpansion", base: { id: 100, name: "Brass: Birmingham" } },
  102: { id: 102, name: "Brass: More", year: 2026, type: "boardgameexpansion", base: { id: 100, name: "Brass: Birmingham" } },
  200: { id: 200, name: "Munchkin", year: 2001 },
  201: { id: 201, name: "Munchkin: Deluxe", year: 2010, type: "boardgameexpansion", base: { id: 200, name: "Munchkin" } },
  301: { id: 301, name: "Arcs", year: 2024 },
  302: { id: 302, name: "Nucleum", year: 2023 },
  303: { id: 303, name: "Hegemony", year: 2023 },
  304: { id: 304, name: "Voidfall", year: 2023 },
  305: { id: 305, name: "Kutna Hora", year: 2023 },
  306: { id: 306, name: "Spirit Island", year: 2017 },
  307: { id: 307, name: "Dune: Imperium", year: 2020 },
  308: { id: 308, name: "Slay the Spire: The Board Game", year: 2025 },
};

async function startApp({ claude = {}, things = THINGS, bgg: bggOpts, configured = true, now } = {}) {
  const store = openDb(":memory:");
  const fake = fakeClaude(claude);
  const predictor = new Predictor({ client: configured ? fake.client : null });
  const bgg = fakeBgg(things, bggOpts);
  const app = createApp({ store, bgg: bgg.client, bggUsername: "tester", predictor, now });
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
  /** Poll until no run is going, then return the recommendations view. */
  const settle = async () => {
    for (let i = 0; i < 500; i++) {
      const { body } = await call("GET", "/api/recommendations");
      if (!body.running) return body;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("run never finished");
  };
  return { store, app, claude: fake.calls, bggCalls: bgg.calls, call, settle, close: () => (server.close(), store.db.close()) };
}

// ---------- prompt ----------

test("the nominate prompt lists scores, the rest of the list, hotness, dismissals and recent picks", () => {
  const games = [
    { id: 1, bggId: 100, name: "Brass", type: "Base", plays: 12, scores: all(10) },
    { id: 2, bggId: 200, name: "Unscored Thing", type: "Base", plays: 0, scores: all(null) },
    { id: 3, bggId: 300, name: "Watched", type: "Base", plays: 0, scores: all(null), watchStage: "campaign" },
    { id: 4, bggId: null, name: "Old Note", type: "Base", plays: 0, scores: all(null) },
  ];
  const system = buildNominateSystem(games, { ...DEFAULT_SETTINGS, tasteProfile: "Shared maps." });
  assert.match(system, /Shared maps\./);
  assert.match(system, /- Brass \| 10\.0/);
  assert.match(system, /## Other games in their list \(2, unscored or watched\)\nUnscored Thing; Watched/);
  assert.doesNotMatch(system, /Old Note/);
  const user = buildNominateUser({
    count: 10,
    hotness: [{ bggId: 5, name: "Hot One", year: 2026 }],
    dismissed: [{ bggId: 6, name: "Nope" }],
    recent: [{ bggId: 7, name: "Last Week" }],
  });
  assert.match(user, /^Nominate 10 games/);
  assert.match(user, /- Hot One \(2026\), BGG ID 5/);
  assert.match(user, /Recommended recently \(prefer others\): Last Week/);
  assert.match(user, /Not interested .*: Nope/);
  assert.doesNotMatch(buildNominateUser({ count: 5 }), /Hotness|recently|Not interested/);
});

test("parseNominees trims, drops blanks and duplicates, caps the count and rejects an empty list", () => {
  const out = parseNominees(
    { nominees: [nominee(" Arcs "), nominee("arcs"), nominee(""), nominee("Nucleum", { year: 0, bgg_id: 302 }), nominee("Hegemony")] },
    2,
  );
  assert.deepEqual(out.map((n) => n.name), ["Arcs", "Nucleum"]);
  assert.equal(out[1].year, null);
  assert.equal(out[1].bggId, 302);
  assert.throws(() => parseNominees({ nominees: [] }), /nominated no games/);
});

test("matches takes the same name, or a word prefix only when the years are known and close", () => {
  assert.ok(matches({ name: "Brass Birmingham", year: 2018 }, { name: "Brass: Birmingham", year: 2018 }));
  assert.ok(matches({ name: "Arcs", year: 2024 }, { name: "Arcs: The Blighted Reach", year: 2025 }));
  assert.ok(matches({ name: "Arcs", year: null }, { name: "Arcs", year: 2024 }));
  assert.ok(!matches({ name: "Arcs", year: 2024 }, { name: "Arcs", year: 1999 }));
  assert.ok(!matches({ name: "Root", year: 2018 }, { name: "Rootin Tootin", year: 2018 }));
  assert.ok(!matches({ name: "Dune", year: null }, { name: "Dune: Imperium", year: 2020 }), "no year, no prefix match");
});

test("a nominee whose BGG ID lookup fails is still found by name", async () => {
  const log = { error() {} };
  const bgg = {
    details: async (id) => {
      if (id === 999) throw new Error("BGG 502");
      return { ...THINGS[id], bggId: id, type: "Base" };
    },
    search: async () => [{ bggId: 301, name: "Arcs", year: 2024, type: "Base" }],
  };
  const d = await matchNominee(bgg, { name: "Arcs", year: 2024, bggId: 999 }, log);
  assert.equal(d.bggId, 301);
});

// ---------- runs ----------

const TEN = ["Arcs", "Nucleum", "Hegemony", "Voidfall", "Kutna Hora", "Spirit Island", "Dune: Imperium", "Slay the Spire: The Board Game", "Brass: Extra", "Brass: More"];

test("a run nominates, matches, excludes, predicts and ranks the top 5 with at most one expansion", async () => {
  const predictions = {
    Arcs: { score: 8.5 },
    Nucleum: { score: 8 },
    Hegemony: { score: 7 },
    Voidfall: { score: 6 },
    "Kutna Hora": { score: 5 },
    "Spirit Island": { score: 9.5, avoid: true },
    "Slay the Spire: The Board Game": { score: 4 },
    "Brass: Extra": { score: 9.9 },
    "Brass: More": { score: 9.8 },
  };
  const nominees = TEN.map((n) => nominee(n, n.startsWith("Brass:") ? { expansion: true } : {}));
  nominees.push(nominee("Munchkin: Deluxe", { expansion: true }), nominee("Totally Made Up"), nominee("Arcs: Base", { bgg_id: 301 }));
  const t = await startApp({ claude: { nominees, predictions }, bgg: { hot: [{ id: 301, name: "Arcs", year: 2024 }] } });
  try {
    t.store.setSettings({ recommendNominees: 13 });
    t.store.createGame({ name: "Brass: Birmingham", bggId: 100, plays: 10, scores: all(10) });
    t.store.createGame({ name: "Munchkin", bggId: 200, plays: 2, scores: all(3) });
    t.store.createGame({ name: "Dune: Imperium", bggId: 307, plays: 0, scores: all(null) });

    const r = await t.call("POST", "/api/recommendations/refresh", {});
    assert.equal(r.status, 202);
    assert.equal(r.body.running, true);

    const view = await t.settle();
    assert.equal(view.run.status, "done");
    assert.equal(view.run.trigger, "manual");
    assert.deepEqual(view.picks.map((p) => [p.rank, p.name, p.final]), [
      [1, "Brass: Extra", 10],
      [2, "Arcs", 9.4],
      [3, "Nucleum", 8.8],
      [4, "Hegemony", 7.5],
      [5, "Voidfall", 6.3],
    ]);
    assert.equal(view.picks[0].type, "Expansion");
    assert.equal(view.picks[0].thumbnail, "https://img/101.jpg");
    assert.equal(view.picks[1].confidence, "medium");
    assert.match(view.picks[1].reason, /Like Brass/);
    assert.equal(view.lastRun, null);

    const nominate = t.claude[0];
    assert.match(nominate.system[0].text, /- Brass: Birmingham \| 10\.0/);
    assert.match(nominate.messages[0].content, /Nominate 13 games/);
    assert.match(nominate.messages[0].content, /- Arcs \(2024\), BGG ID 301/);

    const runs = (await t.call("GET", "/api/recommendations/runs")).body;
    assert.equal(runs.length, 1);
    const drops = Object.fromEntries(runs[0].nominees.filter((n) => n.dropped).map((n) => [n.name, n.dropped]));
    assert.deepEqual(drops, {
      "Brass: More": DROP.expansionLimit,
      "Kutna Hora": DROP.notTop,
      "Spirit Island": DROP.avoidTheme,
      "Slay the Spire: The Board Game": DROP.notTop,
      "Dune: Imperium": DROP.inList,
      "Munchkin: Deluxe": DROP.expansionBase,
      "Totally Made Up": DROP.unmatched,
      "Arcs: Base": DROP.duplicate,
    });
    assert.equal(runs[0].predicted, 9);
    assert.equal(runs[0].reused, 0);
    assert.equal(runs[0].usage.input, 100 * 10);
    assert.equal(runs[0].usage.searches, 10);
    // Spirit Island's prediction is kept, on the Predicted screen, even though it isn't shown.
    assert.equal((await t.call("GET", "/api/predictions?bggId=306")).body.length, 1);
  } finally {
    t.close();
  }
});

test("a run reuses a recent prediction, and the picks drop games since added or dismissed", async () => {
  const five = ["Arcs", "Nucleum", "Hegemony", "Voidfall", "Kutna Hora"];
  const predictions = Object.fromEntries(five.map((n, i) => [n, { score: 9 - i }]));
  delete predictions.Arcs; // Arcs must come from the stored prediction
  const t = await startApp({ claude: { nominees: five.map((n) => nominee(n)), predictions } });
  try {
    const old = t.store.createPrediction({ bggId: 301, name: "Arcs", model: "m" });
    t.store.finishPrediction(old.id, { ...submissionStored(9.5), name: "Arcs", scoredGames: 0 });
    await t.call("POST", "/api/recommendations/refresh", {});
    let view = await t.settle();
    assert.equal(view.run.status, "done");
    assert.equal(view.run.reused, 1);
    assert.equal(view.run.predicted, 4);
    assert.equal(view.picks[0].name, "Arcs");
    assert.equal(view.picks[0].predictionId, old.id);

    await t.call("POST", "/api/games/from-bgg", { bggId: 301 });
    const d = await t.call("POST", "/api/recommendations/dismissed", { bggId: 302, name: "Nucleum" });
    assert.deepEqual(d.body.map((x) => x.name), ["Nucleum"]);
    view = (await t.call("GET", "/api/recommendations")).body;
    assert.deepEqual(view.picks.map((p) => p.name), ["Hegemony", "Voidfall", "Kutna Hora"]);

    await t.call("DELETE", "/api/recommendations/dismissed/302", {});
    assert.deepEqual((await t.call("GET", "/api/recommendations/dismissed")).body, []);
    view = (await t.call("GET", "/api/recommendations")).body;
    assert.deepEqual(view.picks.map((p) => p.name), ["Nucleum", "Hegemony", "Voidfall", "Kutna Hora"]);
    assert.equal((await t.call("POST", "/api/recommendations/dismissed", { bggId: 0, name: "x" })).status, 400);
    assert.equal((await t.call("DELETE", "/api/recommendations/dismissed/abc", {})).status, 400);
  } finally {
    t.close();
  }
});

/** A stored-shape submission for store.finishPrediction. */
function submissionStored(score) {
  return { scores: all(score), confidence: "high", rationale: "", twoPlayer: "", avoidTheme: false, avoidThemeReason: "", sources: [], usage: null };
}

test("a run that can't fill 5 picks fails and keeps the last good set", async () => {
  const five = ["Arcs", "Nucleum", "Hegemony", "Voidfall", "Kutna Hora"];
  const predictions = Object.fromEntries(five.map((n, i) => [n, { score: 9 - i }]));
  predictions["Slay the Spire: The Board Game"] = () => ({ stop_reason: "refusal", usage: {}, content: [] });
  // The second run swaps Kutna Hora for a game whose prediction fails.
  let second = false;
  const nominees = () => toolMsg("submit_nominees", { nominees: (second ? [...five.slice(0, 4), "Slay the Spire: The Board Game"] : five).map((n) => nominee(n)) });
  const t = await startApp({ claude: { nominees, predictions } });
  try {
    await t.call("POST", "/api/recommendations/refresh", {});
    const first = await t.settle();
    assert.equal(first.run.status, "done");

    second = true;
    await t.call("POST", "/api/recommendations/refresh", {});
    const view = await t.settle();
    assert.equal(view.run.id, first.run.id, "the good set stays");
    assert.equal(view.lastRun.status, "failed");
    assert.match(view.lastRun.error, /Only 4 of 5/);
    assert.equal(view.picks.length, 5);
    const runs = (await t.call("GET", "/api/recommendations/runs")).body;
    assert.equal(runs[0].status, "failed");
    assert.equal(runs[0].reused, 4);
    assert.match(runs[0].nominees.find((n) => n.name === "Slay the Spire: The Board Game").dropped, /prediction failed: Claude declined/);
  } finally {
    t.close();
  }
});

test("a failed nomination, a BGG hotness outage and missing keys are reported", async () => {
  const t = await startApp({
    claude: { nominees: () => ({ stop_reason: "refusal", usage: {}, content: [] }) },
    bgg: { failHot: true },
  });
  try {
    await t.call("POST", "/api/recommendations/refresh", {});
    const view = await t.settle();
    assert.equal(view.run, null);
    assert.equal(view.lastRun.status, "failed");
    assert.match(view.lastRun.error, /declined/);
    assert.ok(t.bggCalls.some((c) => c.startsWith("hot?")));
    assert.match(t.claude[0].messages[0].content, /^Nominate 10 games/);
    assert.doesNotMatch(t.claude[0].messages[0].content, /Hotness/);
  } finally {
    t.close();
  }
  const off = await startApp({ configured: false });
  try {
    assert.equal((await off.call("POST", "/api/recommendations/refresh", {})).status, 400);
    assert.equal((await off.call("GET", "/api/recommendations")).body.picks.length, 0);
  } finally {
    off.close();
  }
});

test("a manual prediction goes ahead of a run's remaining nominees", async () => {
  const five = ["Arcs", "Nucleum", "Hegemony", "Voidfall", "Kutna Hora"];
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const predictions = {};
  for (const [i, n] of five.entries()) {
    predictions[n] = async () => {
      order.push(n);
      if (n === "Arcs") await gate; // hold the first one so the manual request queues behind it
      return toolMsg("submit_prediction", submission({ score: 9 - i }));
    };
  }
  predictions["Brass: Birmingham"] = async () => (order.push("manual"), toolMsg("submit_prediction", submission({ score: 9 })));
  const t = await startApp({ claude: { nominees: five.map((n) => nominee(n)), predictions } });
  try {
    await t.call("POST", "/api/recommendations/refresh", {});
    // Wait for the run to start its first prediction, then ask for a manual one.
    for (let i = 0; i < 200 && !order.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await t.call("POST", "/api/recommendations/refresh", {})).status, 409, "one run at a time");
    assert.equal((await t.call("POST", "/api/predictions", { bggId: 301, name: "Arcs" })).status, 409, "the run is predicting it right now");
    const m = await t.call("POST", "/api/predictions", { bggId: 100, name: "Brass: Birmingham" });
    assert.equal(m.status, 202);
    assert.equal((await t.call("POST", "/api/predictions", { bggId: 200 })).status, 409, "one manual prediction at a time");
    release();
    const view = await t.settle();
    assert.equal(view.run.status, "done");
    assert.deepEqual(order, ["Arcs", "manual", "Nucleum", "Hegemony", "Voidfall", "Kutna Hora"]);
    assert.equal((await t.call("GET", `/api/predictions/${m.body.id}`)).body.status, "done");
  } finally {
    t.close();
  }
});

// ---------- schedule ----------

test("the recommendation settings are validated", async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call("GET", "/api/state")).body.settings.recommendFrequency, "weekly");
    assert.equal((await t.call("PUT", "/api/settings", { recommendFrequency: "hourly" })).status, 400);
    assert.equal((await t.call("PUT", "/api/settings", { recommendNominees: 3 })).status, 400);
    assert.equal((await t.call("PUT", "/api/settings", { recommendNominees: 7.5 })).status, 400);
    const ok = await t.call("PUT", "/api/settings", { recommendFrequency: "monthly", recommendNominees: 8 });
    assert.equal(ok.body.recommendFrequency, "monthly");
    assert.equal(ok.body.recommendNominees, 8);
    assert.equal((await t.call("PUT", "/api/settings", { recommendFrequency: "off" })).body.recommendFrequency, "off");
    assert.equal((await t.call("GET", "/api/recommendations")).body.nextRunAt, null);
  } finally {
    t.close();
  }
});

test("nextRunAt is 4am on the day the interval lands, never more than an hour in the past, and null when off", () => {
  const at = (s) => new Date(s);
  const now = at("2026-10-19T10:00:00"); // Monday
  // A scheduled run started Sunday 04:00:30: next Sunday 04:00.
  assert.equal(nextRunAt("weekly", "2026-10-18T04:00:30", now).getTime(), at("2026-10-25T04:00:00").getTime());
  // A manual refresh at 9pm Sunday: the interval runs past Sunday 04:00, so Monday.
  assert.equal(nextRunAt("weekly", "2026-10-18T21:00:00", now).getTime(), at("2026-10-26T04:00:00").getTime());
  // Overdue by days (server was down, or the schedule was just switched on): the next 4am, not now.
  assert.equal(nextRunAt("daily", "2026-10-10T04:00:00", now).getTime(), at("2026-10-20T04:00:00").getTime());
  // Due this morning and noticed within the hour: still due.
  assert.equal(nextRunAt("daily", "2026-10-18T04:00:00", at("2026-10-19T04:30:00")).getTime(), at("2026-10-19T04:00:00").getTime());
  // No run yet: the next 4am.
  assert.equal(nextRunAt("weekly", null, now).getTime(), at("2026-10-20T04:00:00").getTime());
  assert.equal(nextRunAt("weekly", null, at("2026-10-19T03:00:00")).getTime(), at("2026-10-19T04:00:00").getTime());
  // A failed run this morning pushes the retry to tomorrow.
  assert.equal(nextRunAt("daily", "2026-10-18T04:00:00", at("2026-10-19T04:30:00"), at("2026-10-19T04:01:00")).getTime(), at("2026-10-20T04:00:00").getTime());
  assert.equal(nextRunAt("biweekly", "2026-10-18T04:00:00", now).getTime(), at("2026-11-01T04:00:00").getTime());
  assert.equal(nextRunAt("off", "2026-10-18T04:00:00", now), null);
  assert.equal(nextRunAt("bogus", null, now), null);
});

test("the scheduler runs when due, once, and retries a failure only at the next 4am", () => {
  const store = openDb(":memory:");
  let clock = new Date("2026-10-19T03:59:00");
  const runs = [];
  const sched = new RecommendScheduler({ store, run: (o) => (runs.push(o.trigger), true), now: () => clock });
  try {
    assert.equal(sched.tick(), false, "not yet 4am");
    clock = new Date("2026-10-19T04:01:00");
    assert.equal(sched.tick(), true);
    assert.deepEqual(runs, ["schedule"]);
    // The run failed: a tick later the same day doesn't retry.
    const run = store.createRecommendationRun({ model: "m", startedAt: clock.toISOString() });
    store.failRecommendationRun(run.id, "boom");
    clock = new Date("2026-10-19T09:00:00");
    assert.equal(sched.tick(), false);
    assert.equal(sched.nextRunAt.getTime(), new Date("2026-10-20T04:00:00").getTime());
    clock = new Date("2026-10-20T04:01:00");
    assert.equal(sched.tick(), true);
    // It succeeded: next is a week after it started.
    const good = store.createRecommendationRun({ model: "m", startedAt: clock.toISOString() });
    store.finishRecommendationRun(good.id, { usage: null, predicted: 5, reused: 0 });
    clock = new Date("2026-10-21T04:01:00");
    assert.equal(sched.tick(), false);
    assert.equal(sched.nextRunAt.getDate(), 27);
    store.setSettings({ recommendFrequency: "off" });
    clock = new Date("2026-12-01T12:00:00");
    assert.equal(sched.tick(), false);
    // Switched back on weeks later, mid-day: waits for the next 4am rather than running now.
    store.setSettings({ recommendFrequency: "weekly" });
    assert.equal(sched.tick(), false);
    assert.equal(sched.nextRunAt.getTime(), new Date("2026-12-02T04:00:00").getTime());
    assert.equal(runs.length, 2);
  } finally {
    store.db.close();
  }
});

test("a run left going by a restart is marked failed", () => {
  const store = openDb(":memory:");
  try {
    const run = store.createRecommendationRun({ model: "m" });
    assert.equal(store.failRunningRecommendationRuns(), 1);
    assert.match(store.getRecommendationRun(run.id).error, /restarted/);
    assert.equal(store.failRunningRecommendationRuns(), 0);
  } finally {
    store.db.close();
  }
});
