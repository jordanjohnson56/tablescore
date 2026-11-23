// The save queue: a game's edits are batched into one PATCH and sent one PATCH per game at a time.
// A PATCH that fails on the way (no response, 5xx, 408, 429) stays queued and is retried; one the
// server rejects is re-sent a field at a time so only the bad field is lost. No DOM access, so
// node:test can import it.

/** Wait before each retry; the last one repeats for as long as the save keeps failing. */
export const RETRY_DELAYS = [2000, 5000, 15000, 30000];
/** Browsers cap keepalive request bodies at about 64 KiB; a bigger body goes without it. */
export const KEEPALIVE_LIMIT = 60000;

/** Lay `patch` over `body`: newer keys win, scores merge per criterion. */
export function mergePatch(body, patch) {
  const out = { ...body };
  for (const [k, v] of Object.entries(patch)) out[k] = k === "scores" ? { ...out.scores, ...v } : v;
  return out;
}

/** Update `game` in place from the server's copy, then put back edits not yet saved. Returns `game`. */
export function applySaved(game, saved, unsent = {}) {
  Object.assign(game, saved);
  for (const [k, v] of Object.entries(unsent)) game[k] = k === "scores" ? { ...game.scores, ...v } : v;
  return game;
}

/** Fold freshly fetched games into the current list, keeping each existing game's object. */
export function mergeGames(current, fresh, unsent) {
  const old = new Map(current.map((g) => [g.id, g]));
  return fresh.map((g) => (old.has(g.id) ? applySaved(old.get(g.id), g, unsent(g.id)) : g));
}

/** A failure worth sending again: no response at all, a server error, a timeout or a rate limit. */
const retryable = (err) => err?.status == null || err.status >= 500 || err.status === 408 || err.status === 429;

/** One body per field, and one per criterion, so the server can reject each on its own. */
function splitPatch(body) {
  return Object.entries(body).flatMap(([k, v]) =>
    k === "scores" ? Object.entries(v || {}).map(([ck, cv]) => ({ scores: { [ck]: cv } })) : [{ [k]: v }],
  );
}

const isEmpty = (body) => !Object.keys(body).length;

/**
 * Create the save queue.
 *
 * - `patch(id, body, { keepalive })` sends one PATCH and resolves with the saved game.
 * - `apply(id, saved, unsent)` puts a saved game into the page; `unsent` is what is still to go.
 * - `onState(state, previous)` hears each change of `state()`.
 * - `onReject(id, err)` hears a field the server rejected (dropped), or a 404 (everything dropped).
 *
 * Returns:
 * - `queue(id, patch)`: add an edit; it goes after `delay` ms of quiet, or after the PATCH in flight.
 * - `flushAll({ keepalive })`: send everything waiting now (the page is being hidden).
 * - `retry()`: send everything waiting now, without waiting for a backoff (back online, page shown).
 * - `drop(id)`: forget a game's edits (it was deleted); a late response is ignored.
 * - `unsent(id)`: every edit to a game not yet saved, in flight included, as one patch.
 * - `state()`: "saved" when nothing is queued, in flight or waiting to retry; "error" while any
 *   game's save is failing; otherwise "saving".
 * - `busy()`: true unless `state()` is "saved".
 */
export function createSaveQueue({
  patch,
  apply,
  onState = () => {},
  onReject = () => {},
  delay = 450,
  retryDelays = RETRY_DELAYS,
  keepaliveLimit = KEEPALIVE_LIMIT,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // id → { parts: single-field bodies after a rejection, body: newer edits, inflight, timer, failures, keepalive }
  const entries = new Map();
  let last = "saved";

  const queued = (e) => e.parts.length > 0 || !isEmpty(e.body);

  function state() {
    let s = "saved";
    for (const e of entries.values()) {
      if (e.failures) return "error";
      if (e.inflight || queued(e)) s = "saving";
    }
    return s;
  }

  function report() {
    const s = state();
    if (s === last) return;
    const prev = last;
    last = s;
    onState(s, prev);
  }

  function schedule(id, e, ms) {
    clearTimer(e.timer);
    e.timer = setTimer(() => {
      e.timer = null;
      send(id);
    }, ms);
  }

  function queue(id, edit) {
    let e = entries.get(id);
    if (!e) entries.set(id, (e = { parts: [], body: {}, inflight: null, timer: null, failures: 0, keepalive: false }));
    e.body = mergePatch(e.body, edit);
    // An edit made during a PATCH waits for it; otherwise it restarts the quiet period (and cuts a backoff short).
    if (!e.inflight) schedule(id, e, delay);
    report();
  }

  function send(id, keepalive = false) {
    const e = entries.get(id);
    if (!e || e.inflight || !queued(e)) return;
    clearTimer(e.timer);
    e.timer = null;
    const fromParts = e.parts.length > 0;
    const body = fromParts ? e.parts.shift() : e.body;
    if (!fromParts) e.body = {};
    e.inflight = body;
    const ka = (keepalive || e.keepalive) && JSON.stringify(body).length <= keepaliveLimit;
    e.keepalive = false;
    report();
    new Promise((resolve) => resolve(patch(id, body, { keepalive: ka }))).then(
      (saved) => settle(id, e, body, fromParts, saved, null),
      (err) => settle(id, e, body, fromParts, null, err),
    );
  }

  function settle(id, e, body, fromParts, saved, err) {
    if (entries.get(id) !== e) return; // dropped while in flight
    e.inflight = null;
    let rejected = null;
    if (!err) {
      e.failures = 0;
      apply(id, saved, unsent(id));
    } else if (retryable(err)) {
      if (fromParts) e.parts.unshift(body);
      else e.body = mergePatch(body, e.body);
      e.failures++;
      schedule(id, e, retryDelays[Math.min(e.failures, retryDelays.length) - 1]);
      report();
      return;
    } else if (err.status === 404) {
      clearTimer(e.timer);
      entries.delete(id);
      report();
      onReject(id, err);
      return;
    } else {
      e.failures = 0; // the server answered, so nothing is failing on the way
      const parts = splitPatch(body);
      if (parts.length > 1) e.parts.unshift(...parts);
      else rejected = err;
    }
    if (queued(e)) {
      if (!e.timer) send(id);
    } else if (!e.timer) {
      entries.delete(id);
    }
    report();
    if (rejected) onReject(id, rejected);
  }

  function unsent(id) {
    const e = entries.get(id);
    if (!e) return {};
    return [e.inflight, ...e.parts, e.body].filter(Boolean).reduce(mergePatch, {});
  }

  function flushAll({ keepalive = false } = {}) {
    for (const [id, e] of entries) {
      if (e.inflight) e.keepalive ||= keepalive; // its follow-up goes as soon as it settles
      else send(id, keepalive);
    }
  }

  function retry() {
    for (const id of [...entries.keys()]) send(id);
  }

  function drop(id) {
    const e = entries.get(id);
    if (!e) return;
    clearTimer(e.timer);
    entries.delete(id);
    report();
  }

  return { queue, flushAll, retry, drop, unsent, state, busy: () => state() !== "saved" };
}
