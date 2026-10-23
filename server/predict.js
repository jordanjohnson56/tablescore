// Claude rating predictions. Builds a prompt from the user's own rubric scores,
// asks Claude (with web search) to score a game on all seven criteria, and
// returns those scores. The final score is always worked out by rubric.js.
import { CRITERIA, finalScore, formatNumber, isProvisional } from "../public/js/rubric.js";
import { isWatching } from "../public/js/watchlist.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_SEARCHES = 5;
// Nominating a batch of games needs more looking around than scoring one.
const NOMINATE_SEARCHES = 10;
export const MAX_NOMINEES = 20;
// API calls per prediction: one, plus resumes after a long search turn pauses,
// plus one nudge if Claude finishes without submitting.
const MAX_CALLS = 6;
// Models that take the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export class PredictError extends Error {}

const SUBMIT_TOOL = {
  name: "submit_prediction",
  description: "Submit the predicted rubric scores. Call it exactly once, when you are done researching.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "object",
        description: "Predicted score for each criterion, 0-10, at most one decimal.",
        properties: Object.fromEntries(CRITERIA.map((c) => [c.key, { type: "number", description: c.name }])),
        required: CRITERIA.map((c) => c.key),
        additionalProperties: false,
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "How sure you are, given how much you know about the game and how close the comparable games are.",
      },
      rationale: {
        type: "string",
        description: "Two to four sentences: why these scores, naming the scored games you compared it with.",
      },
      two_player: { type: "string", description: "One sentence on how well it plays at two players." },
      avoid_theme: { type: "boolean", description: "True if the theme is one the user avoids." },
      avoid_theme_reason: { type: "string", description: "One line on why, or an empty string." },
      sources: {
        type: "array",
        description: "Web pages from your searches that you relied on. Empty if you didn't search.",
        items: {
          type: "object",
          properties: { title: { type: "string" }, url: { type: "string" } },
          required: ["title", "url"],
          additionalProperties: false,
        },
      },
    },
    required: ["scores", "confidence", "rationale", "two_player", "avoid_theme", "avoid_theme_reason", "sources"],
    additionalProperties: false,
  },
};

const NOMINATE_TOOL = {
  name: "submit_nominees",
  description: "Submit the games you nominate. Call it exactly once, when you are done researching.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      nominees: {
        type: "array",
        description: "The nominated games, best fit first.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The game's name as BoardGameGeek lists it." },
            year: { type: "integer", description: "Year published, or 0 if unsure." },
            bgg_id: { type: "integer", description: "Its BoardGameGeek ID if you know it for certain, else 0." },
            expansion: { type: "boolean", description: "True if it is an expansion." },
            reason: { type: "string", description: "One sentence on why this person should look at it, naming a scored game it resembles." },
          },
          required: ["name", "year", "bgg_id", "expansion", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["nominees"],
    additionalProperties: false,
  },
};

/** Talks to Claude. `client` is an Anthropic SDK client, or a fake in tests. */
export class Predictor {
  constructor({ client = null, model = DEFAULT_MODEL } = {}) {
    this.client = client;
    this.model = model;
  }

  get configured() {
    return !!this.client;
  }

  /** Run one prediction. Returns the parsed submission plus token usage. */
  async predict({ system, target }) {
    const { input, found, usage } = await this.converse({ system, user: target, tool: SUBMIT_TOOL, maxSearches: MAX_SEARCHES });
    return { ...parseSubmission(input, found), usage };
  }

  /** Ask for games to recommend. Returns the parsed nominees plus token usage. */
  async nominate({ system, user, count }) {
    const { input, usage } = await this.converse({ system, user, tool: NOMINATE_TOOL, maxSearches: NOMINATE_SEARCHES });
    return { nominees: parseNominees(input, count), usage };
  }

  /**
   * One conversation with Claude that ends when it calls `tool`: web search
   * turns are resumed, and Claude gets one nudge if it stops without calling.
   */
  async converse({ system, user, tool, maxSearches }) {
    if (!this.client) throw new PredictError("ANTHROPIC_API_KEY is not set on the server");
    const messages = [{ role: "user", content: user }];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
    const found = new Map(); // url -> title, from the search results Claude actually got
    let nudged = false;
    for (let call = 0; call < MAX_CALLS; call++) {
      const msg = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: 32000,
          // Everything but the target game is stable between predictions, so it caches.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }, tool],
          messages,
          ...(FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        })
        .finalMessage();
      addUsage(usage, msg.usage);
      for (const block of msg.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.url) found.set(r.url, r.title);
        }
      }
      if (msg.stop_reason === "refusal") throw new PredictError("Claude declined to make this prediction.");
      const submit = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
      if (submit) return { input: submit.input, found, usage };
      if (msg.stop_reason === "max_tokens") throw new PredictError("Claude ran out of room before finishing.");
      messages.push({ role: "assistant", content: msg.content });
      // pause_turn: a long search turn stopped early; sending it back resumes it.
      if (msg.stop_reason === "pause_turn") continue;
      if (nudged) break;
      nudged = true;
      messages.push({ role: "user", content: `Please finish now by calling the ${tool.name} tool.` });
    }
    throw new PredictError("Claude finished without submitting a prediction.");
  }
}

