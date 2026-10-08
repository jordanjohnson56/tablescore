import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRITERIA, finalScore, rawAverage, rescoreStatus, bandIndex, spread, DEFAULT_SETTINGS, weightTotal,
} from "../public/js/rubric.js";

const vec = (xs) => Object.fromEntries(CRITERIA.map((c, i) => [c.key, xs[i]]));

// Criterion inputs (in CRITERIA order) and the New Score the v2 spreadsheet computed
// for them, including two x.x5 cases where Excel's ROUND goes up.
const SHEET_CASES = [
  [[9, 3, 9, 10, 10, 6, 10], 8.8],
  [[10, 7, 10, 7, 7, 7, 6], 9.3],
  [[9, 4, 9, 10, 9, 9, 8], 9.1],
  [[8, 8, 10, 7, 8, 7, 7], 8.7],
  [[7, 8, 7, 4, 7, 10, 6], 7.6],
  [[7, 8, 6, 6, 6, 8, 4], 7.3],
  [[8, 6, 3, 8, 5, 10, 4], 7.4],
  [[8, 7, 6, 3, 7, 10, 7], 7.8],
  [[7, 9, 8, 8, 8, 7, 7], 8.3],
  [[7, 8, 6, 8, 6, 5, 5], 7.2],
  [[6, 7, 6, 3, 5, 8, 4], 6.1],
  [[5, 5, 7, 6, 8, 7, 7], 6.1],
  [[4, 4, 8, 6, 9, 6, 1], 5.2],
  [[1, 1, 6, 3, 6, 6, 4], 2.3],
  [[3, 5, 3, 3, 4, 4, 3], 3.1],
];
const sample = vec([9, 4, 9, 10, 9, 9, 8]);

test("default weights total 100", () => {
  assert.equal(weightTotal(DEFAULT_SETTINGS.weights), 100);
});

test("reproduces the spreadsheet's New Score", () => {
  for (const [xs, want] of SHEET_CASES) assert.equal(finalScore(vec(xs)), want, xs.join(","));
});

test("score is null until all 7 criteria are entered", () => {
  const partial = { ...sample, theme: null };
  assert.equal(rawAverage(partial), null);
  assert.equal(finalScore(partial), null);
  assert.equal(rescoreStatus(partial), "Partial (6/7)");
  assert.equal(rescoreStatus({}), "Not yet rescored");
});

test("stretch is clamped to 0-10", () => {
  const all = (v) => Object.fromEntries(Object.keys(DEFAULT_SETTINGS.weights).map((k) => [k, v]));
  assert.equal(finalScore(all(10), { ...DEFAULT_SETTINGS, stretch: 3 }), 10);
  assert.equal(finalScore(all(0), { ...DEFAULT_SETTINGS, stretch: 3 }), 0);
  assert.equal(finalScore(all(5)), 5);
});

test("weights need not total 100 for the math to stay an average", () => {
  const s = { ...sample };
  const doubled = { ...DEFAULT_SETTINGS, weights: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.weights).map(([k, v]) => [k, v * 2])) };
  assert.equal(finalScore(s, doubled), finalScore(s));
});

test("band boundaries follow the Legend", () => {
  assert.deepEqual([10, 9, 8.9, 7, 6.5, 5, 4, 3, 2.9, 0].map(bandIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test("spread stats", () => {
  const s = spread([9, 7, 5, null]);
  assert.equal(s.n, 3);
  assert.equal(s.mean, 7);
  assert.equal(s.median, 7);
  assert.equal(s.sd, 2);
  assert.ok(Math.abs(s.pct9 - 1 / 3) < 1e-12);
});
