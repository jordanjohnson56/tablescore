// Rubric definitions and score math. Mirrors "Game Rating Rubric v2.xlsx"
// (Legend + Weights tabs). Pure module: no DOM, so it can be unit tested in Node.

export const CRITERIA = [
  {
    key: "desire",
    name: "Desire to Play",
    yardstick: "Absolute",
    purpose:
      "The core of the score: how much you personally want this game to hit the table. Judged on one scale across your whole collection.",
    ask: "If I had a free evening and the right group, how badly would I want to play THIS over everything else on my shelf?",
    bands: [
      "I would pick it over almost anything. I think about it between plays.",
      "Happy to play any time it is suggested; I sometimes suggest it myself.",
      "Fine if someone else picks it; I would rarely suggest it.",
      "I would suggest something else; I play it to be a good sport.",
      "I actively avoid it.",
    ],
  },
  {
    key: "table",
    name: "Table Appeal",
    yardstick: "Absolute",
    purpose:
      "Whether your actual groups, your wife especially, want to play it, at the player counts you actually get.",
    ask: "When I pull this off the shelf, how do the people I usually play with react, and how often can I realistically get it played?",
    bands: [
      "Requested by others; easy to get to the table at counts we actually play.",
      "Gets a yes from my regular groups without convincing; lands regularly.",
      "Works with some of my groups or only at counts we rarely hit.",
      "Takes persuading, or needs a group/count I almost never assemble.",
      "Nobody I play with wants it; effectively never hits the table.",
    ],
  },
  {
    key: "depth",
    name: "Decision Depth & Tension",
    yardstick: "Fit-for-purpose",
    purpose:
      "Quality and weight of the choices each turn, relative to the game's class. A great filler can score 9 here.",
    ask: "For a game of this length and weight, are my decisions interesting, tense and consequential?",
    bands: [
      "Agonizing, consequential choices every turn; a skill gap shows over plays.",
      "Real decisions most turns; good play is clearly rewarded.",
      "Some meaningful choices, some obvious or automatic turns.",
      "Mostly obvious moves or heavy luck swamps choices.",
      "Little or no meaningful decision-making.",
    ],
  },
  {
    key: "interaction",
    name: "Interaction Quality",
    yardstick: "Fit-for-purpose",
    purpose:
      "How good the interaction is, not how much there is. A contested shared map (Brass) and open war (TI4, Root) can both earn 9-10. Take-that, kingmaking and chaos score low however much of it there is. In co-ops, real joint decision-making counts; quarterbacking and parallel solitaire do not.",
    ask: "Do other players' choices create tension and force interesting reads, in a way I enjoy?",
    bands: [
      "The interaction is the heart of the game: contested space, races, negotiation or conflict that I love reading and playing around.",
      "Meaningful interaction most turns (shared map or market, blocking, trading); it shapes my plans.",
      "Some indirect interaction; I mostly watch my own board, or interaction is present but swingy.",
      "Multiplayer solitaire with a little scoreboard checking; mostly take-that or chaos; or a co-op one player can run.",
      "No meaningful interaction, or interaction that feels random or mean-spirited.",
    ],
  },
  {
    key: "replay",
    name: "Replayability & Strategic Variety",
    yardstick: "Fit-for-purpose",
    purpose:
      "How fresh the game stays over many plays. Every route counts equally: multiple viable strategies, different objectives, setup or map variety, emergent situations, asymmetric factions.",
    ask: "After 10 plays, are there still strategies, objectives or situations I want to explore?",
    bands: [
      "Every play feels different; several strategies or objectives I will not exhaust.",
      "Plenty of viable strategies or variety; new approaches keep emerging for many plays.",
      "A couple of workable strategies; plays start to feel similar after a handful.",
      "One dominant line, or samey after a few plays.",
      "Once is enough.",
    ],
  },
  {
    key: "art",
    name: "Art & Production",
    yardstick: "Fit-for-purpose",
    purpose:
      "How much YOU enjoy looking at and handling it: art style, components, table presence. Not whether others like it (that is Table Appeal).",
    ask: "Do I enjoy the look and feel of this on the table?",
    bands: [
      "Gorgeous; art and components make me want to set it up.",
      "Attractive and well produced; pleasant to handle.",
      "Functional; neither adds to nor detracts from the experience.",
      "Drab, cluttered or fiddly components that get in the way.",
      "Ugly or cheap enough to hurt the experience.",
    ],
  },
  {
    key: "theme",
    name: "Theme & Narrative",
    yardstick: "Fit-for-purpose, except avoided themes",
    purpose:
      "How much the game produces a story or sense of place. Themes you avoid (demons, spirits, horror) score 0-2 here however well done; also flag Avoid Theme.",
    ask: "After a play, do we talk about what happened? And is this a theme I want on my table?",
    bands: [
      "Memorable stories every play; mechanisms and theme are inseparable.",
      "Theme clearly supports the mechanisms; some good moments.",
      "Theme is a light coat of paint.",
      "Theme is pasted on or at odds with the mechanisms.",
      "A theme I avoid (demons, spirits, horror), or abstract with no story.",
    ],
  },
];

