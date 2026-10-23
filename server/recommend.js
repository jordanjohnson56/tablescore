// Recommendations: Claude nominates games the user hasn't got, each nominee is
// matched to BGG and predicted, and the best predictions are shown. Runs on a
// schedule (see RecommendScheduler) or when the user asks for a refresh.
import { RECOMMEND_FREQUENCIES, finalScore } from "../public/js/rubric.js";
import { isWatching } from "../public/js/watchlist.js";
import { PredictError, scoreContext, tasteProfile } from "./predict.js";
import { BggError } from "./bgg.js";

export const SHOWN = 5; // picks shown
export const MAX_EXPANSIONS = 1; // among the shown picks
export const REUSE_DAYS = 30; // a prediction younger than this is reused instead of made again
export const EXPANSION_BASE_MIN = 8; // only expansions of base games scored this high are allowed
const RUN_HOUR = 4; // scheduled runs happen at this hour, local time

export const DROP = {
  unmatched: "not found on BGG",
  duplicate: "same game as an earlier nominee",
  inList: "already in your list",
  dismissed: "marked not interested",
  expansionBase: "expansion of a game you haven't scored 8+",
  avoidTheme: "a theme you avoid",
  failed: "prediction failed",
  expansionLimit: "second expansion",
  notTop: "not in the top 5",
};

/** The system prompt for nominating: who the user is and what they've scored. Stable between runs, so it caches. */
export function buildNominateSystem(games, settings) {
  const scores = scoreContext(games, settings);
  const other = games
    .filter((g) => !scores.scored.includes(g) && (isWatching(g) || g.bggId != null || g.plays > 0))
    .map((g) => g.name)
    .sort((a, b) => a.localeCompare(b));
  return [
    "You recommend board games to one gamer, using their personal rubric scores. Each game you nominate is then scored by a separate prediction and the highest predicted scores are shown to them, so nominate games they would score highly, not games that are merely popular.",
    "",
    "## Rules",
    "- Nominate only games that are in print or have an announced retail release. Skip games that can only be had through a live crowdfunding campaign.",
    "- Never nominate a game listed below as scored, in their list, or not interested. Prefer games not recommended recently, unless one is clearly the best fit.",
    "- An expansion is allowed only for a base game they scored 8 or higher, and nominate at most two expansions.",
    "- Search the web for new and upcoming releases and for reviews of games you aren't sure about. Don't search for games you already know well.",
    "- Give each nominee's BoardGameGeek ID only when you are certain of it; otherwise leave it 0. The name and year are matched against BGG, so use BGG's spelling.",
    "- In each reason, name the scored game it most resembles and what the resemblance is.",
    "- When you're done, call submit_nominees once.",
    "",
    "## Their taste in their own words",
    tasteProfile(settings),
    "",
    ...scores.lines,
    "",
    `## Other games in their list (${other.length}, unscored or watched)`,
    other.length ? other.join("; ") : "(none)",
  ].join("\n");
}

/** The user message: how many to nominate, the Hotness list, dismissals and recent picks. */
export function buildNominateUser({ count, hotness = [], dismissed = [], recent = [] }) {
  const lines = [`Nominate ${count} games for me to look at, best fit first.`, ""];
  if (hotness.length) {
    lines.push(
      "BoardGameGeek's Hotness list right now (popularity, not fit; use it to spot new releases):",
      ...hotness.map((h) => `- ${h.name}${h.year ? ` (${h.year})` : ""}, BGG ID ${h.bggId}`),
      "",
    );
  }
  if (recent.length) lines.push(`Recommended recently (prefer others): ${recent.map((r) => r.name).join("; ")}`, "");
  if (dismissed.length) lines.push(`Not interested (never nominate, and learn from them): ${dismissed.map((d) => d.name).join("; ")}`, "");
  return lines.join("\n").trim();
}

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Does a BGG entry match the nominee? The same name always does. One name
 * being a word-prefix of the other ("Arcs" for "Arcs: The Blighted Reach")
 * counts only when both years are known and within a year of each other,
 * so "Dune" with no year can't land on "Dune: Imperium".
 */
