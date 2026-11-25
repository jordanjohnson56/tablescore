// Pulls the user's BGG collection into the database. BGG owns status, plays,
// rating and game metadata; rubric scores, notes and flags are never touched.
// A watched game with no BGG ID is first matched by name to a new collection
// item, then to BGG by search.

/** The form two names are compared in: surrounding spaces trimmed, case ignored. */
const sameName = (s) => s.trim().toLowerCase();

/** Group `list` into a Map of key -> array. */
function groupBy(list, key) {
  const m = new Map();
  for (const x of list) m.set(key(x), [...(m.get(key(x)) || []), x]);
  return m;
}

/**
 * Sync the collection, then fill in weight and best player counts from /thing.
 * A collection item whose BGG ID is new is given to the one unlinked watched game
 * with its name, when no other new item has that name; otherwise it is added.
 */
export async function syncCollection(store, bgg, username, progress = () => {}) {
  progress({ phase: "Fetching your BGG collection" });
  const items = await bgg.collection(username);

  let added = 0;
  let updated = 0;
  let linkedFromCollection = 0;
  store.transaction(() => {
    const unlinkedWatched = groupBy(store.listGames().filter((g) => g.watchStage && !g.bggId), (g) => sameName(g.name));
    const newIds = new Map(); // name -> distinct BGG IDs of items not yet in the database
    for (const item of items) {
      if (store.getByBggId(item.bggId)) continue;
      const key = sameName(item.name || "");
      newIds.set(key, (newIds.get(key) || new Set()).add(item.bggId));
    }
    for (const item of items) {
      const existing = store.getByBggId(item.bggId);
      const { name, type, ...rest } = item; // keep any name or type edited in the app
      if (existing) {
        store.applyBgg(existing.id, rest);
        updated++;
        continue;
      }
      const key = sameName(name || "");
      const watched = key && unlinkedWatched.get(key);
      if (watched?.length === 1 && newIds.get(key).size === 1) {
        store.applyBgg(watched[0].id, rest);
        unlinkedWatched.delete(key);
        linkedFromCollection++;
      } else {
        store.createGame(item);
        added++;
      }
    }
  });

  const linkedBySearch = await linkWatchedByName(store, bgg, progress);

  // /thing also carries the images, so watched games outside the collection get theirs here.
  const needDetails = store.listGames().filter((g) => g.bggId && (g.bggWeight == null || !g.bestPlayers || !g.thumbnail));
  let enriched = 0;
  for (let i = 0; i < needDetails.length; i += 20) {
    progress({ phase: "Fetching game details", done: i, total: needDetails.length });
    const batch = needDetails.slice(i, i + 20);
    const details = await bgg.things(batch.map((g) => g.bggId));
    store.transaction(() => {
      for (const d of details) {
        const g = store.getByBggId(d.bggId);
        if (!g) continue;
        const { name, type, ...rest } = d;
        if (g.bestPlayers) delete rest.bestPlayers;
        store.applyBgg(g.id, rest);
        enriched++;
      }
    });
  }
  return { collection: items.length, added, updated, linked: linkedFromCollection + linkedBySearch, enriched };
}

/**
 * Give each watched game still without a BGG ID after the collection step one,
 * when BGG has exactly one game (base or expansion) with the same name ignoring
 * case. Anything less certain is left unlinked. Returns how many were linked.
 */
async function linkWatchedByName(store, bgg, progress) {
  const unlinked = store.listGames().filter((g) => g.watchStage && !g.bggId);
  let linked = 0;
  for (const [i, g] of unlinked.entries()) {
    progress({ phase: "Matching watched games to BGG", done: i, total: unlinked.length });
    const name = sameName(g.name);
    let results;
    try {
      results = await bgg.search(g.name.trim());
    } catch {
      continue; // one failed search shouldn't sink the whole sync; this game is retried next time
    }
    const found = results.filter((r) => sameName(r.name) === name);
    const matches = [...new Map(found.map((r) => [r.bggId, r])).values()]; // BGG can list one game as both base and expansion
    if (matches.length !== 1 || store.getByBggId(matches[0].bggId)) continue;
    store.applyBgg(g.id, { bggId: matches[0].bggId });
    linked++;
  }
  return linked;
}

/**
 * Add one game by BGG id with its details filled in, plus any watch fields.
 * A game already in the list is returned unchanged.
 */
export async function addFromBgg(store, bgg, bggId, watch = {}) {
  const existing = store.getByBggId(bggId);
  if (existing) return { game: existing, existed: true };
  const [details] = await bgg.things([bggId]);
  if (!details) return { game: null };
  return { game: store.createGame({ ...details, ...watch }), existed: false };
}

/**
 * Point an existing game at BGG's details for it, keeping the game's own name,
 * type and everything the user entered.
 */
export function linkToBgg(store, id, details) {
  const { name, type, ...rest } = details;
  return store.applyBgg(id, rest);
}
