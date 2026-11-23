import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITERIA, DEFAULT_SETTINGS } from "../public/js/rubric.js";
import {
  LIST_FILTERS, LIST_SORTS, awaitingHint, bggDrift, bggUrl, bgoSearchUrl, claudeExport, listGames, matchesFilter, monthLabel,
  nextInList, rankings, rowNumber, sortWatchlist, summaryStats, targetCurrency, visibleGames,
} from "../public/js/watchlist.js";

const base = { type: "Base", scores: {}, plays: 0, status: "", avoidTheme: false, bggRating: null };
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

// ---------- Watchlist order ----------

const watched = (name, watchStage, deliveryEst = null) => game(name, { watchStage, deliveryEst });
const order = (games) => sortWatchlist(games).map((g) => g.name);

test("the Watchlist lists watched games by stage, with Decided stages after the active ones", () => {
  const games = [
    watched("Passed", "pass"),
    watched("Reviewed", "reviews"),
    watched("Bought", "buy"),
    game("Brass"),
    watched("Delivered", "delivered"),
    watched("Live", "campaign"),
    watched("Shipping", "awaiting"),
  ];
  assert.deepEqual(order(games), ["Live", "Shipping", "Delivered", "Reviewed", "Bought", "Passed"]);
});

test("within a stage, the Watchlist goes by estimated delivery month, games without one last, then by name", () => {
  const games = [
    watched("Zebra", "awaiting"),
    watched("Later", "awaiting", "2028-01"),
    watched("Apple", "awaiting"),
    watched("Bravo", "awaiting", "2027-10"),
    watched("Alpha", "awaiting", "2027-10"),
    watched("Soon", "awaiting", "2027-03"),
    watched("Live", "campaign"),
  ];
  assert.deepEqual(order(games), ["Live", "Soon", "Alpha", "Bravo", "Later", "Apple", "Zebra"]);
});

// ---------- "Move to Awaiting delivery?" hint ----------

test("the Awaiting delivery hint shows only for a Campaign live game whose end date has passed", () => {
  const today = "2026-10-21";
  const hint = (watchStage, campaignEnd) => awaitingHint(game("Kings Gambit", { watchStage, campaignEnd }), today);
  assert.equal(hint("campaign", "2026-10-20"), true);
  assert.equal(hint("campaign", "2026-10-21"), false, "the campaign is still live on its end date");
  assert.equal(hint("campaign", "2026-10-30"), false);
  assert.equal(hint("campaign", null), false);
  assert.equal(hint("awaiting", "2026-10-20"), false);
  assert.equal(hint("pass", "2026-10-20"), false);
  assert.equal(hint(null, "2026-10-20"), false);
});

test("a target price with no currency is in USD", () => {
  assert.equal(targetCurrency(game("Bookwyrm", { targetPrice: 45, targetCurrency: null })), "USD");
  assert.equal(targetCurrency(game("Bookwyrm", { targetPrice: 45 })), "USD");
  assert.equal(targetCurrency(game("Bookwyrm", { targetPrice: 45, targetCurrency: "EUR" })), "EUR");
});

test("estimated delivery reads as a short month and year", () => {
  assert.equal(monthLabel("2027-10"), "Oct 2027");
  assert.equal(monthLabel("2028-01"), "Jan 2028");
  assert.equal(monthLabel(null), "");
});

