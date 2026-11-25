import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { BggClient } from "../server/bgg.js";
import { createApp } from "../server/app.js";
import { Predictor, buildSystem, buildTarget, parseSubmission } from "../server/predict.js";
import { DEFAULT_SETTINGS } from "../public/js/rubric.js";

const CRITERIA_COLS = "s_desire, s_table, s_depth, s_interaction, s_replay, s_art, s_theme";
const all = (v) =>({ desire: v, table: v, depth: v, interaction: v, replay: v, art: v, theme: v });

// ---------- fakes ----------

/** A fake Anthropic client. Each reply is a message, or a function of the request that returns one. */
function fakeClaude(replies) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const r = replies.shift();
          if (!r) throw new Error("fake Claude has no reply left");
          return { finalMessage: async () => (typeof r === "function" ? r(params) : r) };
        },
      },
    },
  };
  return { client, calls };
}

const submission = (overrides = {}) => ({
  scores: { desire: 8, table: 7, depth: 8, interaction: 9, replay: 8, art: 6, theme: 7 },
  confidence: "medium",
  rationale: "Plays like Brass with a smaller map.",
  two_player: "Tight at two.",
  avoid_theme: false,
  avoid_theme_reason: "",
  sources: [],
  ...overrides,
});

const submitMsg = (input = submission(), usage = { input_tokens: 100, output_tokens: 50 }) => ({
  stop_reason: "tool_use",
  usage,
  content: [{ type: "tool_use", id: "t1", name: "submit_prediction", input }],
});

const THING = `<?xml version="1.0" encoding="utf-8"?>
<items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgameexpansion" id="500">
    <name type="primary" sortindex="1" value="Brass: Extra"/>
    <description>A new map &amp;amp; more.&amp;#10;&amp;#10;&amp;#10;Second &amp;quot;paragraph&amp;quot;.</description>
    <yearpublished value="2026"/>
    <minplayers value="2"/><maxplayers value="4"/>
    <playingtime value="120"/>
    <link type="boardgamemechanic" id="1" value="Network Building"/>
    <link type="boardgamemechanic" id="2" value="Hand Management"/>
    <link type="boardgamecategory" id="3" value="Economic"/>
    <link type="boardgamedesigner" id="4" value="Some Designer"/>
    <link type="boardgameexpansion" id="100" value="Brass" inbound="true"/>
    <statistics page="1"><ratings><average value="8.1"/><averageweight value="3.9"/></ratings></statistics>
  </item>
</items>`;

function fakeBgg(thing = THING) {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.split("/").pop();
    if (path === "thing") return new Response(thing, { status: 200 });
    return new Response("<items></items>", { status: 200 });
  };
  return new BggClient({ token: "tok", fetchImpl, spacingMs: 0, retryMs: 0, sleep: async () => {} });
}

async function startApp({ replies = [], configured = true, model, thing } = {}) {
  const store = openDb(":memory:");
  const claude = fakeClaude(replies);
  const predictor = new Predictor({ client: configured ? claude.client : null, model });
  const app = createApp({ store, bgg: fakeBgg(thing), bggUsername: "tester", predictor });
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
  /** Poll a prediction until it leaves the running state. */
  const settle = async (id) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await call("GET", `/api/predictions/${id}`);
      if (body.status !== "running") return body;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("prediction never finished");
  };
  return { store, calls: claude.calls, call, settle, close: () => (server.close(), store.db.close()) };
}

// ---------- BGG details ----------

test("BGG details add description, mechanics, categories, designers and base games", async () => {
  const d = await fakeBgg().details(500);
  assert.equal(d.name, "Brass: Extra");
  assert.equal(d.type, "Expansion");
  assert.equal(d.description, "A new map & more.\n\nSecond \"paragraph\".");
  assert.deepEqual(d.mechanics, ["Network Building", "Hand Management"]);
  assert.deepEqual(d.categories, ["Economic"]);
  assert.deepEqual(d.designers, ["Some Designer"]);
  assert.deepEqual(d.baseGames, [{ bggId: 100, name: "Brass" }]);
  assert.equal(d.bggWeight, 3.9);
});

// ---------- prompt ----------