export function matches(nominee, thing) {
  const a = norm(nominee.name);
  const b = norm(thing.name);
  if (!a || !b) return false;
  const yearsKnown = nominee.year != null && thing.year != null;
  if (yearsKnown && Math.abs(nominee.year - thing.year) > 1) return false;
  if (a === b) return true;
  return yearsKnown && (b.startsWith(`${a} `) || a.startsWith(`${b} `));
}

/**
 * Find a nominee on BGG: by its ID when Claude gave one that checks out, else
 * by a name search. Returns the full details, or null.
 */
export async function matchNominee(bgg, nominee, log = console) {
  if (nominee.bggId) {
    try {
      const d = await bgg.details(nominee.bggId);
      if (d && matches(nominee, d)) return d;
    } catch (e) {
      log.error(`BGG details for ${nominee.bggId} failed, searching by name:`, e.message);
    }
  }
  const results = await bgg.search(nominee.name);
  const same = results.filter((r) => matches(nominee, r));
  // Exact names first, then the year Claude gave, then BGG's order.
  same.sort((x, y) => (norm(y.name) === norm(nominee.name)) - (norm(x.name) === norm(nominee.name)) || (y.year === nominee.year) - (x.year === nominee.year));
  const hit = same[0];
  return hit ? bgg.details(hit.bggId) : null;
}

/**
 * One recommendation run. `predict(target, details)` runs a prediction through
 * the app's queue and resolves with the finished prediction (or throws).
 */
export async function runRecommendations({ store, bgg, predictor, predict, trigger = "schedule", now = () => new Date(), log = console }) {
  if (!predictor.configured) throw new PredictError("ANTHROPIC_API_KEY is not set on the server");
  if (!bgg.configured) throw new BggError("BGG_TOKEN is not set on the server");
  const run = store.createRecommendationRun({ model: predictor.model, trigger, startedAt: now().toISOString() });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
  const counts = { predicted: 0, reused: 0 };
  try {
    const settings = store.getSettings();
    const games = store.listGames();
    let hotness = [];
    try {
      hotness = await bgg.hot();
    } catch (e) {
      log.error("BGG hotness failed, nominating without it:", e.message);
    }
    const count = Math.max(SHOWN, settings.recommendNominees);
    const nominated = await predictor.nominate({
      system: buildNominateSystem(games, settings),
      user: buildNominateUser({ count, hotness, dismissed: store.listDismissed(), recent: store.recentRecommendations() }),
      count,
    });
    addUsage(usage, nominated.usage);

    const since = new Date(now().getTime() - REUSE_DAYS * 86400000).toISOString();
    const candidates = [];
    const seen = new Set();
    for (const n of nominated.nominees) {
      const entry = { name: n.name, year: n.year, bggId: n.bggId, type: n.expansion ? "Expansion" : "Base", reason: n.reason };
      let details = null;
      try {
        details = await matchNominee(bgg, n, log);
      } catch (e) {
        log.error(`BGG lookup for "${n.name}" failed:`, e.message);
      }
      if (!details || seen.has(details.bggId)) {
        store.addRecommendation(run.id, { ...entry, dropped: details ? DROP.duplicate : DROP.unmatched });
        continue;
      }
      seen.add(details.bggId);
      Object.assign(entry, { bggId: details.bggId, name: details.name, year: details.year, type: details.type, thumbnail: details.thumbnail });
      const dropped = exclusion(store, games, settings, details);
      if (dropped) {
        store.addRecommendation(run.id, { ...entry, dropped });
        continue;
      }
      let prediction = store.recentPrediction(details.bggId, since);
      if (prediction) counts.reused++;
      else {
        try {
          prediction = await predict({ bggId: details.bggId, name: details.name }, details);
          counts.predicted++;
          addUsage(usage, prediction.usage);
        } catch (e) {
          log.error(`prediction for "${details.name}" failed:`, e.message);
          store.addRecommendation(run.id, { ...entry, dropped: `${DROP.failed}: ${e.message}` });
          continue;
        }
      }
      if (prediction.avoidTheme) {
        store.addRecommendation(run.id, { ...entry, predictionId: prediction.id, dropped: DROP.avoidTheme });
        continue;
      }
      candidates.push({ ...entry, predictionId: prediction.id, final: prediction.final });
    }

    candidates.sort((a, b) => b.final - a.final || a.name.localeCompare(b.name));
    let rank = 0;
    let expansions = 0;
    for (const c of candidates) {
      let dropped = null;
      if (rank >= SHOWN) dropped = DROP.notTop;
      else if (c.type === "Expansion" && expansions >= MAX_EXPANSIONS) dropped = DROP.expansionLimit;
      if (dropped) {
        store.addRecommendation(run.id, { ...c, dropped });
        continue;
      }
      if (c.type === "Expansion") expansions++;
      store.addRecommendation(run.id, { ...c, rank: ++rank });
    }
    if (rank < SHOWN) {
      throw new PredictError(`Only ${rank} of ${SHOWN} recommendations could be made. The last good set is kept.`);
    }
    return store.finishRecommendationRun(run.id, { usage, ...counts });
  } catch (e) {
    if (!(e instanceof PredictError || e instanceof BggError)) log.error("recommendation run failed:", e);
    return store.failRecommendationRun(run.id, e.message || "recommendation run failed", { usage, ...counts });
  }
}

