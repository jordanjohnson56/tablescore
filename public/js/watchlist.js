// Which games the main list, Summary and exports show, and the "Copy scores for
// Claude" text. Pure module: no DOM, so the browser, server and tests share it.

import { CRITERIA, finalScore } from "./rubric.js";

const fmt = (n) => (n == null ? "—" : Number(n).toFixed(1));

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

export const PLATFORMS = [
  { key: "kickstarter", label: "Kickstarter" },
  { key: "gamefound", label: "Gamefound" },
  { key: "other", label: "Other" },
];

/** A game is Watching when it has a watch stage. */
export const isWatching = (game) => Boolean(game.watchStage);

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

/**
 * True when a Campaign live game's end date has passed, so the Watchlist offers
 * "Move to Awaiting delivery?". today is "YYYY-MM-DD"; the end date itself is
 * still live. Nothing changes a stage automatically.
 */
export function awaitingHint(game, today) {
  return game.watchStage === "campaign" && Boolean(game.campaignEnd) && game.campaignEnd < today;
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

/** Games the list, Summary and exports show: never watched games; Settings can hide expansions. */
export function visibleGames(games, settings) {
  return games.filter((g) => !isWatching(g) && !isHiddenType(g.type, settings));
}

/**
 * The "Copy scores for Claude" text: scored games by final score, then games
 * without a full score that have a BGG rating. Counts are for the toast.
 */
export function claudeExport(games, settings) {
  const w = settings.weights;
  const final = (g) => finalScore(g.scores, settings);
  const shown = visibleGames(games, settings);
  const lines = [
    `My board game ratings from my Tablescore rubric (weights: ${CRITERIA.map((c) => `${c.name} ${w[c.key]}`).join(", ")}; stretch ${settings.stretch}).`,
    "Scored games (final score | criteria in that order | plays | status | avoid-theme):",
  ];
  const scored = shown.filter((g) => final(g) != null).sort((a, b) => final(b) - final(a));
  for (const g of scored) {
    lines.push(`- ${g.name}: ${fmt(final(g))} | ${CRITERIA.map((c) => g.scores[c.key]).join("/")} | ${g.plays} plays | ${g.status || "-"}${g.avoidTheme ? " | AVOID THEME" : ""}`);
  }
  const rest = shown.filter((g) => final(g) == null && g.bggRating != null).sort((a, b) => b.bggRating - a.bggRating);
  if (rest.length) {
    lines.push("", "Not yet rescored (old BGG rating):");
    for (const g of rest) lines.push(`- ${g.name}: ${fmt(g.bggRating)}${g.status ? ` (${g.status})` : ""}`);
  }
  return { text: lines.join("\n"), scored: scored.length, rest: rest.length };
}
