import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITERIA, DEFAULT_SETTINGS } from "../public/js/rubric.js";
import { claudeExport, summaryStats, visibleGames } from "../public/js/watchlist.js";

const base = { type: "Base Game", scores: {}, plays: 0, status: "", avoidTheme: false, bggRating: null };
const game = (name, extra = {}) => ({ ...base, name, ...extra });
const vec = (xs) => Object.fromEntries(CRITERIA.map((c, i) => [c.key, xs[i]]));

test("the main list shows expansions unless hideExpansions is on", () => {
  const games = [game("Brass"), game("Brass: Expansion", { type: "Expansion" })];
  const names = (settings) => visibleGames(games, settings).map((g) => g.name);
  assert.deepEqual(names(DEFAULT_SETTINGS), ["Brass", "Brass: Expansion"]);
  assert.deepEqual(names({ ...DEFAULT_SETTINGS, hideExpansions: true }), ["Brass"]);
});

test("the main list leaves out watched games", () => {
  const games = [game("Brass"), game("Bookwyrm", { watchStage: "campaign" }), game("Passed", { watchStage: "pass" })];
  assert.deepEqual(visibleGames(games, DEFAULT_SETTINGS).map((g) => g.name), ["Brass"]);
});

test("the main list shows watched games when includeWatching is on", () => {
  const games = [game("Brass"), game("Bookwyrm", { watchStage: "campaign" }), game("Watched exp", { type: "Expansion", watchStage: "awaiting" })];
  const names = (settings) => visibleGames(games, settings).map((g) => g.name);
  assert.deepEqual(names({ ...DEFAULT_SETTINGS, includeWatching: true }), ["Brass", "Bookwyrm", "Watched exp"]);
  assert.deepEqual(names({ ...DEFAULT_SETTINGS, includeWatching: true, hideExpansions: true }), ["Brass", "Bookwyrm"]);
});

test("Claude export leaves out watched games", () => {
  const watched = game("Excursions", { watchStage: "reviews", scores: vec([9, 9, 9, 9, 9, 9, 9]), bggRating: 8 });
  assert.deepEqual(claudeExport([...COLLECTION, watched], DEFAULT_SETTINGS), claudeExport(COLLECTION, DEFAULT_SETTINGS));
});

// A small collection covering each kind of export line. Scores come from the
// rubric tests' spreadsheet cases (9.1, 7.6 and 6.1).
const COLLECTION = [
  game("Pax Pamir", { scores: vec([7, 8, 7, 4, 7, 10, 6]), plays: 2, status: "Owned", avoidTheme: true }),
  game("Brass: Birmingham", { scores: vec([9, 4, 9, 10, 9, 9, 8]), plays: 12, status: "Owned" }),
  game("Ark Nova", { bggRating: 7.5, status: "Wishlist" }),
  game("Azul", { bggRating: 8 }),
  game("Unrated", {}),
  game("Brass: Iron Clays", { type: "Expansion", scores: vec([5, 5, 7, 6, 8, 7, 7]), plays: 1 }),
];
const HEADER = [
  "My board game ratings from my Tablescore rubric (weights: Desire to Play 40, Table Appeal 15, Decision Depth & Tension 10, Interaction Quality 10, Replayability & Strategic Variety 10, Art & Production 10, Theme & Narrative 5; stretch 1.25).",
  "Scored games (final score | criteria in that order | plays | status | avoid-theme):",
];

test("Claude export lists scored games by score, then unscored games by BGG rating", () => {
  const out = claudeExport(COLLECTION, DEFAULT_SETTINGS);
  assert.equal(out.text, [
    ...HEADER,
    "- Brass: Birmingham: 9.1 | 9/4/9/10/9/9/8 | 12 plays | Owned",
    "- Pax Pamir: 7.6 | 7/8/7/4/7/10/6 | 2 plays | Owned | AVOID THEME",
    "- Brass: Iron Clays: 6.1 | 5/5/7/6/8/7/7 | 1 plays | -",
    "",
    "Not yet rescored (old BGG rating):",
    "- Azul: 8.0",
    "- Ark Nova: 7.5 (Wishlist)",
  ].join("\n"));
  assert.equal(out.scored, 3);
  assert.equal(out.rest, 2);
});

