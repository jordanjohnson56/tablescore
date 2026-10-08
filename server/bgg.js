// BoardGameGeek XML API2 client. Needs a registered app token (Bearer auth).
// BGG asks for roughly one request every few seconds, so calls are spaced out.
import { XMLParser } from "fast-xml-parser";

const BASE = "https://boardgamegeek.com/xmlapi2";
const THING_BATCH = 20; // BGG's per-request id limit for /thing

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  htmlEntities: true,
  parseAttributeValue: false,
  isArray: (name, _path, _leaf, isAttribute) =>
    !isAttribute && ["item", "name", "poll", "results", "result", "link"].includes(name),
});

export class BggError extends Error {}

export class BggClient {
  constructor({ token, fetchImpl = fetch, spacingMs = 5000, retryMs = 5000, maxRetries = 8, sleep } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.spacingMs = spacingMs;
    this.retryMs = retryMs;
    this.maxRetries = maxRetries;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nextAt = 0;
  }

  get configured() {
    return !!this.token;
  }

  async get(path, params) {
    if (!this.token) throw new BggError("BGG_TOKEN is not set on the server");
    const url = `${BASE}/${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = Date.now() + this.spacingMs;
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
      // 202 = collection request queued on BGG's side; 429 = slow down. Both mean retry.
      if ((res.status === 202 || res.status === 429) && attempt < this.maxRetries) {
        await this.sleep(this.retryMs * (res.status === 429 ? 2 : 1));
        continue;
      }
      if (res.status === 401) throw new BggError("BGG rejected the token (401). Check BGG_TOKEN.");
      if (!res.ok) throw new BggError(`BGG ${path} returned HTTP ${res.status}`);
      const doc = parser.parse(await res.text());
      if (doc.errors || doc.error) {
        const msg = doc.errors?.error?.[0]?.message ?? doc.error?.message ?? "unknown error";
        throw new BggError(`BGG ${path}: ${msg}`);
      }
      return doc;
    }
  }

  async search(query) {
    const doc = await this.get("search", { query, type: "boardgame,boardgameexpansion" });
    return (doc.items?.item || []).map((it) => ({
      bggId: Number(it.id),
      name: primaryName(it.name),
      year: num(it.yearpublished?.value),
      type: it.type === "boardgameexpansion" ? "Expansion" : "Base",
    }));
  }

  /** Full details for up to any number of ids, fetched in batches of 20. */
  async things(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += THING_BATCH) {
      const doc = await this.get("thing", { id: ids.slice(i, i + THING_BATCH).join(","), stats: "1" });
      for (const it of doc.items?.item || []) out.push(parseThing(it));
    }
    return out;
  }

  /** The user's whole collection: base games and expansions (two requests). */
  async collection(username) {
    const base = await this.get("collection", { username, stats: "1", excludesubtype: "boardgameexpansion" });
    const exp = await this.get("collection", { username, stats: "1", subtype: "boardgameexpansion" });
    return [...(base.items?.item || []), ...(exp.items?.item || [])].map(parseCollectionItem);
  }
}

export function parseThing(it) {
  const s = it.statistics?.ratings;
  return {
    bggId: Number(it.id),
    name: primaryName(it.name),
    type: it.type === "boardgameexpansion" ? "Expansion" : "Base",
    year: num(it.yearpublished?.value),
    minPlayers: num(it.minplayers?.value),
    maxPlayers: num(it.maxplayers?.value),
    playTime: num(it.playingtime?.value),
    bggAvg: round2(num(s?.average?.value)),
    bggWeight: round2(num(s?.averageweight?.value)) || null,
    bestPlayers: bestPlayers(it.poll),
    image: it.image || null,
    thumbnail: it.thumbnail || null,
  };
}

export function parseCollectionItem(it) {
  const st = it.status || {};
  const stats = it.stats || {};
  return {
    bggId: Number(it.objectid),
    name: text(it.name?.[0]),
    type: it.subtype === "boardgameexpansion" ? "Expansion" : "Base",
    status: collectionStatus(st),
    plays: num(it.numplays) ?? 0,
    bggRating: num(stats.rating?.value),
    bggAvg: round2(num(stats.rating?.average?.value)),
    year: num(it.yearpublished),
    minPlayers: num(stats.minplayers),
    maxPlayers: num(stats.maxplayers),
    playTime: num(stats.playingtime),
    image: it.image || null,
    thumbnail: it.thumbnail || null,
  };
}

function collectionStatus(st) {
  const on = (k) => st[k] === "1";
  if (on("own")) return "Owned";
  if (on("preordered")) return "Preordered";
  if (on("prevowned")) return "Prev. owned";
  if (on("wishlist")) return "Wishlist";
  if (on("wanttoplay")) return "Want to play";
  if (on("wanttobuy") || on("want")) return "Want";
  return "";
}

/** Player counts where "Best" got the most votes in the suggested_numplayers poll. */
function bestPlayers(polls = []) {
  const poll = polls.find((p) => p.name === "suggested_numplayers");
  if (!poll) return "";
  const best = [];
  for (const r of poll.results || []) {
    const votes = Object.fromEntries((r.result || []).map((x) => [x.value, Number(x.numvotes) || 0]));
    const b = votes.Best || 0;
    if (b > 0 && b >= (votes.Recommended || 0) && b >= (votes["Not Recommended"] || 0)) best.push(r.numplayers);
  }
  return best.join(",");
}

function primaryName(names = []) {
  const n = names.find((x) => x.type === "primary") || names[0];
  return n?.value ?? text(n) ?? "";
}

function text(v) {
  if (v == null) return "";
  return typeof v === "object" ? String(v["#text"] ?? "") : String(v);
}

function num(v) {
  if (v === undefined || v === null || v === "" || v === "N/A") return null;
  const n = Number(typeof v === "object" ? (v.value ?? v["#text"]) : v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