test("the system prompt holds the rubric, taste profile and scores, without the target or watched games", () => {
  const games = [
    { id: 1, bggId: 100, name: "Brass", type: "Base", plays: 12, scores: all(10), bggWeight: 3.9, minPlayers: 2, maxPlayers: 4, bestPlayers: "3,4" },
    { id: 2, bggId: 200, name: "Munchkin", type: "Base", plays: 1, scores: { ...all(3), theme: 1 }, avoidTheme: true },
    { id: 3, bggId: 300, name: "Target", type: "Base", plays: 0, scores: all(9) },
    { id: 4, bggId: 400, name: "Watched", type: "Base", plays: 0, scores: all(8), watchStage: "campaign" },
    { id: 5, bggId: 500, name: "Old Favorite", type: "Expansion", plays: 3, scores: all(null), bggRating: 8, wontScore: true },
    { id: 6, bggId: null, name: "No Rating", type: "Base", plays: 0, scores: all(null) },
  ];
  const settings = { ...DEFAULT_SETTINGS, tasteProfile: "I love shared-map tension." };
  const { text, scoredGames } = buildSystem(games, settings, { bggId: 300 });
  assert.equal(scoredGames, 2);
  assert.match(text, /### Desire to Play \(key "desire", weight 40, Absolute\)/);
  assert.match(text, /I love shared-map tension\./);
  assert.match(text, /- Brass \| 10\.0 \| 10\/10\/10\/10\/10\/10\/10 \| 12 plays \| weight 3\.9 \| 2-4p, best 3,4/);
  assert.match(text, /- Munchkin \| .* \| 1 plays \(provisional\) \| AVOID THEME/);
  assert.ok(text.indexOf("- Brass") < text.indexOf("- Munchkin"), "sorted by final score");
  assert.match(text, /- Old Favorite \[expansion\]: 8\.0 \(won't rescore\)/);
  assert.doesNotMatch(text, /Target|Watched|No Rating/);
  // Nothing per-request in the system prompt, so it caches.
  assert.equal(buildSystem(games, settings, { bggId: 300 }).text, text);
});

test("an empty taste profile says so", () => {
  const { text } = buildSystem([], DEFAULT_SETTINGS);
  assert.match(text, /haven't written a taste profile yet/);
});

test("the target names a scored base game, and falls back to the name without BGG data", async () => {
  const details = await fakeBgg().details(500);
  const games = [{ id: 1, bggId: 100, name: "Brass", scores: all(10) }];
  const text = buildTarget({ name: "x", details, games, settings: DEFAULT_SETTINGS });
  assert.match(text, /Name: Brass: Extra \(2026\)/);
  assert.match(text, /Type: expansion/);
  assert.match(text, /Expands: Brass \(I scored it 10\.0\)/);
  assert.match(text, /Mechanics: Network Building, Hand Management/);
  assert.match(text, /Second "paragraph"/);
  const bare = buildTarget({ name: "Mystery Game", details: null, settings: DEFAULT_SETTINGS });
  assert.match(bare, /Name: Mystery Game/);
  assert.match(bare, /Search the web/);
});

// ---------- predictor ----------

test("parseSubmission clamps and rounds scores and drops sources Claude didn't find", () => {
  const found = new Map([["https://a.example/review", "A review"]]);
  const p = parseSubmission(
    submission({
      scores: { ...submission().scores, desire: 11, art: 6.66 },
      confidence: "certain",
      avoid_theme_reason: "ignored when the flag is off",
      sources: [
        { title: "", url: "https://a.example/review" },
        { title: "dup", url: "https://a.example/review" },
        { title: "Made up", url: "https://made.up/page" },
      ],
    }),
    found,
  );
  assert.equal(p.scores.desire, 10);
  assert.equal(p.scores.art, 6.7);
  assert.equal(p.confidence, "low");
  assert.equal(p.avoidThemeReason, "");
  assert.deepEqual(p.sources, [{ title: "A review", url: "https://a.example/review" }]);
  assert.throws(() => parseSubmission(submission({ scores: { desire: 5 } })), /Table Appeal/);
});

test("the predictor resumes a paused search turn, keeps found sources and sums usage", async () => {
  const search = {
    stop_reason: "pause_turn",
    usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 500, server_tool_use: { web_search_requests: 2 } },
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "brass extra review" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.example/review", title: "A review", encrypted_content: "x" }] },
    ],
  };
  const { client, calls } = fakeClaude([search, submitMsg(submission({ sources: [{ title: "A review", url: "https://a.example/review" }] }))]);
  const out = await new Predictor({ client }).predict({ system: "SYS", target: "TARGET" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "claude-opus-5-5");
  assert.deepEqual(calls[0].system, [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(calls[0].tools[0], { type: "web_search_20260209", name: "web_search", max_uses: 5 });
  assert.equal(calls[0].tools[1].strict, true);
  assert.equal(calls[0].fallbacks, "default");
  // The resume sends the paused turn back with no extra user message.
  assert.deepEqual(calls[1].messages.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(out.sources, [{ title: "A review", url: "https://a.example/review" }]);
  assert.deepEqual(out.usage, { input: 1100, output: 60, cacheRead: 500, cacheWrite: 0, searches: 2 });
});

test("the predictor nudges once when Claude stops without submitting, then gives up", async () => {
  const chat = { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "I think 8." }] };
  const ok = fakeClaude([chat, submitMsg()]);
  const out = await new Predictor({ client: ok.client, model: "claude-haiku-5-5" }).predict({ system: "S", target: "T" });
  assert.equal(out.scores.interaction, 9);
  assert.equal(ok.calls[0].fallbacks, undefined, "no fallback on models that don't take it");
  assert.match(ok.calls[1].messages.at(-1).content, /submit_prediction/);

  const stubborn = fakeClaude([chat, chat]);
  await assert.rejects(new Predictor({ client: stubborn.client }).predict({ system: "S", target: "T" }), /without submitting/);
});

test("the predictor reports a refusal and a missing key", async () => {
  const { client } = fakeClaude([{ stop_reason: "refusal", usage: {}, content: [] }]);
  await assert.rejects(new Predictor({ client }).predict({ system: "S", target: "T" }), /declined/);
  await assert.rejects(new Predictor().predict({ system: "S", target: "T" }), /ANTHROPIC_API_KEY/);
});

// ---------- API ----------

test("predict a BGG game: a job that finishes with scores, a final and sources", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    t.store.createGame({ name: "Brass", bggId: 100, plays: 10, scores: all(10) });
    const { body: state } = await t.call("GET", "/api/state");
    assert.deepEqual(state.claude, {
      configured: true, model: "claude-opus-5-5", running: null, recommending: false,
      budget: { used: 0, cap: 30, left: 30, freesAt: null },
    });

    const r = await t.call("POST", "/api/predictions", { bggId: 500, name: "Brass: Extra" });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, "running");
    const p = await t.settle(r.body.id);
    assert.equal(p.status, "done");
    assert.equal(p.name, "Brass: Extra");
    assert.equal(p.scoredGames, 1);
    assert.equal(p.final, 8.4);
    assert.equal(p.twoPlayer, "Tight at two.");
    assert.match(t.calls[0].messages[0].content, /Expands: Brass \(I scored it 10\.0\)/);

    const list = await t.call("GET", "/api/predictions?bggId=500");
    assert.deepEqual(list.body.map((x) => x.id), [p.id]);
  } finally {
    t.close();
  }
});

test("only one prediction runs at a time, and a failure is recorded", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = await startApp({ replies: [async () => (await gate, { stop_reason: "refusal", usage: {}, content: [] })] });
  try {
    const first = await t.call("POST", "/api/predictions", { bggId: 500 });
    assert.equal((await t.call("GET", "/api/state")).body.claude.running, first.body.id);
    assert.equal((await t.call("POST", "/api/predictions", { bggId: 501 })).status, 409);
    release();
    const p = await t.settle(first.body.id);
    assert.equal(p.status, "failed");
    assert.match(p.error, /declined/);
    assert.equal(p.final, null);
  } finally {
    t.close();
  }
});

