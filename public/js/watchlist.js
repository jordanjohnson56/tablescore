// Which games the main list, Summary and exports show, the Games list's filter,
// sort, row number and BGG drift rules, the Watchlist's hints, and the "Copy
// scores for Claude" text.
// Pure module: no DOM, so the browser, server and tests share it.

import { CRITERIA, finalScore, formatNumber, scoredCount, spread } from "./rubric.js";

// A game's real rubric score under these settings (null until fully scored).
const scoreWith = (settings) => (g) => finalScore(g.scores, settings);

/** Watch stages in Watchlist order. Buy and Pass are the Decided stages. */
export const STAGES = [
  { key: "campaign", label: "Campaign live" },
  { key: "awaiting", label: "Awaiting delivery" },
  { key: "delivered", label: "Delivered" },
  { key: "reviews", label: "Reviews out" },
  { key: "buy", label: "Buy", decided: true },
  { key: "pass", label: "Pass", decided: true },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);
export const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
const DECIDED_KEYS = new Set(STAGES.filter((s) => s.decided).map((s) => s.key));

export const PLATFORMS = [
  { key: "kickstarter", label: "Kickstarter" },
  { key: "gamefound", label: "Gamefound" },
  { key: "other", label: "Other" },
];

/** A game's type. Anything but Expansion would escape the Rank and Hide expansions filters. */
export const GAME_TYPES = ["Base", "Expansion"];

/**
 * Every Status the game page offers and BGG sync writes, in the game page's
 * order; "" is a game not in the collection. Sync writes "Want" for BGG's
 * want and want-to-buy flags.
 */
export const STATUSES = ["Owned", "Preordered", "Prev. owned", "Wishlist", "Want to play", "Want", ""];

/** The currency of a target price that has none. The stored currency stays null. */
export const DEFAULT_CURRENCY = "USD";

/** The currency of a game's target price. */
export const targetCurrency = (game) => game.targetCurrency || DEFAULT_CURRENCY;

/** A game is Watching when it has a watch stage. */
export const isWatching = (game) => Boolean(game.watchStage);

/** A watched game is Decided at Buy or Pass. */
export const isDecided = (game) => DECIDED_KEYS.has(game.watchStage);

const stageRank = (game) => STAGE_KEYS.indexOf(game.watchStage);

// "YYYY-MM" strings sort as text; a game without one goes last.
const byDelivery = (a, b) => (a.deliveryEst ? (b.deliveryEst ? a.deliveryEst.localeCompare(b.deliveryEst) : -1) : b.deliveryEst ? 1 : 0);

/**
 * Watched games only, in Watchlist order: by watch stage (Decided last), then
 * by estimated delivery month (none last), then by name. Returns a new array.
 */
export function sortWatchlist(games) {
  return games
    .filter(isWatching)
    .sort((a, b) => stageRank(a) - stageRank(b) || byDelivery(a, b) || a.name.localeCompare(b.name));
}

// ---------- Watchlist hints ----------
// A hint suggests what to do with a watched game; it never does it. Nothing
// changes a watch stage, or a Predicted score, until the owner taps.

// Same test as rawAverage, so no settings are needed.
const fullyScored = (game) => scoredCount(game.scores) === CRITERIA.length;
const playsLabel = (n) => `${n} ${n === 1 ? "play" : "plays"}`;

/**
 * The hints the Watchlist row shows for a game, as [{ kind, text, button }];
 * empty for a game that isn't Watching. today is local "YYYY-MM-DD".
 *
 * - owned: Owned on BGG or has plays, at any watch stage. The owner should stop
 *   watching; `score` is true when there is something to score next (plays,
 *   not fully scored, not Won't score). When it applies it is the only hint.
 * - campaignEnded: Campaign live and the end date is before today (the end
 *   date itself is still live). Offers Awaiting delivery.
 * - deliveryPassed: Awaiting delivery and the estimated month is before this
 *   month. Offers Delivered.
 * - repredict: Reviews out and not fully scored, so the Predicted score may
 *   predate the reviews. A game records no date for its Predicted score, so
 *   this stays for as long as the game is at Reviews out.
 */
export function watchHints(game, today) {
  if (!isWatching(game)) return [];
  const plays = game.plays || 0;
  const owns = game.status === "Owned";
  if (owns || plays > 0) {
    const score = plays > 0 && !fullyScored(game) && !game.wontScore;
    const text = owns && plays > 0 ? `You own it and have logged ${playsLabel(plays)}.`
      : owns ? "You own it now." : `You've logged ${playsLabel(plays)}.`;
    return [{ kind: "owned", text, button: score ? "Stop watching and score it" : "Stop watching", score }];
  }
  const hints = [];
  if (game.watchStage === "campaign" && game.campaignEnd && game.campaignEnd < today) {
    hints.push({ kind: "campaignEnded", text: `Campaign ended ${game.campaignEnd}.`, button: "Move to Awaiting delivery?" });
  }
  if (game.watchStage === "awaiting" && game.deliveryEst && game.deliveryEst < today.slice(0, 7)) {
    hints.push({ kind: "deliveryPassed", text: `Estimated delivery ${monthLabel(game.deliveryEst)} has passed.`, button: "Move to Delivered?" });
  }
  if (game.watchStage === "reviews" && !fullyScored(game)) {
    hints.push(game.predictedScore != null
      ? { kind: "repredict", text: `Reviews are out. Predicted ${formatNumber(game.predictedScore)} may predate them.`, button: "Predict again" }
      : { kind: "repredict", text: "Reviews are out. No Predicted score yet.", button: "Predict my score" });
  }
  return hints;
}

