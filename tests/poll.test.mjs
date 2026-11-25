import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedPoll } from "../public/js/poll.js";

/** Hand-written timers that record which intervals are alive. */
function fakeTimers() {
  let next = 1;
  const live = new Map();
  return {
    live,
    setInterval(fn, ms) { const id = next++; live.set(id, { fn, ms }); return id; },
    clearInterval(id) { live.delete(id); },
  };
}

test("a claimed owner can start, and a second start makes no second interval", () => {
  const t = fakeTimers();
  const poll = sharedPoll(15000, t);
  const me = {};
  poll.claim(me);
  poll.start(me, () => {});
  poll.start(me, () => {});
  assert.equal(t.live.size, 1);
  assert.equal([...t.live.values()][0].ms, 15000);
  assert.equal(poll.active, true);
});

test("start, stop, start again makes a new interval", () => {
  const t = fakeTimers();
  const poll = sharedPoll(15000, t);
  const me = {};
  poll.claim(me);
  poll.start(me, () => {});
  poll.stop(me);
  assert.equal(t.live.size, 0);
  assert.equal(poll.active, false);
  poll.start(me, () => {});
  assert.equal(t.live.size, 1);
  assert.equal(poll.active, true);
});

test("a new owner's claim clears the previous owner's interval", () => {
  const t = fakeTimers();
  const poll = sharedPoll(15000, t);
  const old = {};
  poll.claim(old);
  poll.start(old, () => {});
  poll.claim({});
  assert.equal(t.live.size, 0);
  assert.equal(poll.active, false);
});

test("a past owner's stop leaves the current owner's interval running", () => {
  const t = fakeTimers();
  const poll = sharedPoll(15000, t);
  const old = {};
  const me = {};
  poll.claim(old);
  poll.claim(me);
  poll.start(me, () => {});
  poll.stop(old);
  assert.equal(t.live.size, 1);
  assert.equal(poll.active, true);
});

test("a past owner's start makes nothing", () => {
  const t = fakeTimers();
  const poll = sharedPoll(15000, t);
  const old = {};
  poll.claim(old);
  poll.claim({});
  poll.start(old, () => {});
  assert.equal(t.live.size, 0);
  assert.equal(poll.active, false);
});

test("stop with nothing running is harmless", () => {
  const t = fakeTimers();
  const poll = sharedPoll(15000, t);
  const me = {};
  assert.equal(poll.active, false);
  poll.stop(me);
  poll.claim(me);
  poll.stop(me);
  assert.equal(poll.active, false);
  assert.equal(t.live.size, 0);
});
