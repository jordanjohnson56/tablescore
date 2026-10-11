// Which games the main list, Summary and exports show, and the "Copy scores for
// Claude" text. Pure module: no DOM, so the browser, server and tests share it.

import { CRITERIA, finalScore, spread } from "./rubric.js";

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
 * The Summary view's numbers: old ratings against new rubric scores for the
 * games the list shows. Only real rubric scores count, never predicted scores.
 */
export function summaryStats(games, settings) {
  const shown = visibleGames(games, settings);
  const final = (g) => finalScore(g.scores, settings);
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
 * games follow in their own predicted section, never mixed with real scores.
 * Counts are for the toast.
 */
export function claudeExport(games, settings) {
  const w = settings.weights;
  const final = (g) => finalScore(g.scores, settings);
  const shown = visibleGames(games, settings).filter((g) => !isWatching(g));
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
  const watching = visibleGames(games, settings)
    .filter(isWatching)
    .sort((a, b) => (b.predictedScore ?? -1) - (a.predictedScore ?? -1));
  if (watching.length) {
    lines.push("", "Watching (predicted): crowdfunded games I haven't played; scores are my predictions from reviews, not real scores (predicted score | watch stage):");
    for (const g of watching) lines.push(`- ${g.name}: ${fmt(g.predictedScore)} predicted | ${STAGE_LABELS[g.watchStage]}`);
  }
  return { text: lines.join("\n"), scored: scored.length, rest: rest.length, watching: watching.length };
}