test("predictions are refused without a key, for scored games and for bad targets", async () => {
  const off = await startApp({ configured: false });
  try {
    assert.equal((await off.call("GET", "/api/state")).body.claude.configured, false);
    assert.equal((await off.call("POST", "/api/predictions", { bggId: 500 })).status, 400);
  } finally {
    off.close();
  }
  const t = await startApp();
  try {
    const g = t.store.createGame({ name: "Brass", bggId: 100, scores: all(10) });
    assert.equal((await t.call("POST", "/api/predictions", { gameId: g.id })).status, 409);
    assert.equal((await t.call("POST", "/api/predictions", { bggId: 100 })).status, 409);
    assert.equal((await t.call("POST", "/api/predictions", { gameId: 999 })).status, 404);
    assert.equal((await t.call("POST", "/api/predictions", { bggId: "x" })).status, 400);
    assert.equal((await t.call("GET", "/api/predictions")).status, 400);
    assert.equal((await t.call("GET", "/api/predictions/999")).status, 404);
  } finally {
    t.close();
  }
});

test("a game without a BGG ID is predicted by name and keyed by game", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    const g = t.store.createGame({ name: "Kickstarter Thing", watchStage: "campaign" });
    const r = await t.call("POST", "/api/predictions", { gameId: g.id });
    const p = await t.settle(r.body.id);
    assert.equal(p.gameId, g.id);
    assert.match(t.calls[0].messages[0].content, /no BoardGameGeek data/);
    // The watched game had no predicted score, so it takes Claude's.
    assert.equal(t.store.getGame(g.id).predictedScore, 8.4);
    assert.equal((await t.call("GET", `/api/predictions?gameId=${g.id}`)).body.length, 1);
  } finally {
    t.close();
  }
});