export const BAND_LABELS = ["9–10", "7–8", "5–6", "3–4", "0–2"];

// BGG's official rating descriptors (Legend tab, overall scale).
export const SCALE = [
  [10, "Outstanding", "Always want to play it; expect this experience to stay with me."],
  [9, "Excellent", "Very much want to play it; among my favorites."],
  [8, "Very good", "Enjoy playing it and will suggest it."],
  [7, "Good", "Usually willing to play."],
  [6, "Ok", "Will play if in the mood."],
  [5, "Average", "Slightly boring; take it or leave it."],
  [4, "Not so good", "It doesn't get me excited."],
  [3, "Likely won't play again", "Not fun; I'd rather do something else."],
  [2, "Bad", "Won't play this ever again."],
  [1, "Awful", "Defies game description."],
  [0, "Absent", "This quality is entirely missing."],
];

export const DEFAULT_SETTINGS = {
  weights: { desire: 40, table: 15, depth: 10, interaction: 10, replay: 10, art: 10, theme: 5 },
  stretch: 1.25,
  hideExpansions: false,
  includeWatching: false,
};

export const PROVISIONAL_PLAYS = 3;

/** Index into CRITERIA[].bands / BAND_LABELS for a 0-10 criterion score. */
export function bandIndex(score) {
  if (score >= 9) return 0;
  if (score >= 7) return 1;
  if (score >= 5) return 2;
  if (score >= 3) return 3;
  return 4;
}

export function scaleEntry(score) {
  const r = Math.max(0, Math.min(10, Math.round(score)));
  return SCALE.find(([n]) => n === r);
}

export function weightTotal(weights) {
  return CRITERIA.reduce((t, c) => t + (Number(weights[c.key]) || 0), 0);
}

export function scoredCount(scores = {}) {
  return CRITERIA.filter((c) => isNum(scores[c.key])).length;
}

/** Weighted average of the 7 criteria, or null until all 7 are entered. */
export function rawAverage(scores, settings = DEFAULT_SETTINGS) {
  if (scoredCount(scores) !== CRITERIA.length) return null;
  const total = weightTotal(settings.weights);
  if (!total) return null;
  const sum = CRITERIA.reduce((t, c) => t + scores[c.key] * (Number(settings.weights[c.key]) || 0), 0);
  return sum / total;
}

/** Final score: 5 + (raw - 5) * stretch, clamped to 0-10, one decimal. */
export function finalScore(scores, settings = DEFAULT_SETTINGS) {
  const raw = rawAverage(scores, settings);
  if (raw === null) return null;
  const stretched = 5 + (raw - 5) * settings.stretch;
  // Epsilon nudge so x.x5 rounds half-up like Excel ROUND despite float error.
  return Math.round(Math.max(0, Math.min(10, stretched)) * 10 + 1e-9) / 10;
}

export function rescoreStatus(scores) {
  const n = scoredCount(scores);
  if (n === CRITERIA.length) return "Scored";
  if (n === 0) return "Not yet rescored";
  return `Partial (${n}/${CRITERIA.length})`;
}

export function isProvisional(game) {
  return (game.plays || 0) < PROVISIONAL_PLAYS;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Spread stats matching the Summary tab. */
export function spread(values) {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
  const sd = n > 1 ? Math.sqrt(xs.reduce((t, x) => t + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const share = (f) => xs.filter(f).length / n;
  return {
    n,
    mean,
    median,
    sd,
    pct9: share((x) => x >= 9),
    pct8: share((x) => x >= 8 && x < 9),
    pctBelow6: share((x) => x < 6),
    histogram: Array.from({ length: 10 }, (_, i) => {
      const s = 10 - i;
      return [s, xs.filter((x) => x >= s - 0.5 && x < s + 0.5).length];
    }),
  };
}