test("Claude export lists watched games in a separate predicted section when includeWatching is on, with any real score labelled beside the prediction", () => {
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
    "- Excursions: 7.9 predicted (scored 10.0) | Reviews out",
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

test("rankings place scored games by Tablescore, with ties sharing a place", () => {
  const games = [
    game("Brass", { id: 1, scores: vec([10, 10, 10, 10, 10, 10, 10]) }),
    game("Avalon", { id: 2, scores: vec([10, 10, 10, 10, 10, 10, 10]) }),
    game("Root", { id: 3, scores: vec([9, 4, 9, 10, 9, 9, 8]) }),
    game("Unscored", { id: 4 }),
  ];
  const r = rankings(games, DEFAULT_SETTINGS);
  assert.equal(r.total, 3);
  assert.deepEqual(r.get(1), { place: 1, tied: true });
  assert.deepEqual(r.get(2), { place: 1, tied: true });
  assert.deepEqual(r.get(3), { place: 3, tied: false });
  assert.equal(r.get(4), null);
});

test("rankings leave out expansions and games the main list hides", () => {
  const scores = vec([9, 4, 9, 10, 9, 9, 8]);
  const games = [
    game("Dune", { id: 1, scores: vec([10, 10, 10, 10, 10, 10, 10]) }),
    game("Dune: Rise of Ix", { id: 2, type: "Expansion", scores }),
    game("Watched", { id: 3, watchStage: "reviews", scores }),
    game("Root", { id: 4, scores }),
  ];
  const r = rankings(games, DEFAULT_SETTINGS);
  assert.equal(r.total, 2);
  assert.equal(r.get(2), null);
  assert.equal(r.get(3), null);
  assert.deepEqual(r.get(4), { place: 2, tied: false });
});

test("outside links point at the BGG page and a Board Game Oracle search", () => {
  assert.equal(bggUrl(224517), "https://boardgamegeek.com/boardgame/224517");
  assert.equal(
    bgoSearchUrl("Brass: Birmingham & Co"),
    "https://www.boardgameoracle.com/boardgame/search?q=Brass%3A%20Birmingham%20%26%20Co",
  );
});

// ---------- Games list: BGG drift, filters, sorts, next in list, row number ----------

const S91 = vec([9, 4, 9, 10, 9, 9, 8]); // 9.1
const S76 = vec([7, 8, 7, 4, 7, 10, 6]); // 7.6
const S99 = vec([9, 9, 9, 9, 9, 9, 9]); // 10.0 at the default stretch
const PARTIAL = { desire: 8, table: 7 };

test("a scored game with a BGG ID and no BGG rating needs its Tablescore typed into BGG", () => {
  assert.equal(bggDrift(game("Brass", { bggId: 1, scores: S91 }), DEFAULT_SETTINGS), 9.1);
});

test("there is no BGG drift when the BGG rating matches or is within 0.05", () => {
  const drift = (bggRating) => bggDrift(game("Brass", { bggId: 1, scores: S91, bggRating }), DEFAULT_SETTINGS);
  assert.equal(drift(9.1), null);
  assert.equal(drift(9.14), null);
  assert.equal(drift(9.0), 9.1);
  assert.equal(drift(9.2), 9.1);
});

test("there is no BGG drift without a BGG ID or without a full score", () => {
  assert.equal(bggDrift(game("No ID", { scores: S91 }), DEFAULT_SETTINGS), null);
  assert.equal(bggDrift(game("Unscored", { bggId: 1, bggRating: 7 }), DEFAULT_SETTINGS), null);
  assert.equal(bggDrift(game("Partial", { bggId: 1, scores: PARTIAL, bggRating: 7 }), DEFAULT_SETTINGS), null);
});

test("BGG drift follows the settings passed in", () => {
  const g = game("Nines", { bggId: 1, scores: S99, bggRating: 10 });
  assert.equal(bggDrift(g, DEFAULT_SETTINGS), null);
  assert.equal(bggDrift(g, { ...DEFAULT_SETTINGS, stretch: 1 }), 9);
});

// One collection for the filter tests. Every game has an id and a BGG ID unless noted.
const LIST = [
  game("Brass", { id: 1, bggId: 11, scores: S91, bggRating: 9.1, plays: 12, status: "Owned" }),
  game("Pax Pamir", { id: 2, bggId: 12, scores: S76, bggRating: 7, plays: 2, status: "Owned", avoidTheme: true }),
  game("Ark Nova", { id: 3, bggId: 13, bggRating: 8.2, plays: 3, status: "Wishlist" }),
  game("Azul", { id: 4, bggId: 14, scores: PARTIAL, plays: 1, status: "Want" }),
  game("Cascadia", { id: 5, bggId: 15, plays: 0, status: "Want to play" }),
  game("Dune", { id: 6, bggId: 16, plays: 4, status: "Preordered", wontScore: true }),
  game("Root", { id: 7, scores: S91, plays: 5 }),
  game("Bookwyrm", { id: 8, bggId: 18, watchStage: "reviews", plays: 1, status: "Wishlist", predictedScore: 8 }),
  game("Brass: Iron Clays", { id: 9, bggId: 19, type: "Expansion", plays: 2, avoidTheme: true }),
];
const namesFor = (filter, settings = DEFAULT_SETTINGS, extra = {}) =>
  listGames(LIST, settings, { filter, sort: "name", ...extra }).map((g) => g.name);

test("the list filters and sorts keep their keys, labels and order", () => {
  assert.deepEqual(LIST_FILTERS.map((f) => [f.key, f.label]), [
    ["all", "All"], ["todo", "To score"], ["scored", "Scored"], ["owned", "Owned"],
    ["wishlist", "Wishlist"], ["update", "Update BGG"], ["avoid", "Avoid theme"],
  ]);
  assert.deepEqual(LIST_SORTS.map((s) => [s.key, s.label]), [["score", "Score"], ["name", "Name"], ["plays", "Plays"], ["recent", "Recent"]]);
});

test("To score keeps unscored and partly scored games with plays, and drops unplayed, Won't score and scored games", () => {
  assert.deepEqual(namesFor("todo"), ["Ark Nova", "Azul", "Brass: Iron Clays"]);
});

test("Scored, Owned, Update BGG and Avoid theme each keep the right games", () => {
  assert.deepEqual(namesFor("scored"), ["Brass", "Pax Pamir", "Root"]);
  assert.deepEqual(namesFor("owned"), ["Brass", "Pax Pamir"]);
  assert.deepEqual(namesFor("update"), ["Pax Pamir"]);
  assert.deepEqual(namesFor("avoid"), ["Brass: Iron Clays", "Pax Pamir"]);
});

test("Wishlist keeps Wishlist, Want and Want to play, and not Preordered", () => {
  assert.deepEqual(namesFor("wishlist"), ["Ark Nova", "Azul", "Cascadia"]);
});

test("All and an unknown filter key show every game the main list shows", () => {
  const all = ["Ark Nova", "Azul", "Brass", "Brass: Iron Clays", "Cascadia", "Dune", "Pax Pamir", "Root"];
  assert.deepEqual(namesFor("all"), all);
  assert.deepEqual(namesFor("nonsense"), all);
  assert.equal(matchesFilter(LIST[0], "nonsense", DEFAULT_SETTINGS), true);
  assert.deepEqual(listGames(LIST, DEFAULT_SETTINGS).map((g) => g.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 9]);
});

test("every filter leaves out what the main list hides", () => {
  const watching = { ...DEFAULT_SETTINGS, includeWatching: true };
  const noExp = { ...DEFAULT_SETTINGS, hideExpansions: true };
  for (const { key } of LIST_FILTERS) {
    assert.ok(!namesFor(key).includes("Bookwyrm"), key);
    assert.ok(!namesFor(key, noExp).includes("Brass: Iron Clays"), key);
  }
  assert.deepEqual(namesFor("wishlist", watching), ["Ark Nova", "Azul", "Bookwyrm", "Cascadia"]);
  assert.deepEqual(namesFor("todo", watching), ["Ark Nova", "Azul", "Bookwyrm", "Brass: Iron Clays"]);
  assert.deepEqual(namesFor("avoid", noExp), ["Pax Pamir"]);
});

test("search is case-insensitive, ignores surrounding spaces, and combines with the filter", () => {
  assert.deepEqual(namesFor("all", DEFAULT_SETTINGS, { q: "  BRASS " }), ["Brass", "Brass: Iron Clays"]);
  assert.deepEqual(namesFor("scored", DEFAULT_SETTINGS, { q: "brass" }), ["Brass"]);
  assert.deepEqual(namesFor("all", DEFAULT_SETTINGS, { q: "   " }).length, 8);
});

test("the Score sort puts Tablescore first, then unscored games by BGG rating, then games with neither", () => {
  const games = [
    game("Neither", { id: 1 }),
    game("Rated 6", { id: 2, bggRating: 6 }),
    game("Scored 7.6", { id: 3, scores: S76 }),
    game("Rated 8", { id: 4, bggRating: 8 }),
    game("Scored 9.1", { id: 5, scores: S91, bggRating: 5 }),
  ];
  const names = (sort) => listGames(games, DEFAULT_SETTINGS, { sort }).map((g) => g.name);
  assert.deepEqual(names("score"), ["Scored 9.1", "Scored 7.6", "Rated 8", "Rated 6", "Neither"]);
  assert.deepEqual(names("nonsense"), names("score"));
});

test("a watched game with only a Predicted score sorts as unscored, not by its prediction", () => {
  const games = [
    game("Predicted", { id: 1, watchStage: "reviews", predictedScore: 9.9 }),
    game("Scored", { id: 2, scores: S76 }),
    game("Rated", { id: 3, bggRating: 7 }),
  ];
  const settings = { ...DEFAULT_SETTINGS, includeWatching: true };
  assert.deepEqual(listGames(games, settings, { sort: "score" }).map((g) => g.name), ["Scored", "Rated", "Predicted"]);
});

test("the Name, Plays and Recent sorts each order the list", () => {
  const games = [
    game("Cascadia", { id: 1, plays: 3, updatedAt: "2026-01-02T00:00:00Z" }),
    game("Azul", { id: 2, plays: 9 }),
    game("Brass", { id: 3, plays: 1, updatedAt: "2026-03-01T00:00:00Z" }),
  ];
  const names = (sort) => listGames(games, DEFAULT_SETTINGS, { sort }).map((g) => g.name);
  assert.deepEqual(names("name"), ["Azul", "Brass", "Cascadia"]);
  assert.deepEqual(names("plays"), ["Azul", "Cascadia", "Brass"]);
  assert.deepEqual(names("recent"), ["Brass", "Cascadia", "Azul"]);
});

test("listGames returns a new array and leaves the input order alone", () => {
  const games = [game("Brass", { id: 1 }), game("Azul", { id: 2 })];
  const out = listGames(games, DEFAULT_SETTINGS, { sort: "name" });
  assert.notEqual(out, games);
  assert.deepEqual(out.map((g) => g.name), ["Azul", "Brass"]);
  assert.deepEqual(games.map((g) => g.name), ["Brass", "Azul"]);
});

const ids = (...xs) => xs.map((id) => ({ id }));
const even = (g) => g.id % 2 === 0;

test("next in list is the next match after the game, skipping non-matches and wrapping to the top", () => {
  const list = ids(1, 2, 3, 4, 5, 6);
  assert.equal(nextInList(list, list[1], even).id, 4);
  assert.equal(nextInList(list, list[2], even).id, 4);
  assert.equal(nextInList(list, list[5], even).id, 2);
  assert.equal(nextInList(list, list[4], even).id, 6);
});

test("next in list is null when the game is the only match, and never the game itself", () => {
  const list = ids(1, 2, 3);
  assert.equal(nextInList(list, list[1], even), null);
  assert.equal(nextInList(list, list[0], () => false), null);
  assert.equal(nextInList(ids(7), { id: 7 }, () => true), null);
});

test("next in list searches from the top when the game is not in the list", () => {
  const list = ids(1, 2, 3, 4);
  assert.equal(nextInList(list, { id: 99 }, even).id, 2);
  assert.equal(nextInList(list, { id: 99 }, () => true).id, 1);
});

test("the row number is the Tablescore when there is one, even for a watched game", () => {
  assert.deepEqual(rowNumber(game("Brass", { scores: S91, bggRating: 8 }), DEFAULT_SETTINGS), { kind: "score", value: 9.1 });
  assert.deepEqual(rowNumber(game("Watched", { scores: S91, watchStage: "delivered", predictedScore: 7 }), DEFAULT_SETTINGS), { kind: "score", value: 9.1 });
});

test("a watched, unscored game's row number is its Predicted score, null without one even when it has a BGG rating", () => {
  assert.deepEqual(rowNumber(game("Bookwyrm", { watchStage: "reviews", predictedScore: 8.4, bggRating: 7 }), DEFAULT_SETTINGS), { kind: "predicted", value: 8.4 });
  assert.deepEqual(rowNumber(game("Bookwyrm", { watchStage: "reviews", bggRating: 7 }), DEFAULT_SETTINGS), { kind: "predicted", value: null });
});

test("an unwatched, unscored game's row number is its BGG rating, or none without one", () => {
  assert.deepEqual(rowNumber(game("Ark Nova", { bggRating: 8.2, scores: PARTIAL }), DEFAULT_SETTINGS), { kind: "bgg", value: 8.2 });
  assert.deepEqual(rowNumber(game("Unrated"), DEFAULT_SETTINGS), { kind: "none", value: null });
});