/**
 * The score the prediction page offers to use as a watched game's Predicted
 * score: a finished prediction's final, at one decimal, when it differs from
 * the Predicted score. Otherwise null. The server fills the Predicted score
 * only when it is empty, so this is how a newer prediction replaces it.
 */
export function predictionToUse(game, prediction) {
  if (!isWatching(game) || prediction?.status !== "done" || prediction.final == null) return null;
  const score = Number(formatNumber(prediction.final));
  return score === game.predictedScore ? null : score;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-10" -> "Oct 2027"; empty when there's no month. */
export function monthLabel(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** True for a BGG type that Settings hides (expansions, when hideExpansions is on). */
export function isHiddenType(type, settings) {
  return Boolean(settings.hideExpansions) && type === "Expansion";
}

/**
 * Games the list, Summary and exports show: watched games only when
 * includeWatching is on; Settings can hide expansions.
 */
export function visibleGames(games, settings) {
  return games.filter((g) => (settings.includeWatching || !isWatching(g)) && !isHiddenType(g.type, settings));
}

/**
 * The Tablescore to type into BGG, or null when there is nothing to update: the
 * game has no Tablescore or no BGG ID, or its BGG rating is within 0.05.
 */
export function bggDrift(game, settings) {
  const f = scoreWith(settings)(game);
  if (f == null || !game.bggId) return null;
  if (game.bggRating != null && Math.abs(game.bggRating - f) < 0.05) return null;
  return f;
}

/** The Games list's filter chips, in order. Keys are saved in prefs, so they must not change. */
export const LIST_FILTERS = [
  { key: "all", label: "All" },
  { key: "todo", label: "To score" },
  { key: "scored", label: "Scored" },
  { key: "owned", label: "Owned" },
  { key: "wishlist", label: "Wishlist" },
  { key: "update", label: "Update BGG" },
  { key: "avoid", label: "Avoid theme" },
];

/** The Games list's sorts, in order. Keys are saved in prefs, so they must not change. */
export const LIST_SORTS = [
  { key: "score", label: "Score" },
  { key: "name", label: "Name" },
  { key: "plays", label: "Plays" },
  { key: "recent", label: "Recent" },
];

const FILTER_TESTS = {
  all: () => true,
  // Nothing to score until the game has been played at least once, and never if marked Won't score.
  todo: (g, final) => final(g) == null && g.plays > 0 && !g.wontScore,
  scored: (g, final) => final(g) != null,
  owned: (g) => g.status === "Owned",
  wishlist: (g) => g.status === "Wishlist" || g.status === "Want" || g.status === "Want to play",
  update: (g, final, settings) => bggDrift(g, settings) != null,
  avoid: (g) => g.avoidTheme,
};

const SORTERS = {
  score: (final) => (a, b) => (final(b) ?? -1) - (final(a) ?? -1) || (b.bggRating ?? -1) - (a.bggRating ?? -1),
  name: () => (a, b) => a.name.localeCompare(b.name),
  plays: () => (a, b) => b.plays - a.plays,
  recent: () => (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""),
};

/** True when a game passes a Games list filter. An unknown key passes every game. */
export function matchesFilter(game, filterKey, settings) {
  return Boolean((FILTER_TESTS[filterKey] || FILTER_TESTS.all)(game, scoreWith(settings), settings));
}

/**
 * The Games list: the games the main list shows, narrowed by one filter and a
 * case-insensitive name search, then sorted. Unknown keys fall back to All and
 * Score. Returns a new array.
 */
export function listGames(games, settings, { filter = "all", sort = "score", q = "" } = {}) {
  const needle = (q || "").trim().toLowerCase();
  const final = scoreWith(settings);
  return visibleGames(games, settings)
    .filter((g) => matchesFilter(g, filter, settings) && (!needle || g.name.toLowerCase().includes(needle)))
    .sort((SORTERS[sort] || SORTERS.score)(final));
}

/**
 * The next game after game in list that passes test, wrapping round to the top;
 * never game itself, and null when there is none. A game not in the list
 * searches from the top.
 */
export function nextInList(list, game, test) {
  const i = list.findIndex((x) => x.id === game.id);
  const order = [...list.slice(i + 1), ...list.slice(0, Math.max(i, 0))];
  return order.find((x) => x.id !== game.id && test(x)) || null;
}

/**
 * The number a Games list row shows, first match wins: the Tablescore; for a
 * watched game, its Predicted score (null when there is none); the BGG rating;
 * otherwise none.
 */
export function rowNumber(game, settings) {
  const f = scoreWith(settings)(game);
  if (f != null) return { kind: "score", value: f };
  if (isWatching(game)) return { kind: "predicted", value: game.predictedScore ?? null };
  if (game.bggRating != null) return { kind: "bgg", value: game.bggRating };
  return { kind: "none", value: null };
}

/**
 * Each game's place in the user's rankings: the scored games the main list shows,
 * expansions left out, ordered by Tablescore. Ties share a place (1, 1, 3). The
 * result answers get(id) with { place, tied } or null, and carries the total.
 */
export function rankings(games, settings) {
  const final = scoreWith(settings);
  const scored = visibleGames(games, settings)
    .filter((g) => g.type !== "Expansion")
    .map((g) => ({ id: g.id, f: final(g) }))
    .filter((x) => x.f != null)
    .sort((a, b) => b.f - a.f);
  const places = new Map();
  scored.forEach((x, i) => places.set(x.id, i > 0 && x.f === scored[i - 1].f ? places.get(scored[i - 1].id) : i + 1));
  const counts = new Map();
  for (const p of places.values()) counts.set(p, (counts.get(p) || 0) + 1);
  return {
    total: scored.length,
    get: (id) => (places.has(id) ? { place: places.get(id), tied: counts.get(places.get(id)) > 1 } : null),
  };
}

/**
 * The Summary view's numbers: old ratings against new rubric scores for the
 * games the list shows. Only real rubric scores count, never predicted scores.
 */
export function summaryStats(games, settings) {
  const shown = visibleGames(games, settings);
  const final = scoreWith(settings);
  const scored = shown.filter((g) => final(g) != null);
  return {
    games: shown,
    scored,
    old: spread(shown.map((g) => g.oldRating).filter((x) => x != null)),
    new: spread(scored.map(final)),
  };
}

/**
 * The "Copy scores for Claude" text: scored games by final score, then games
 * without a full score that have a BGG rating. With includeWatching on, watched
 * games follow in their own predicted section, never in the scored section; a
 * watched game with a real score shows it there beside its prediction.
 * Counts are for the toast.
 */
export function claudeExport(games, settings) {
  const w = settings.weights;
  const final = scoreWith(settings);
  const shown = visibleGames(games, settings).filter((g) => !isWatching(g));
  const lines = [
    `My board game ratings from my Tablescore rubric (weights: ${CRITERIA.map((c) => `${c.name} ${w[c.key]}`).join(", ")}; stretch ${settings.stretch}).`,
    "Scored games (final score | criteria in that order | plays | status | avoid-theme):",
  ];
  const scored = shown.filter((g) => final(g) != null).sort((a, b) => final(b) - final(a));
  for (const g of scored) {
    lines.push(`- ${g.name}: ${formatNumber(final(g))} | ${CRITERIA.map((c) => g.scores[c.key]).join("/")} | ${g.plays} plays | ${g.status || "-"}${g.avoidTheme ? " | AVOID THEME" : ""}`);
  }
  const rest = shown.filter((g) => final(g) == null && g.bggRating != null).sort((a, b) => b.bggRating - a.bggRating);
  if (rest.length) {
    lines.push("", "Not yet rescored (old BGG rating):");
    for (const g of rest) lines.push(`- ${g.name}: ${formatNumber(g.bggRating)}${g.status ? ` (${g.status})` : ""}`);
  }
  const watching = visibleGames(games, settings)
    .filter(isWatching)
    .sort((a, b) => (b.predictedScore ?? -1) - (a.predictedScore ?? -1));
  if (watching.length) {
    lines.push("", "Watching (predicted): crowdfunded games I haven't played; scores are my predictions from reviews, not real scores (predicted score | watch stage):");
    for (const g of watching) {
      const real = final(g);
      lines.push(`- ${g.name}: ${formatNumber(g.predictedScore)} predicted${real != null ? ` (scored ${formatNumber(real)})` : ""} | ${STAGE_LABELS[g.watchStage]}`);
    }
  }
  return { text: lines.join("\n"), scored: scored.length, rest: rest.length, watching: watching.length };
}

/** A game's page on BoardGameGeek. */
export function bggUrl(bggId) {
  return `https://boardgamegeek.com/boardgame/${bggId}`;
}

/**
 * Board Game Oracle (US) price search for a game. Its game pages use its own
 * opaque ids, not BGG ids, so search by name is the one URL that lands on
 * results; /boardgame/search?q= is the shape it serves (/search?q= 404s).
 */
export function bgoSearchUrl(name) {
  return `https://www.boardgameoracle.com/boardgame/search?q=${encodeURIComponent(name)}`;
}