test("a watched game's own predicted score always wins", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    const g = t.store.createGame({ name: "Watched", bggId: 500, watchStage: "campaign", predictedScore: 6.5 });
    const p = await t.settle((await t.call("POST", "/api/predictions", { bggId: 500 })).body.id);
    assert.equal(p.gameId, g.id);
    assert.equal(t.store.getGame(g.id).predictedScore, 6.5);
  } finally {
    t.close();
  }
});

test("adding a predicted game from BGG carries the avoid-theme flag and, when watched, the score", async () => {
  const t = await startApp({ replies: [submitMsg(submission({ avoid_theme: true, avoid_theme_reason: "Demons." }))] });
  try {
    await t.settle((await t.call("POST", "/api/predictions", { bggId: 500 })).body.id);
    const added = await t.call("POST", "/api/games/from-bgg", { bggId: 500, watchStage: "campaign" });
    assert.equal(added.status, 201);
    assert.equal(added.body.avoidTheme, true);
    assert.equal(added.body.predictedScore, 8.4);
  } finally {
    t.close();
  }
});

test("accuracy pairs a game's score with the last prediction made before it was scored", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    const g = t.store.createGame({ name: "Brass: Extra", bggId: 500, plays: 3 });
    await t.settle((await t.call("POST", "/api/predictions", { gameId: g.id })).body.id);
    assert.equal((await t.call("GET", "/api/predictions/accuracy")).body.n, 0);

    await t.call("PATCH", `/api/games/${g.id}`, { scores: { ...all(7), desire: 6 } });
    const scoredAt = t.store.getGame(g.id).scoredAt;
    assert.ok(scoredAt);
    // A prediction made after scoring (here, inserted directly) doesn't count.
    t.store.db.prepare("INSERT INTO predictions (bgg_id, name, model, status, created_at) VALUES (500, 'late', 'm', 'done', '2999-01-01T00:00:00.000Z')").run();
    const acc = (await t.call("GET", "/api/predictions/accuracy")).body;
    assert.equal(acc.n, 1);
    assert.equal(acc.pairs[0].predicted, 8.4);
    assert.equal(acc.pairs[0].actual, 7);
    assert.equal(acc.pairs[0].error, 1.4);
    assert.equal(acc.meanAbsError, 1.4);
    assert.equal(acc.bias, 1.4);
    const crit = Object.fromEntries(acc.criteria.map((c) => [c.key, c]));
    assert.deepEqual(acc.criteria.map((c) => c.key), ["desire", "table", "depth", "interaction", "replay", "art", "theme"]);
    assert.deepEqual(crit.desire, { key: "desire", n: 1, meanAbsError: 2, bias: 2 });
    assert.equal(crit.art.bias, -1);
    assert.equal(crit.table.bias, 0);
    assert.deepEqual(acc.pairs[0].criteria, { desire: 2, table: 0, depth: 1, interaction: 2, replay: 1, art: -1, theme: 0 });
    assert.equal(acc.pairs[0].confidence, "medium");
    assert.deepEqual(acc.byConfidence.map((c) => c.confidence), ["high", "medium", "low"]);
    assert.deepEqual(acc.byConfidence[1], { confidence: "medium", n: 1, meanAbsError: 1.4, bias: 1.4 });
    assert.deepEqual(acc.byConfidence[0], { confidence: "high", n: 0, meanAbsError: null, bias: null });
    assert.equal(acc.baselines.mean.n, 0);
    assert.equal(acc.baselines.mean.meanAbsError, null);
    assert.equal(acc.baselines.mean.claudeMeanAbsError, null);
    assert.deepEqual(acc.pairs[0].baselines, { mean: null, bggAvg: null });

    // Re-scoring later doesn't move the first-scored time.
    await t.call("PATCH", `/api/games/${g.id}`, { scores: { desire: 8 } });
    assert.equal(t.store.getGame(g.id).scoredAt, scoredAt);
  } finally {
    t.close();
  }
});

