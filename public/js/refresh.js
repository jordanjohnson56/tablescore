// When the app fetches its state again: on resume, after a BGG sync, and when a refresh was owed.
// No DOM access, so node:test can import it.

/** State older than this is fetched again when the app comes back into view. */
export const STALE_MS = 60_000;

/** True when state loaded at `loadedAt` (0 = never) is old enough to fetch again at `now`. */
export const isStale = (loadedAt, now) => !loadedAt || now - loadedAt > STALE_MS;

/** True for an element the owner types or picks into: a repaint would throw away what is in it. */
export function isEditable(el) {
  if (!el) return false;
  return el.isContentEditable === true || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
}

/** A refresh may run only when the save queue is idle (`busy` false) and no field has focus. */
export const canRefresh = ({ busy, focused }) => !busy && !isEditable(focused);

/**
 * Whether the screen at `hash` is repainted after a refresh. Discover, Settings and the prediction
 * page hold unsaved form fields and run their own loaders, so they take the new state without one.
 */
export const repaintsAfterRefresh = (hash) => !["#/discover", "#/settings", "#/predict/"].some((p) => hash.startsWith(p));

/**
 * One look at the BGG sync job. `seen` is what the last look recorded (null before the first).
 * Returns the new `seen` and whether a sync finished since the last look. The first look only
 * records; a server restart clears `finishedAt`, which is not a finish.
 */
export function syncStep(seen, job) {
  const next = { running: !!job.running, finishedAt: job.finishedAt ?? null };
  const finished =
    seen != null && !next.running && next.finishedAt != null && (seen.running || seen.finishedAt !== next.finishedAt);
  return { seen: next, finished };
}

/** The toast for a finished sync, shown when the owner is away from Settings. */
export function syncToast(job) {
  if (job.error) return `BGG sync failed: ${job.error}`;
  const r = job.result || {};
  return `BGG sync finished: ${r.added ?? 0} new, ${r.updated ?? 0} updated`;
}