test("Claude export leaves hidden expansions out", () => {
  const out = claudeExport(COLLECTION, { ...DEFAULT_SETTINGS, hideExpansions: true });
  assert.equal(out.text, [
    ...HEADER,
    "- Brass: Birmingham: 9.1 | 9/4/9/10/9/9/8 | 12 plays | Owned",
    "- Pax Pamir: 7.6 | 7/8/7/4/7/10/6 | 2 plays | Owned | AVOID THEME",
    "",
    "Not yet rescored (old BGG rating):",
    "- Azul: 8.0",
    "- Ark Nova: 7.5 (Wishlist)",
  ].join("\n"));
  assert.equal(out.scored, 2);
});

test("Claude export has no unscored section when no unscored game has a BGG rating", () => {
  const out = claudeExport([COLLECTION[1], COLLECTION[4]], DEFAULT_SETTINGS);
  assert.equal(out.text, [...HEADER, "- Brass: Birmingham: 9.1 | 9/4/9/10/9/9/8 | 12 plays | Owned"].join("\n"));
  assert.equal(out.rest, 0);
});

test("Claude export lists watched games in a separate predicted section when includeWatching is on", () => {
  const watched = [
    game("Excursions", { watchStage: "reviews", predictedScore: 7.9, scores: vec([9, 9, 9, 9, 9, 9, 9]), bggRating: 8 }),
    game("Bookwyrm", { watchStage: "campaign", predictedScore: 7.3 }),
    game("No guess yet", { watchStage: "awaiting" }),
  ];
  const out = claudeExport([...COLLECTION, ...watched], { ...DEFAULT_SETTINGS, includeWatching: true });
  assert.equal(out.text, [
    ...HEADER,
    "- Brass: Birmingham: 9.1 | 9/4/9/10/9/9/8 | 12 plays | Owned",
    "- Pax Pamir: 7.6 | 7/8/7/4/7/10/6 | 2 plays | Owned | AVOID THEME",
    "- Brass: Iron Clays: 6.1 | 5/5/7/6/8/7/7 | 1 plays | -",
    "",
    "Not yet rescored (old BGG rating):",
    "- Azul: 8.0",
    "- Ark Nova: 7.5 (Wishlist)",
    "",
    "Watching (predicted): crowdfunded games I haven't played; scores are my predictions from reviews, not real scores (predicted score | watch stage):",
    "- Excursions: 7.9 predicted | Reviews out",
    "- Bookwyrm: 7.3 predicted | Campaign live",
    "- No guess yet: — predicted | Awaiting delivery",
  ].join("\n"));
  assert.equal(out.scored, 3);
  assert.equal(out.rest, 2);
  assert.equal(out.watching, 3);
});

test("Claude export has no predicted section when includeWatching is on but nothing is watched", () => {
  const on = claudeExport(COLLECTION, { ...DEFAULT_SETTINGS, includeWatching: true });
  assert.equal(on.text, claudeExport(COLLECTION, DEFAULT_SETTINGS).text);
  assert.equal(on.watching, 0);
});

test("Summary statistics never use predicted scores", () => {
  const watched = [game("Excursions", { watchStage: "reviews", predictedScore: 10 }), game("Bookwyrm", { watchStage: "campaign", predictedScore: 2 })];
  for (const includeWatching of [false, true]) {
    const s = summaryStats([...COLLECTION, ...watched], { ...DEFAULT_SETTINGS, includeWatching });
    assert.deepEqual(s.scored.map((g) => g.name), ["Pax Pamir", "Brass: Birmingham", "Brass: Iron Clays"]);
    assert.equal(s.new.n, 3);
    assert.equal(s.new.mean.toFixed(2), "7.60");
    assert.deepEqual(s.new.histogram[0], [10, 0]); // the predicted 10 never lands in the histogram
    assert.equal(s.games.length, includeWatching ? 8 : 6);
  }
});
