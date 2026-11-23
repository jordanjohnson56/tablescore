import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_MS, canRefresh, isEditable, isStale, repaintsAfterRefresh, syncStep, syncToast } from "../public/js/refresh.js";

test("state is stale after a minute, and always when it was never loaded", () => {
  assert.equal(STALE_MS, 60_000);
  const t = 1_000_000;
  assert.equal(isStale(t, t + 59_000), false);
  assert.equal(isStale(t, t + 61_000), true);
  assert.equal(isStale(0, t), true);
});

test("inputs, selects, textareas and contenteditable count as editable; buttons, links and body do not", () => {
  for (const tagName of ["INPUT", "SELECT", "TEXTAREA"]) assert.equal(isEditable({ tagName }), true, tagName);
  assert.equal(isEditable({ tagName: "DIV", isContentEditable: true }), true);
  for (const tagName of ["BUTTON", "A", "BODY"]) assert.equal(isEditable({ tagName }), false, tagName);
  assert.equal(isEditable(null), false);
  assert.equal(isEditable(undefined), false);
});

test("a refresh waits while an edit is unsent or a field has focus", () => {
  assert.equal(canRefresh({ busy: true, focused: null }), false);
  assert.equal(canRefresh({ busy: false, focused: { tagName: "INPUT" } }), false);
  assert.equal(canRefresh({ busy: false, focused: { tagName: "BUTTON" } }), true);
  assert.equal(canRefresh({ busy: false, focused: null }), true);
});

test("the Games list, game page, Watchlist and Summary repaint; Discover, Settings and predictions do not", () => {
  for (const h of ["", "#/", "#/games", "#/g/12", "#/watchlist", "#/summary"]) assert.equal(repaintsAfterRefresh(h), true, h);
  for (const h of ["#/discover", "#/settings", "#/predict/game/3", "#/predict/bgg/13?name=Catan"]) {
    assert.equal(repaintsAfterRefresh(h), false, h);
  }
});

const idle = (finishedAt = null, extra = {}) => ({ running: false, finishedAt, error: null, result: null, ...extra });
const running = (finishedAt = null) => ({ running: true, finishedAt, error: null, result: null });

/** Feed jobs through syncStep in turn and return which steps finished. */
function finishes(jobs) {
  let seen = null;
  return jobs.map((job) => {
    const step = syncStep(seen, job);
    seen = step.seen;
    return step.finished;
  });
}

test("the first look at a sync only records it, even a finished one", () => {
  assert.deepEqual(finishes([idle()]), [false]);
  assert.deepEqual(finishes([idle("2026-11-01T10:00:00Z", { result: {} })]), [false]);
});

test("a sync seen running and then done finishes once", () => {
  const done = idle("2026-11-23T10:00:00Z", { result: { added: 1 } });
  assert.deepEqual(finishes([idle(), running(), running(), done, done]), [false, false, false, true, false]);
});

test("a new finishedAt finishes even if the sync was never seen running", () => {
  const a = idle("2026-11-23T10:00:00Z", { result: {} });
  const b = idle("2026-11-23T11:00:00Z", { result: {} });
  assert.deepEqual(finishes([a, a, b]), [false, false, true]);
});

test("a failed sync finishes too", () => {
  assert.deepEqual(finishes([idle(), running(), idle("2026-11-23T10:00:00Z", { error: "BGG down" })]), [false, false, true]);
});

test("a server restart, which clears finishedAt, is not a finish", () => {
  assert.deepEqual(finishes([idle("2026-11-23T10:00:00Z"), idle(null)]), [false, false]);
  assert.deepEqual(finishes([running(), idle(null)]), [false, false]);
});

test("the sync toast gives the counts, or the error", () => {
  assert.equal(syncToast(idle("x", { result: { collection: 40, added: 3, updated: 12, linked: 0, enriched: 2 } })), "BGG sync finished: 3 new, 12 updated");
  assert.equal(syncToast(idle("x", { error: "BGG returned HTTP 500" })), "BGG sync failed: BGG returned HTTP 500");
});
