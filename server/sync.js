// Pulls the user's BGG collection into the database. BGG owns status, plays,
// rating and game metadata; rubric scores, notes and flags are never touched.

/** Sync the collection, then fill in weight and best player counts from /thing. */
export async function syncCollection(store, bgg, username, progress = () => {}) {
  progress({ phase: "Fetching your BGG collection" });
  const items = await bgg.collection(username);

  let added = 0;
  let updated = 0;
  store.transaction(() => {
    for (const item of items) {
      const existing = store.getByBggId(item.bggId);
      if (existing) {
        const { name, type, ...rest } = item; // keep any name or type edited in the app
        store.applyBgg(existing.id, rest);
        updated++;
      } else {
        store.createGame(item);
        added++;
      }
    }
  });

  const linked = await linkWatchedByName(store, bgg, progress);

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
  return { collection: items.length, added, updated, linked, enriched };
}

/**
 * Give each watched game that has no BGG ID one, when BGG has exactly one game
 * (base or expansion) with the same name ignoring case. Anything less certain is
 * left unlinked. Returns how many were linked.
 */
async function linkWatchedByName(store, bgg, progress) {
  const unlinked = store.listGames().filter((g) => g.watchStage && !g.bggId);
  let linked = 0;
  for (const [i, g] of unlinked.entries()) {
    progress({ phase: "Matching watched games to BGG", done: i, total: unlinked.length });
    const name = g.name.trim().toLowerCase();
    let results;
    try {
      results = await bgg.search(g.name.trim());
    } catch {
      continue; // one failed search shouldn't sink the whole sync; this game is retried next time
    }
    const found = results.filter((r) => r.name.trim().toLowerCase() === name);
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
