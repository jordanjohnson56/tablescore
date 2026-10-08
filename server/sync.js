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

  const needDetails = store.listGames().filter((g) => g.bggId && (g.bggWeight == null || !g.bestPlayers));
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
  return { collection: items.length, added, updated, enriched };
}

/** Add one game by BGG id with its details filled in. */
export async function addFromBgg(store, bgg, bggId) {
  const existing = store.getByBggId(bggId);
  if (existing) return { game: existing, existed: true };
  const [details] = await bgg.things([bggId]);
  if (!details) return { game: null };
  return { game: store.createGame(details), existed: false };
}