/**
 * A finished prediction from submission()'s scores (Tablescore 8.4), backdated
 * so it is always made before the game is scored.
 */
function addPrediction(store, target, overrides = {}) {
  const p = store.createPrediction({ name: "Predicted", model: "m", ...target });
  store.finishPrediction(p.id, {
    name: p.name, scoredGames: 1, scores: submission().scores, confidence: "medium", avoidTheme: false,
    avoidThemeReason: "", rationale: "", twoPlayer: "", sources: [], ...overrides,
  });
  store.db.prepare("UPDATE predictions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(p.id);
  return p.id;
}

/** Every bias in an accuracy report, so a test can check none is -0. */
function allBiases(acc) {
  return [acc.bias, ...acc.criteria.map((c) => c.bias), ...acc.byConfidence.map((c) => c.bias),
    acc.baselines.mean.bias, acc.baselines.bggAvg.bias];
}

test("accuracy: signed and absolute error differ, and the mean baseline judges each game against the others", () => {
  const store = openDb(":memory:");
  const a = store.createGame({ name: "A" });
  const b = store.createGame({ name: "B" });
  addPrediction(store, { gameId: a.id });
  addPrediction(store, { gameId: b.id }, { confidence: "high" });
  store.updateGame(a.id, { scores: { ...all(7), desire: 6 } }); // 7.0
  store.updateGame(b.id, { scores: all(9) }); // 10.0

  const acc = store.predictionAccuracy();
  assert.equal(acc.n, 2);
  assert.equal(acc.meanAbsError, 1.5);
  assert.equal(acc.bias, -0.1);
  const crit = Object.fromEntries(acc.criteria.map((c) => [c.key, c]));
  assert.deepEqual(crit.desire, { key: "desire", n: 2, meanAbsError: 1.5, bias: 0.5 });
  assert.deepEqual(crit.art, { key: "art", n: 2, meanAbsError: 2, bias: -2 });
  assert.deepEqual(crit.theme, { key: "theme", n: 2, meanAbsError: 1, bias: -1 });
  assert.deepEqual(acc.byConfidence[0], { confidence: "high", n: 1, meanAbsError: 1.6, bias: -1.6 });
  assert.deepEqual(acc.byConfidence[1], { confidence: "medium", n: 1, meanAbsError: 1.4, bias: 1.4 });
  assert.deepEqual(acc.byConfidence[2], { confidence: "low", n: 0, meanAbsError: null, bias: null });
  assert.deepEqual(acc.baselines.mean, { n: 2, meanAbsError: 3, bias: 0, claudeMeanAbsError: 1.5 });
  assert.deepEqual(acc.baselines.bggAvg, { n: 0, meanAbsError: null, bias: null, claudeMeanAbsError: null });
  const byName = Object.fromEntries(acc.pairs.map((x) => [x.name, x]));
  assert.equal(byName.A.baselines.mean, 10);
  assert.equal(byName.B.baselines.mean, 7);
  for (const x of allBiases(acc)) assert.ok(!Object.is(x, -0));
});

/** Ten games whose Tablescores sit on an exact line against their BGG averages. */
function lineOfGames(store, count = 10) {
  const levels = [1, 3, 5, 7, 9, 1, 3, 5, 7, 9]; // Tablescores 0, 2.5, 5, 7.5, 10
  for (let i = 0; i < count; i++) store.createGame({ name: `Fit ${i}`, bggAvg: levels[i], scores: all(levels[i]) });
}

test("accuracy: the BGG average baseline is a line fitted without the judged game", () => {
  const store = openDb(":memory:");
  lineOfGames(store);
  const t = store.createGame({ name: "Target", bggAvg: 7 });
  addPrediction(store, { gameId: t.id });
  store.updateGame(t.id, { scores: all(9) }); // 10.0

  const acc = store.predictionAccuracy();
  assert.equal(acc.n, 1);
  assert.equal(acc.pairs[0].baselines.bggAvg, 7.5);
  assert.deepEqual(acc.baselines.bggAvg, { n: 1, meanAbsError: 2.5, bias: -2.5, claudeMeanAbsError: 1.6 });
  assert.equal(acc.pairs[0].baselines.mean, 5);
  assert.equal(acc.baselines.mean.meanAbsError, 5);
});

test("accuracy: the BGG average baseline is left out with too few games or no BGG average, but the pair still counts", () => {
  const few = openDb(":memory:");
  lineOfGames(few, 9);
  const t = few.createGame({ name: "Target", bggAvg: 7 });
  addPrediction(few, { gameId: t.id });
  few.updateGame(t.id, { scores: all(9) });
  let acc = few.predictionAccuracy();
  assert.equal(acc.n, 1);
  assert.equal(acc.meanAbsError, 1.6);
  assert.equal(acc.pairs[0].baselines.bggAvg, null);
  assert.deepEqual(acc.baselines.bggAvg, { n: 0, meanAbsError: null, bias: null, claudeMeanAbsError: null });

  const noAvg = openDb(":memory:");
  lineOfGames(noAvg);
  const u = noAvg.createGame({ name: "Target" });
  addPrediction(noAvg, { gameId: u.id });
  noAvg.updateGame(u.id, { scores: all(9) });
  acc = noAvg.predictionAccuracy();
  assert.equal(acc.n, 1);
  assert.equal(acc.baselines.bggAvg.n, 0);

  // Equal BGG averages give no line.
  const flat = openDb(":memory:");
  for (let i = 0; i < 10; i++) flat.createGame({ name: `Fit ${i}`, bggAvg: 7, scores: all(i % 10) });
  const v = flat.createGame({ name: "Target", bggAvg: 7 });
  addPrediction(flat, { gameId: v.id });
  flat.updateGame(v.id, { scores: all(9) });
  assert.equal(flat.predictionAccuracy().baselines.bggAvg.n, 0);
});

test("accuracy skips a finished prediction with no scores instead of counting it as an error", () => {
  const store = openDb(":memory:");
  const g = store.createGame({ name: "A", bggId: 500 });
  store.db.prepare("INSERT INTO predictions (bgg_id, name, model, status, created_at) VALUES (500, 'Blank', 'm', 'done', '2020-01-01T00:00:00.000Z')").run();
  store.updateGame(g.id, { scores: all(7) });
  const acc = store.predictionAccuracy();
  assert.equal(acc.n, 0);
  assert.equal(acc.meanAbsError, null);
  assert.equal(acc.bias, null);
});

test("accuracy only takes a prediction by game id when it names no other BGG game", () => {
  // Left over from before ids stopped being reused: a deleted BGG game's
  // prediction sitting on a game with no BGG ID, which the clean-up at open
  // can't prove wrong.
  const store = openDb(":memory:");
  const g = store.createGame({ name: "No BGG" });
  store.db.prepare(`INSERT INTO predictions (bgg_id, game_id, name, model, status, created_at, ${CRITERIA_COLS})
    VALUES (777, ?, 'Gone', 'm', 'done', '2020-01-01T00:00:00.000Z', 1, 1, 1, 1, 1, 1, 1)`).run(g.id);
  store.updateGame(g.id, { scores: all(7) });
  assert.equal(store.predictionAccuracy().n, 0);

  // Its own prediction, made by game id, still pairs.
  addPrediction(store, { gameId: g.id });
  const acc = store.predictionAccuracy();
  assert.equal(acc.n, 1);
  assert.equal(acc.pairs[0].predicted, 8.4);
});

test("predictions left running by a restart are marked failed", () => {
  const store = openDb(":memory:");
  const p = store.createPrediction({ bggId: 1, name: "X", model: "m" });
  assert.equal(store.failRunningPredictions(), 1);
  assert.equal(store.getPrediction(p.id).status, "failed");
  assert.match(store.getPrediction(p.id).error, /restarted/);
});

test("latest predictions: one per game, the newest finished one, joined to the list by BGG ID", async () => {
  const t = await startApp();
  try {
    const add = (sql) => t.store.db.prepare(`INSERT INTO predictions (bgg_id, game_id, name, model, status, created_at) VALUES ${sql}`).run();
    const g = t.store.createGame({ name: "Brass: Extra", bggId: 500 });
    const local = t.store.createGame({ name: "No BGG" });
    // Predicted from search before it was added, then again from the game page, then a failed retry.
    add("(500, NULL, 'Brass: Extra', 'm', 'done', '2026-01-01T00:00:00.000Z')");
    add("(500, " + g.id + ", 'Brass: Extra', 'm', 'done', '2026-01-02T00:00:00.000Z')");
    add("(500, " + g.id + ", 'Brass: Extra', 'm', 'failed', '2026-01-03T00:00:00.000Z')");
    add("(600, NULL, 'Only failed', 'm', 'failed', '2026-01-04T00:00:00.000Z')");
    add("(NULL, " + local.id + ", 'No BGG', 'm', 'running', '2026-01-05T00:00:00.000Z')");
    // A deleted game with no BGG ID keeps its own row.
    add("(NULL, 999, 'Gone', 'm', 'done', '2026-01-06T00:00:00.000Z')");

    const { status, body } = await t.call("GET", "/api/predictions/latest");
    assert.equal(status, 200);
    const by = Object.fromEntries(body.map((p) => [p.name, p]));
    assert.equal(body.length, 4);
    assert.equal(by["Brass: Extra"].createdAt, "2026-01-02T00:00:00.000Z");
    assert.equal(by["Brass: Extra"].gameId, g.id);
    assert.equal(by["Brass: Extra"].count, 3);
    assert.equal(by["Only failed"].status, "failed");
    assert.equal(by["Only failed"].gameId, null);
    assert.equal(by["No BGG"].running, true);
    assert.equal(by["Gone"].gameId, null);
  } finally {
    t.close();
  }
});

// ---------- a deleted game's id is never reused while a prediction holds it ----------

test("a new game doesn't take the id of a deleted game whose prediction is still running", () => {
  const store = openDb(":memory:");
  const a = store.createGame({ name: "A" });
  store.createPrediction({ gameId: a.id, name: "A", model: "m" });
  store.deleteGame(a.id);
  const b = store.createGame({ name: "B" });
  assert.ok(b.id > a.id);
  assert.deepEqual(store.listPredictions({ gameId: b.id }), []);
  const latest = store.latestPredictions();
  assert.equal(latest.length, 1);
  assert.equal(latest[0].gameId, null);
});

test("a deleted game's prediction stays off the next game and attaches again when its BGG game is re-added", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    const a = t.store.createGame({ name: "Brass: Extra", bggId: 500 });
    await t.settle((await t.call("POST", "/api/predictions", { gameId: a.id })).body.id);
    assert.equal((await t.call("DELETE", `/api/games/${a.id}`, {})).status, 204);
    const b = (await t.call("POST", "/api/games", { name: "Other", bggId: 600 })).body;
    assert.deepEqual((await t.call("GET", `/api/predictions?gameId=${b.id}`)).body, []);
    let latest = (await t.call("GET", "/api/predictions/latest")).body;
    assert.equal(latest.length, 1);
    assert.equal(latest[0].gameId, null);

    const again = (await t.call("POST", "/api/games", { name: "Brass: Extra", bggId: 500 })).body;
    latest = (await t.call("GET", "/api/predictions/latest")).body;
    assert.equal(latest.length, 1);
    assert.equal(latest[0].gameId, again.id);
  } finally {
    t.close();
  }
});

