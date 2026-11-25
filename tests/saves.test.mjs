import { test } from "node:test";
import assert from "node:assert/strict";
import { applySaved, createSaveQueue, mergeGames } from "../public/js/saves.js";

// Hand-driven timers: advance(ms) runs every timer due by then, in order.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      timers.set(++seq, { fn, at: now + ms });
      return seq;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await tick();
      }
      now = end;
    },
    get size() {
      return timers.size;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

// A queue over a fake client whose PATCHes the test settles by hand.
function setup(opts = {}) {
  const timers = fakeTimers();
  const calls = [];
  const applied = [];
  const rejected = [];
  const states = [];
  const q = createSaveQueue({
    patch: (id, body, o) =>
      new Promise((resolve, reject) => calls.push({ id, body, keepalive: o?.keepalive, resolve, reject })),
    apply: (id, saved, unsent) => applied.push({ id, saved, unsent }),
    onState: (s) => states.push(s),
    onReject: (id, err) => rejected.push({ id, message: err.message }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...opts,
  });
  const ok = async (i = calls.length - 1, saved = { id: calls[i].id }) => {
    calls[i].resolve(saved);
    await tick();
  };
  const fail = async (i = calls.length - 1, err = new TypeError("Failed to fetch")) => {
    calls[i].reject(err);
    await tick();
  };
  return { q, timers, calls, applied, rejected, states, ok, fail };
}

test("edits inside the delay go as one PATCH, with scores merged per criterion", async () => {
  const { q, timers, calls } = setup();
  q.queue(1, { scores: { strategy: 7 } });
  q.queue(1, { scores: { theme: 8 }, plays: 2 });
  q.queue(1, { scores: { strategy: 7.5 } });
  await timers.advance(449);
  assert.equal(calls.length, 0);
  await timers.advance(1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { scores: { strategy: 7.5, theme: 8 }, plays: 2 });
});

test("a network failure keeps the body, shows an error, and the retry sends the same body", async () => {
  const { q, timers, calls, fail } = setup();
  q.queue(1, { notes: "hi", scores: { theme: 6 } });
  await timers.advance(450);
  assert.equal(q.state(), "saving");
  await fail();
  assert.equal(q.state(), "error");
  assert.deepEqual(q.unsent(1), { notes: "hi", scores: { theme: 6 } });
  await timers.advance(2000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body);
});

test("5xx, 408 and 429 are retried like a dropped connection", async () => {
  for (const status of [500, 502, 408, 429]) {
    const { q, timers, calls, fail, rejected } = setup();
    q.queue(1, { plays: 3 });
    await timers.advance(450);
    await fail(0, httpError(status));
    assert.equal(q.state(), "error", `status ${status}`);
    await timers.advance(2000);
    assert.equal(calls.length, 2, `status ${status}`);
    assert.equal(rejected.length, 0);
  }
});

test("an edit after a failure merges over the failed body and sends it", async () => {
  const { q, timers, calls, fail } = setup();
  q.queue(1, { notes: "old", status: "Owned", scores: { theme: 6, strategy: 5 } });
  await timers.advance(450);
  await fail();
  q.queue(1, { notes: "new", scores: { strategy: 9 } });
  await timers.advance(450); // the next edit retries without waiting for the backoff
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { notes: "new", status: "Owned", scores: { theme: 6, strategy: 9 } });
});

test("the state is never saved while any game has an edit queued, in flight or awaiting retry", async () => {
  const { q, timers, calls, ok, fail, states } = setup();
  assert.equal(q.state(), "saved");
  assert.equal(q.busy(), false);
  q.queue(1, { plays: 1 });
  await timers.advance(450);
  await fail(0);
  q.queue(2, { plays: 2 });
  await timers.advance(450);
  await ok(1);
  assert.equal(q.state(), "error"); // game 2 saved, game 1 still waits
  q.queue(3, { plays: 3 });
  await timers.advance(450);
  await timers.advance(2000); // game 1 retries
  await ok(calls.findIndex((c) => c.id === 1 && c !== calls[0]));
  assert.equal(q.state(), "saving"); // game 3 still in flight
  assert.equal(q.busy(), true);
  await ok(calls.findIndex((c) => c.id === 3));
  assert.equal(q.state(), "saved");
  assert.equal(q.busy(), false);
  assert.ok(!states.slice(0, -1).includes("saved"));
});

test("a second PATCH for a game waits for the first, and apply gets the edits made meanwhile", async () => {
  const { q, timers, calls, applied, ok } = setup();
  q.queue(1, { scores: { theme: 6 } });
  await timers.advance(450);
  q.queue(1, { scores: { strategy: 8 }, notes: "x" });
  await timers.advance(5000);
  assert.equal(calls.length, 1);
  await ok(0, { id: 1, scores: { theme: 6, strategy: null }, notes: "" });
  assert.deepEqual(applied[0].unsent, { scores: { strategy: 8 }, notes: "x" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { scores: { strategy: 8 }, notes: "x" });
});

test("a 400 on a multi-field body sends each field alone and drops only the bad one", async () => {
  const { q, timers, calls, rejected, ok, fail } = setup();
  q.queue(1, { targetPrice: 40, predictedScore: 7.25, scores: { theme: 6, strategy: 7 } });
  await timers.advance(450);
  await fail(0, httpError(400, "predictedScore must be 0-10 in steps of 0.1"));
  assert.equal(rejected.length, 0);
  const sent = [];
  for (let i = 1; i < 10 && calls.length > i; i++) {
    sent.push(calls[i].body);
    if ("predictedScore" in calls[i].body) await fail(i, httpError(400, "predictedScore must be 0-10 in steps of 0.1"));
    else await ok(i);
  }
  assert.deepEqual(sent, [{ targetPrice: 40 }, { predictedScore: 7.25 }, { scores: { theme: 6 } }, { scores: { strategy: 7 } }]);
  assert.deepEqual(rejected, [{ id: 1, message: "predictedScore must be 0-10 in steps of 0.1" }]);
  await timers.advance(60000);
  assert.equal(calls.length, 5); // never retried
  assert.equal(q.state(), "saved");
});

test("after a rejected field, later edits to that game save normally", async () => {
  const { q, timers, calls, rejected, ok, fail } = setup();
  q.queue(1, { predictedScore: 7.25 });
  await timers.advance(450);
  await fail(0, httpError(400, "bad"));
  assert.equal(rejected.length, 1);
  q.queue(1, { targetPrice: 30 });
  await timers.advance(450);
  assert.deepEqual(calls[1].body, { targetPrice: 30 });
  await ok(1);
  assert.equal(q.state(), "saved");
});

test("a 404 drops everything queued for that game, with no retry", async () => {
  const { q, timers, calls, rejected, fail } = setup();
  q.queue(1, { plays: 1, notes: "a" });
  await timers.advance(450);
  q.queue(1, { notes: "b" });
  await fail(0, httpError(404, "game not found"));
  assert.deepEqual(rejected, [{ id: 1, message: "game not found" }]);
  assert.deepEqual(q.unsent(1), {});
  await timers.advance(60000);
  assert.equal(calls.length, 1);
  assert.equal(q.state(), "saved");
});

test("retry() and the backoff timer both resend, and success resets the backoff", async () => {
  const { q, timers, calls, ok, fail } = setup();
  q.queue(1, { plays: 1 });
  await timers.advance(450);
  await fail(0); // backoff 2 s
  await timers.advance(2000);
  assert.equal(calls.length, 2);
  await fail(1); // backoff 5 s
  await timers.advance(4999);
  assert.equal(calls.length, 2);
  q.retry();
  assert.equal(calls.length, 3);
  await fail(2); // backoff 15 s
  await timers.advance(15000);
  assert.equal(calls.length, 4);
  await fail(3); // backoff 30 s, and every 30 s after
  await timers.advance(30000);
  await fail(4);
  await timers.advance(30000);
  assert.equal(calls.length, 6);
  await ok(5);
  assert.equal(q.state(), "saved");
  q.queue(1, { plays: 2 });
  await timers.advance(450);
  await fail(6); // back to 2 s
  await timers.advance(2000);
  assert.equal(calls.length, 8);
});

test("flushAll({ keepalive: true }) sends every queued and retry-waiting body with the flag", async () => {
  const { q, timers, calls, fail } = setup();
  q.queue(1, { plays: 1 });
  await timers.advance(450);
  await fail(0); // game 1 waits to retry
  q.queue(2, { notes: "x".repeat(70000) }); // over the keepalive limit
  q.queue(3, { plays: 3 });
  q.flushAll({ keepalive: true });
  assert.deepEqual(calls.slice(1).map((c) => [c.id, c.keepalive]), [[1, true], [2, false], [3, true]]);
  await timers.advance(60000);
  assert.equal(calls.length, 4); // the timers went with the flush
});

test("retries never use keepalive", async () => {
  const { q, timers, calls, fail } = setup();
  q.queue(1, { plays: 1 });
  q.flushAll({ keepalive: true });
  await fail(0);
  await timers.advance(2000);
  assert.equal(calls[1].keepalive, false);
});

test("drop(id) cancels the timer, and a late response does not call apply", async () => {
  const { q, timers, calls, applied, ok } = setup();
  q.queue(1, { plays: 1 });
  q.drop(1);
  await timers.advance(1000);
  assert.equal(calls.length, 0);
  q.queue(2, { plays: 2 });
  await timers.advance(450);
  q.drop(2);
  assert.equal(q.state(), "saved");
  await ok(0);
  assert.equal(applied.length, 0);
  assert.equal(timers.size, 0);
});

test("unsent(id) includes the body in flight, so a reload keeps it", async () => {
  const { q, timers } = setup();
  q.queue(1, { scores: { theme: 6 } });
  await timers.advance(450);
  q.queue(1, { scores: { strategy: 8 } });
  assert.deepEqual(q.unsent(1), { scores: { theme: 6, strategy: 8 } });
  assert.deepEqual(q.unsent(99), {});
});

test("onState reports each change once", async () => {
  const { q, timers, states, ok, fail } = setup();
  q.queue(1, { plays: 1 });
  q.queue(1, { plays: 2 });
  await timers.advance(450);
  await fail(0);
  await timers.advance(2000);
  await ok(1);
  assert.deepEqual(states, ["saving", "error", "saved"]);
});

test("applySaved updates the same object and keeps unsent fields", () => {
  const game = { id: 1, notes: "typed", plays: 1, scores: { theme: 6, strategy: 7 } };
  const scores = game.scores;
  const out = applySaved(game, { id: 1, notes: "", plays: 4, status: "Owned", scores: { theme: 6, strategy: null } }, {
    notes: "typed",
    scores: { strategy: 7 },
  });
  assert.equal(out, game);
  assert.deepEqual(game, { id: 1, notes: "typed", plays: 4, status: "Owned", scores: { theme: 6, strategy: 7 } });
  assert.equal(scores.theme, 6); // the old scores object is not shared with the server copy
});

test("mergeGames keeps existing game objects, adds new ones and drops missing ones", () => {
  const a = { id: 1, plays: 1, scores: {} };
  const b = { id: 2, plays: 2, scores: {} };
  const out = mergeGames([a, b], [{ id: 1, plays: 5, scores: { theme: 3 } }, { id: 3, plays: 0, scores: {} }], (id) =>
    id === 1 ? { scores: { theme: 4 } } : {},
  );
  assert.equal(out[0], a);
  assert.deepEqual(a, { id: 1, plays: 5, scores: { theme: 4 } });
  assert.deepEqual(out.map((g) => g.id), [1, 3]);
});