function addUsage(total, u = {}) {
  total.input += u.input_tokens || 0;
  total.output += u.output_tokens || 0;
  total.cacheRead += u.cache_read_input_tokens || 0;
  total.cacheWrite += u.cache_creation_input_tokens || 0;
  total.searches += u.server_tool_use?.web_search_requests || 0;
}

/** Validate Claude's submission. Scores are clamped to 0-10 and rounded to one decimal. */
export function parseSubmission(input, found = new Map()) {
  const scores = {};
  for (const c of CRITERIA) {
    const v = input?.scores?.[c.key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new PredictError(`Claude's prediction had no ${c.name} score.`);
    scores[c.key] = Math.round(Math.max(0, Math.min(10, v)) * 10) / 10;
  }
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    scores,
    confidence: ["low", "medium", "high"].includes(input.confidence) ? input.confidence : "low",
    rationale: str(input.rationale),
    twoPlayer: str(input.two_player),
    avoidTheme: input.avoid_theme === true,
    avoidThemeReason: input.avoid_theme === true ? str(input.avoid_theme_reason) : "",
    // Keep only pages that came back from a search, so a made-up link can't show up.
    sources: (Array.isArray(input.sources) ? input.sources : [])
      .filter((s) => typeof s?.url === "string" && found.has(s.url))
      .map((s) => ({ title: str(s.title) || found.get(s.url) || s.url, url: s.url }))
      .filter((s, i, all) => all.findIndex((x) => x.url === s.url) === i),
  };
}

const isTarget = (g, target) => (target.gameId != null && g.id === target.gameId) || (target.bggId != null && g.bggId === target.bggId);

/**
 * The system prompt: rubric, taste profile and every score the user has, minus
 * the target game. It holds nothing per-request, so it caches between predictions.
 * Returns the text and how many fully scored games went into it.
 */
/** Clean up a nominees submission: trims names, drops blanks and duplicates, caps the count. */
export function parseNominees(input, count = MAX_NOMINEES) {
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(input?.nominees) ? input.nominees : []) {
    const name = String(n?.name ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const year = Number.isInteger(n.year) && n.year > 0 ? n.year : null;
    const bggId = Number.isInteger(n.bgg_id) && n.bgg_id > 0 ? n.bgg_id : null;
    out.push({ name, year, bggId, expansion: !!n.expansion, reason: String(n.reason ?? "").trim() });
    if (out.length >= count) break;
  }
  if (!out.length) throw new PredictError("Claude nominated no games.");
  return out;
}

export function buildSystem(games, settings, target = {}) {
  const rubric = CRITERIA.map((c) =>
    [
      `### ${c.name} (key "${c.key}", weight ${settings.weights[c.key]}, ${c.yardstick})`,
      c.purpose,
      `Question: ${c.ask}`,
      ...c.bands.map((b, i) => `- ${["9-10", "7-8", "5-6", "3-4", "0-2"][i]}: ${b}`),
    ].join("\n"),
  ).join("\n\n");
  const scores = scoreContext(games, settings, target);

  const lines = [
    "You predict how one board gamer would score a game they haven't scored yet, using their personal rubric. Your prediction is compared with their real score after they play, so aim for accuracy, not flattery.",
    "",
    "## How to predict",
    "- Score each of the seven criteria from 0 to 10 the way this person would. Anchor every criterion on the scored games below that are most like this one, and name those games in your rationale.",
    "- Desire to Play and Table Appeal are absolute, judged against their whole collection. The other criteria are fit-for-purpose and judged at the game's best realistic player count. Also say in one sentence how it plays at two.",
    "- An expansion is scored as base game plus expansion. If they've scored the base game, start from that score and judge how much the expansion changes it.",
    "- Search the web when you aren't sure how the game plays (reviews, rules overviews, player-count discussions). Newer games especially need it. Don't search for things you already know well.",
    "- Set avoid_theme when the theme is one they avoid, and score Theme 0-2 in that case.",
    "- Use low confidence when you know little about the game or nothing they've scored is close to it.",
    "- When you're done, call submit_prediction once.",
    "",
    "## Their rubric",
    `Final score = 5 + (weighted average - 5) x ${settings.stretch}, clamped to 0-10. The app computes it from your criterion scores; you don't need to.`,
    "",
    rubric,
    "",
    "## Their taste in their own words",
    tasteProfile(settings),
    "",
    ...scores.lines,
  ];
  return { text: lines.join("\n"), scoredGames: scores.scoredGames };
}