test("accuracy doesn't pair a deleted game's prediction with the next game's Tablescore", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    const a = t.store.createGame({ name: "No BGG" });
    await t.settle((await t.call("POST", "/api/predictions", { gameId: a.id })).body.id);
    t.store.deleteGame(a.id);
    const b = t.store.createGame({ name: "Another" });
    await t.call("PATCH", `/api/games/${b.id}`, { scores: all(7) });
    assert.ok(t.store.getGame(b.id).scoredAt);
    assert.equal((await t.call("GET", "/api/predictions/accuracy")).body.n, 0);
  } finally {
    t.close();
  }
});

test("over HTTP, a game added after deleting one with a prediction gets a different id", async () => {
  const t = await startApp();
  try {
    const a = (await t.call("POST", "/api/games", { name: "A" })).body;
    t.store.createPrediction({ gameId: a.id, name: "A", model: "m" });
    assert.equal((await t.call("DELETE", `/api/games/${a.id}`, {})).status, 204);
    const b = await t.call("POST", "/api/games", { name: "B" });
    assert.equal(b.status, 201);
    assert.notEqual(b.body.id, a.id);
  } finally {
    t.close();
  }
});

test("with no predictions, game ids start at 1 as before", () => {
  const store = openDb(":memory:");
  assert.equal(store.createGame({ name: "First" }).id, 1);
  assert.equal(store.createGame({ name: "Second" }).id, 2);
});

