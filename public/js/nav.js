// Where the page scrolls after a navigation, and when the back arrow can go back instead of pushing.
// No DOM access, so node:test can import it.

/** Screens that were merged into Discover; route() sends them there. */
export const MERGED = ["#/add", "#/predictions"];
const TABS = ["#/watchlist", "#/discover", "#/summary", "#/settings"];
/** Lists that keep their position while a game or prediction page is open over them. */
const RESTORED = ["#/", "#/watchlist", "#/summary"];

/** The screen route() draws for `hash`, as one canonical hash: "#/" for the Games list and anything unknown. */
export function screenKey(hash) {
  const h = hash || "#/";
  const game = h.match(/^#\/g\/\d+/);
  if (game) return game[0];
  const predict = h.match(/^#\/predict\/(?:bgg|game)\/\d+/);
  if (predict) return predict[0];
  if (MERGED.some((p) => h.startsWith(p))) return "#/discover";
  return TABS.find((t) => h.startsWith(t)) || "#/";
}

/** True for a game page or prediction page key. */
export const isDetail = (key) => key.startsWith("#/g/") || key.startsWith("#/predict/");

/**
 * Remembers the Games list, Watchlist and Summary positions while a game or prediction page is open.
 * Call `leave` before drawing the new screen and `arrive` for the y to scroll to after.
 */
export function createScrollMemory() {
  const saved = new Map();
  return {
    /** Leaving `fromHash` at scroll `y` for `toHash`. */
    leave(fromHash, toHash, y) {
      const from = screenKey(fromHash);
      if (!RESTORED.includes(from)) return;
      if (isDetail(screenKey(toHash))) saved.set(from, y);
      else saved.delete(from);
    },
    /** The y to scroll to on arriving at `toHash` from `fromHash`: a saved position only when coming back from a detail page. */
    arrive(fromHash, toHash) {
      const to = screenKey(toHash);
      if (isDetail(to)) return 0;
      if (!isDetail(screenKey(fromHash))) {
        saved.delete(to);
        return 0;
      }
      return saved.get(to) ?? 0;
    },
  };
}

/**
 * Whether the back arrow pointing at `href` can call history.back() instead of pushing: true when the
 * history entry's `state.from` (the hash beneath it, stamped by app.js) is the same screen.
 */
export const goesBack = (state, href) => typeof state?.from === "string" && screenKey(state.from) === screenKey(href);
