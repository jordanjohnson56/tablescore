// Seed watched games from JSON, in the game shape the watchlist export writes.
// Usage: npm run import-watchlist -- /path/to/watchlist.json
// The file holds an array of games, or is a whole watchlist export. Games already
// in the database (same BGG ID, or same name ignoring case) are skipped.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkWatchFields, openDb } from "./db.js";

const FIELDS = ["name", "bggId", "notes", "watchStage", "campaignUrl", "platform", "campaignEnd", "deliveryEst", "predictedScore", "targetPrice", "targetCurrency"];

/** Read a JSON file: an array of games, or a watchlist export's games. */
export function readWatchlistFile(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new Error(`No file at ${file}`);
  }
  // What Docker hands you when a -v source path doesn't exist on the host.
  if (st.isDirectory()) throw new Error(`${file} is a folder, not a JSON file. If you mounted it with docker -v, the host path was wrong.`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message})`);
  }
  return data && !Array.isArray(data) && Array.isArray(data.games) ? data.games : data;
}

/**
 * Create each watched game that isn't already in the store, matched by BGG ID
 * or by name ignoring case. Matches are skipped, never
 * overwritten. Every game is checked first, so bad input throws and writes nothing.
 */
export function importWatchlist(store, games) {
  const valid = check(games);
  const added = [];
  const skipped = [];
  store.transaction(() => {
    for (const g of valid) {
      if (findExisting(store, g)) {
        skipped.push(g.name);
        continue;
      }
      store.createGame(g);
      added.push(g.name);
    }
  });
  return { added, skipped };
}

// Throw on the first bad game; otherwise return each game cut down to the fields
// createGame takes (the export's "decided" flag is dropped).
function check(games) {
  if (!Array.isArray(games)) throw new Error("Expected a JSON array of watched games");
  return games.map((g, i) => {
    if (!g || typeof g !== "object" || Array.isArray(g)) throw new Error(`game ${i + 1} is not an object`);
    if (typeof g.name !== "string" || !g.name.trim()) throw new Error(`game ${i + 1} has no name`);
    const fail = (msg) => {
      throw new Error(`game ${i + 1} (${g.name}): ${msg}`);
    };
    if (g.bggId != null && !(Number.isInteger(g.bggId) && g.bggId > 0)) fail("bggId must be a positive whole number or null");
    if (g.notes != null && typeof g.notes !== "string") fail("notes must be text");
    if (g.watchStage == null || g.watchStage === "") fail("watchStage is required for a watched game");
    try {
      checkWatchFields(g);
    } catch (e) {
      fail(e.message);
    }
    return Object.fromEntries(FIELDS.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]));
  });
}

// The same game: equal BGG IDs, or the same name ignoring case (so a game added
// by hand without a BGG ID isn't duplicated by an import that carries one).
function findExisting(store, g) {
  const name = g.name.trim().toLowerCase();
  return (g.bggId && store.getByBggId(g.bggId)) || store.listGames().find((e) => e.name.trim().toLowerCase() === name);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run import-watchlist -- /path/to/watchlist.json");
    process.exit(1);
  }
  const store = openDb(join(process.env.DATA_DIR || "data", "tablescore.db"));
  let result;
  try {
    result = importWatchlist(store, readWatchlistFile(file));
  } catch (e) {
    console.error(`Import failed, nothing written: ${e.message}`);
    process.exit(1);
  }
  console.log(`Imported: ${result.added.length} added, ${result.skipped.length} already present`);
  for (const name of result.added) console.log(`  added    ${name}`);
  for (const name of result.skipped) console.log(`  skipped  ${name}`);
}