test("a prediction keeps BGG's thumbnail, and older ones get it backfilled once", async () => {
  const thing = THING.replace("<yearpublished", "<thumbnail>https://img.example/500.jpg</thumbnail><yearpublished");
  const t = await startApp({ replies: [submitMsg()], thing });
  try {
    const p = await t.settle((await t.call("POST", "/api/predictions", { bggId: 500 })).body.id);
    assert.equal(p.thumbnail, "https://img.example/500.jpg");

    t.store.db.prepare("UPDATE predictions SET thumbnail = NULL").run();
    assert.deepEqual(t.store.predictionBggIdsWithoutThumbnail(), [500]);
    const list = (await t.call("GET", "/api/predictions/latest")).body;
    assert.equal(list[0].thumbnail, "https://img.example/500.jpg");
  } finally {
    t.close();
  }
});

test("the taste profile is a setting with a length limit", async () => {
  const t = await startApp();
  try {
    const ok = await t.call("PUT", "/api/settings", { tasteProfile: "Shared maps, cute art for my wife." });
    assert.equal(ok.body.tasteProfile, "Shared maps, cute art for my wife.");
    assert.equal((await t.call("PUT", "/api/settings", { tasteProfile: "x".repeat(4001) })).status, 400);
    assert.equal((await t.call("PUT", "/api/settings", { tasteProfile: 5 })).status, 400);
  } finally {
    t.close();
  }
});

