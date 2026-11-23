import { test } from "node:test";
import assert from "node:assert/strict";
import { latestOnly, SUPERSEDED } from "../public/js/latest.js";

/** A run function whose calls are settled by hand. */
function manual() {
  const started = [];
  const run = (x) => new Promise((resolve, reject) => started.push({ x, resolve, reject }));
  return { run, started };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("one call runs at a time", async () => {
  const { run, started } = manual();
  const latest = latestOnly(run);
  const a = latest("cat");
  const b = latest("cata");
  await tick();
  assert.deepEqual(started.map((s) => s.x), ["cat"]);
  started[0].resolve("A");
  assert.equal(await a, "A");
  await tick();
  assert.deepEqual(started.map((s) => s.x), ["cat", "cata"]);
  started[1].resolve("B");
  assert.equal(await b, "B");
});

test("of the calls made while one runs, only the newest runs next", async () => {
  const { run, started } = manual();
  const latest = latestOnly(run);
  const first = latest("c");
  const waiting = [latest("ca"), latest("cat"), latest("catan")];
  assert.equal(await waiting[0], SUPERSEDED);
  assert.equal(await waiting[1], SUPERSEDED);
  started[0].resolve("C");
  assert.equal(await first, "C");
  await tick();
  assert.deepEqual(started.map((s) => s.x), ["c", "catan"]);
  started[1].resolve("CATAN");
  assert.equal(await waiting[2], "CATAN");
});

test("a rejection reaches its caller and doesn't block the next call", async () => {
  const { run, started } = manual();
  const latest = latestOnly(run);
  const a = latest("x");
  const b = latest("y");
  await tick();
  started[0].reject(new Error("BGG down"));
  await assert.rejects(a, /BGG down/);
  await tick();
  assert.equal(started.length, 2);
  started[1].resolve("Y");
  assert.equal(await b, "Y");
});

test("drop forgets the waiting call", async () => {
  const { run, started } = manual();
  const latest = latestOnly(run);
  const a = latest("x");
  const b = latest("y");
  latest.drop();
  assert.equal(await b, SUPERSEDED);
  started[0].resolve("X");
  assert.equal(await a, "X");
  await tick();
  assert.equal(started.length, 1);
});