/** Why a matched nominee can't be recommended, or null. */
function exclusion(store, games, settings, details) {
  if (store.getByBggId(details.bggId)) return DROP.inList;
  if (store.isDismissed(details.bggId)) return DROP.dismissed;
  if (details.type === "Expansion") {
    const ok = (details.baseGames || []).some((b) => {
      const mine = games.find((g) => g.bggId === b.bggId);
      const score = mine ? finalScore(mine.scores, settings) : null;
      return score != null && score >= EXPANSION_BASE_MIN;
    });
    if (!ok) return DROP.expansionBase;
  }
  return null;
}

function addUsage(total, u) {
  if (!u) return;
  for (const k of Object.keys(total)) total[k] += u[k] || 0;
}

// A due run that the scheduler notices later than this (the server was down,
// or asleep) waits for the next RUN_HOUR instead of running mid-day.
const GRACE_MS = 3600000;

/**
 * When the next scheduled run is due: RUN_HOUR o'clock on the day the last
 * successful run's start plus the interval lands on (the next day if that run
 * started well after RUN_HOUR, as a manual refresh does). With no run yet, the
 * first RUN_HOUR after `now`. A due time that `floor` (the start of a failed
 * run) has passed moves to the first RUN_HOUR after it, and one more than an
 * hour before `now` moves to the first RUN_HOUR after now. Null when off.
 */
export function nextRunAt(frequency, lastStartedAt, now, floor = null) {
  const f = RECOMMEND_FREQUENCIES.find((x) => x.key === frequency);
  if (!f || !f.days) return null;
  const earliest = lastStartedAt ? new Date(new Date(lastStartedAt).getTime() + f.days * 86400000) : now;
  const at = new Date(earliest);
  at.setHours(RUN_HOUR, 0, 0, 0);
  if (at.getTime() < earliest.getTime() - GRACE_MS) at.setDate(at.getDate() + 1);
  for (const after of [floor, new Date(now.getTime() - GRACE_MS)]) {
    if (!after || at > after) continue;
    at.setTime(after.getTime());
    at.setHours(RUN_HOUR, 0, 0, 0);
    if (at <= after) at.setDate(at.getDate() + 1);
  }
  return at;
}

/**
 * Fires the scheduled run. Checks every `tickMs` whether one is due. `run`
 * returns false when it can't start one (no keys, or a run already going).
 */
export class RecommendScheduler {
  constructor({ store, run, tickMs = 5 * 60 * 1000, now = () => new Date(), timers = globalThis }) {
    this.store = store;
    this.run = run;
    this.tickMs = tickMs;
    this.now = now;
    this.timers = timers;
    this.timer = null;
  }

  get nextRunAt() {
    const settings = this.store.getSettings();
    const failed = this.store.lastRecommendationRun("failed");
    const now = this.now();
    const floor = failed ? new Date(failed.startedAt) : null;
    return nextRunAt(settings.recommendFrequency, this.store.lastRecommendationRun()?.startedAt, now, floor);
  }

  start() {
    this.timer = this.timers.setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** Run if due and nothing is running. Returns true when a run was started. */
  tick() {
    const due = this.nextRunAt;
    if (!due || due > this.now()) return false;
    return this.run({ trigger: "schedule" });
  }
}