// ---------- daily prediction cap ----------

test("a manual prediction over the daily cap gets a 429, makes no row and doesn't block the next one", async () => {
  const t = await startApp({ replies: [submitMsg()] });
  try {
    assert.equal((await t.call("PUT", "/api/settings", { dailyPredictionCap: 5 })).status, 200);
    // Failed predictions spent tokens too, so they count.
    for (let i = 0; i < 5; i++) {
      const p = t.store.createPrediction({ bggId: 900 + i, name: `G${i}`, model: "m" });
      if (i % 2) t.store.failPrediction(p.id, "boom");
    }
    const count = () => t.store.db.prepare("SELECT COUNT(*) AS n FROM predictions").get().n;
    const refused = await t.call("POST", "/api/predictions", { bggId: 500 });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, "Daily prediction cap reached (5 in 24 hours). Raise it in Settings or try again later.");
    assert.equal(count(), 5);
    const { budget } = (await t.call("GET", "/api/state")).body.claude;
    assert.equal(budget.used, 5);
    assert.equal(budget.left, 0);
    assert.ok(budget.freesAt);

    // Lowering the cap below what is used never shows a negative number left.
    t.store.setSettings({ dailyPredictionCap: 5 });
    t.store.createPrediction({ bggId: 950, name: "Extra", model: "m" });
    assert.equal((await t.call("GET", "/api/state")).body.claude.budget.left, 0);

    // Once those rows are older than 24 hours, the cap is free again.
    t.store.db.prepare("UPDATE predictions SET created_at = ?").run(new Date(Date.now() - 25 * 3600000).toISOString());
    const ok = await t.call("POST", "/api/predictions", { bggId: 500 });
    assert.equal(ok.status, 202);
    assert.equal((await t.settle(ok.body.id)).status, "done");
  } finally {
    t.close();
  }
});

test("the daily prediction cap is a whole-number setting from 5 to 100", async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call("GET", "/api/state")).body.settings.dailyPredictionCap, 30);
    for (const bad of [4, 101, 7.5, "30"]) {
      assert.equal((await t.call("PUT", "/api/settings", { dailyPredictionCap: bad })).status, 400, `rejects ${bad}`);
    }
    assert.equal((await t.call("PUT", "/api/settings", { dailyPredictionCap: 5 })).body.dailyPredictionCap, 5);
    assert.equal((await t.call("PUT", "/api/settings", { dailyPredictionCap: 100 })).body.dailyPredictionCap, 100);
    assert.equal((await t.call("GET", "/api/state")).body.claude.budget.cap, 100);
  } finally {
    t.close();
  }
});
