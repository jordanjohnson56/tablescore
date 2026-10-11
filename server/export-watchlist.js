// Watchlist export for the monthly routine, which reads it from a private repo (ADR 0001).
// Usage: npm run export-watchlist -- /path/to/private-repo/watchlist.json
// GET /api/watchlist serves the same JSON. Each game uses the API's field names,
// so the watchlist import can read the file back.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WATCH_FIELDS, openDb } from "./db.js";
import { isDecided, sortWatchlist, targetCurrency } from "../public/js/watchlist.js";

export function watchlistExport(store, now = new Date()) {
  const { weights, stretch } = store.getSettings();
  return {
    exportedAt: now.toISOString(),
    settings: { weights, stretch },
    games: sortWatchlist(store.listGames()).map((g) => ({
      name: g.name,
      bggId: g.bggId,
      ...Object.fromEntries(Object.keys(WATCH_FIELDS).map((k) => [k, g[k]])),
      decided: isDecided(g),
      targetCurrency: targetCurrency(g),
      notes: g.notes,
    })),
  };
}

export function writeWatchlist(store, file) {
  const data = watchlistExport(store);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run export-watchlist -- /path/to/watchlist.json");
    process.exit(1);
  }
  const store = openDb(join(process.env.DATA_DIR || "data", "tablescore.db"));
  let data;
  try {
    data = writeWatchlist(store, file);
  } catch (e) {
    console.error(`Export failed: ${e.message}`);
    process.exit(1);
  }
  const decided = data.games.filter((g) => g.decided).length;
  console.log(`Exported ${data.games.length} watched games (${decided} decided) to ${file}`);
}
