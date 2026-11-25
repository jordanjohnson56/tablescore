import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../public/js/api.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Stub fetch with one response, recording what it was asked for.
function stub(status, body) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return seen;
}

test("an HTTP error carries its status and the server's message", async () => {
  stub(400, { error: "predictedScore must be 0-10" });
  await assert.rejects(api.patch("/api/games/1", { predictedScore: 11 }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.message, "predictedScore must be 0-10");
    return true;
  });
});

test("a rejected fetch has no status", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(api.patch("/api/games/1", { plays: 1 }), (err) => err.status === undefined);
});

test("keepalive is passed to fetch only when asked", async () => {
  const seen = stub(200, { id: 1 });
  await api.patch("/api/games/1", { plays: 1 });
  await api.patch("/api/games/1", { plays: 2 }, { keepalive: true });
  assert.equal("keepalive" in seen[0].init, false);
  assert.equal(seen[1].init.keepalive, true);
  assert.equal(seen[1].init.body, JSON.stringify({ plays: 2 }));
});

test("204 gives null", async () => {
  stub(204);
  assert.equal(await api.del("/api/games/1"), null);
});
