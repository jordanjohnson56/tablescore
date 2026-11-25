import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrollMemory, goesBack, isDetail, screenKey } from "../public/js/nav.js";

test("screenKey names the screen route() draws for a hash", () => {
  const rows = [
    ["", "#/"],
    ["#/", "#/"],
    ["#/games", "#/"],
    ["#/nonsense", "#/"],
    ["#/watchlist", "#/watchlist"],
    ["#/discover", "#/discover"],
    ["#/summary", "#/summary"],
    ["#/settings", "#/settings"],
    ["#/add", "#/discover"],
    ["#/predictions", "#/discover"],
    ["#/g/12", "#/g/12"],
    ["#/predict/game/7", "#/predict/game/7"],
    ["#/predict/bgg/5?name=Brass%20Birmingham", "#/predict/bgg/5"],
  ];
  for (const [hash, key] of rows) assert.equal(screenKey(hash), key, hash);
});

test("isDetail is true for game and prediction pages only", () => {
  assert.equal(isDetail("#/g/3"), true);
  assert.equal(isDetail("#/predict/bgg/5"), true);
  assert.equal(isDetail("#/"), false);
  assert.equal(isDetail("#/watchlist"), false);
  assert.equal(isDetail("#/discover"), false);
});

/** Walk a memory through a list of hashes, leaving each at the given y; returns each arrival's y. */
function walk(memory, steps) {
  const ys = [];
  for (let i = 1; i < steps.length; i++) {
    const [from, y] = steps[i - 1];
    const [to] = steps[i];
    memory.leave(from, to, y);
    ys.push(memory.arrive(from, to));
  }
  return ys;
}

test("Games list, game, Games list returns to the saved position", () => {
  assert.deepEqual(walk(createScrollMemory(), [["#/", 900], ["#/g/1", 0], ["#/"]]), [0, 900]);
});

test("the position survives several game pages in a row (the Update BGG chain)", () => {
  assert.deepEqual(walk(createScrollMemory(), [["#/", 900], ["#/g/1", 40], ["#/g/2", 80], ["#/"]]), [0, 0, 900]);
});

test("Games list, Watchlist tab, Games tab starts at the top and forgets the position", () => {
  const memory = createScrollMemory();
  assert.deepEqual(walk(memory, [["#/", 900], ["#/watchlist", 0], ["#/"]]), [0, 0]);
  // Nothing is left to restore through a game page either.
  assert.deepEqual(walk(memory, [["#/", 0], ["#/g/1", 0], ["#/"]]), [0, 0]);
});

test("a position is forgotten after leaving the list for another tab, even from a game page", () => {
  const memory = createScrollMemory();
  walk(memory, [["#/", 900], ["#/g/1", 0], ["#/", 900], ["#/summary", 0]]);
  assert.deepEqual(walk(memory, [["#/summary", 0], ["#/g/1", 0], ["#/"]]), [0, 0]);
});

test("the Games list and the Watchlist keep separate positions", () => {
  const memory = createScrollMemory();
  walk(memory, [["#/", 900], ["#/g/1", 0], ["#/watchlist", 300], ["#/g/2", 0]]);
  assert.equal(memory.arrive("#/g/2", "#/watchlist"), 300);
  assert.equal(memory.arrive("#/g/2", "#/"), 900);
});

test("game and prediction pages always open at the top", () => {
  const memory = createScrollMemory();
  memory.leave("#/", "#/g/1", 900);
  assert.equal(memory.arrive("#/", "#/g/1"), 0);
  assert.equal(memory.arrive("#/g/1", "#/g/1"), 0);
  assert.equal(memory.arrive("#/g/1", "#/predict/game/1"), 0);
  assert.equal(memory.arrive("#/discover", "#/predict/bgg/5?name=X"), 0);
});

test("Discover and Settings never restore", () => {
  const memory = createScrollMemory();
  assert.deepEqual(walk(memory, [["#/discover", 700], ["#/predict/bgg/5?name=X", 0], ["#/discover"]]), [0, 0]);
  assert.deepEqual(walk(memory, [["#/settings", 700], ["#/g/1", 0], ["#/settings"]]), [0, 0]);
});

test("the empty hash and #/games share the Games list position", () => {
  const memory = createScrollMemory();
  memory.leave("", "#/g/1", 500);
  assert.equal(memory.arrive("#/g/1", "#/games"), 500);
});

test("goesBack only when the entry beneath is the arrow's screen", () => {
  assert.equal(goesBack(null, "#/"), false);
  assert.equal(goesBack(undefined, "#/"), false);
  assert.equal(goesBack({ from: null }, "#/"), false);
  assert.equal(goesBack({ from: "" }, "#/"), true);
  assert.equal(goesBack({ from: "#/" }, "#/"), true);
  assert.equal(goesBack({ from: "#/games" }, "#/"), true);
  assert.equal(goesBack({ from: "#/summary" }, "#/"), false);
  assert.equal(goesBack({ from: "#/discover" }, "#/discover"), true);
  assert.equal(goesBack({ from: "#/g/5" }, "#/g/5"), true);
  assert.equal(goesBack({ from: "#/g/5" }, "#/g/6"), false);
});