export function tasteProfile(settings) {
  return settings.tasteProfile?.trim() || "(They haven't written a taste profile yet. Go by their scores.)";
}

/**
 * The prompt sections listing what the user has scored, and their old ratings
 * for games not yet rescored. Watched games and the target are left out.
 */
export function scoreContext(games, settings, target = {}) {
  const final = (g) => finalScore(g.scores, settings);
  const pool = games.filter((g) => !isWatching(g) && !isTarget(g, target));
  const scored = pool.filter((g) => final(g) != null).sort((a, b) => final(b) - final(a) || a.name.localeCompare(b.name));
  const old = pool
    .filter((g) => final(g) == null && (g.bggRating ?? g.oldRating) != null)
    .sort((a, b) => (b.bggRating ?? b.oldRating) - (a.bggRating ?? a.oldRating) || a.name.localeCompare(b.name));
  const lines = [
    `## Games they've scored (${scored.length})`,
    `Format: name | final | ${CRITERIA.map((c) => c.key).join("/")} | plays | BGG weight | players. "Provisional" means under 3 plays.`,
    ...scored.map((g) => `- ${scoredLine(g, final(g))}`),
  ];
  if (old.length) {
    lines.push(
      "",
      `## Games not yet rescored (${old.length})`,
      "These are their old 1-10 ratings from before the rubric, not rubric scores. The old scale ran high (mean about 7.4, most games 7-8). Treat them as rough, weaker evidence of what they like.",
      ...old.map((g) => `- ${gameLabel(g)}: ${formatNumber(g.bggRating ?? g.oldRating)}${g.wontScore ? " (won't rescore)" : ""}`),
    );
  }
  return { lines, scoredGames: scored.length, scored };
}

function gameLabel(g) {
  return `${g.name}${g.type === "Expansion" ? " [expansion]" : ""}`;
}

function scoredLine(g, final) {
  const parts = [
    gameLabel(g),
    formatNumber(final),
    CRITERIA.map((c) => g.scores[c.key]).join("/"),
    `${g.plays} plays${isProvisional(g) ? " (provisional)" : ""}`,
  ];
  if (g.bggWeight != null) parts.push(`weight ${g.bggWeight}`);
  if (g.minPlayers != null) parts.push(players(g));
  if (g.avoidTheme) parts.push("AVOID THEME");
  return parts.join(" | ");
}

function players(g) {
  const range = g.minPlayers === g.maxPlayers || g.maxPlayers == null ? `${g.minPlayers}p` : `${g.minPlayers}-${g.maxPlayers}p`;
  return g.bestPlayers ? `${range}, best ${g.bestPlayers}` : range;
}

/**
 * The user message: the game to predict. `details` is BGG data (from
 * BggClient.details) or null when there is none. Base games of an expansion
 * that the user has scored are pointed out with their score.
 */
export function buildTarget({ name, details, games = [], settings }) {
  const lines = [`Predict my rubric scores for this game.`, "", `Name: ${details?.name || name}${details?.year ? ` (${details.year})` : ""}`];
  if (!details) {
    lines.push("There's no BoardGameGeek data for this game. Search the web to find out what it is and how it plays.");
    return lines.join("\n");
  }
  lines.push(`Type: ${details.type === "Expansion" ? "expansion" : "base game"}`);
  for (const base of details.baseGames || []) {
    const mine = games.find((g) => g.bggId === base.bggId);
    const score = mine ? finalScore(mine.scores, settings) : null;
    lines.push(`Expands: ${base.name}${score != null ? ` (I scored it ${formatNumber(score)})` : mine ? " (in my list, not scored)" : ""}`);
  }
  const facts = [];
  if (details.minPlayers != null) facts.push(`players ${players(details)}`);
  if (details.playTime) facts.push(`${details.playTime} min`);
  if (details.bggWeight != null) facts.push(`weight ${details.bggWeight}`);
  if (details.bggAvg) facts.push(`BGG average ${details.bggAvg}`);
  if (facts.length) lines.push(`BGG: ${facts.join(", ")}`);
  if (details.designers?.length) lines.push(`Designers: ${details.designers.join(", ")}`);
  if (details.mechanics?.length) lines.push(`Mechanics: ${details.mechanics.join(", ")}`);
  if (details.categories?.length) lines.push(`Categories: ${details.categories.join(", ")}`);
  if (details.description) lines.push("", "BGG description (publisher text):", details.description);
  return lines.join("\n");
}
