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

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const SEARCH_CACHE_SIZE = 100;

export class BggClient {
  constructor({
    token,
    fetchImpl = fetch,
    spacingMs = 5000,
    retryMs = 5000,
    maxRetries = 8,
    timeoutMs = 15000,
    transientRetries = 1,
    searchCacheMs = 600000,
    now = () => Date.now(),
    sleep,
  } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.spacingMs = spacingMs;
    this.retryMs = retryMs;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.transientRetries = transientRetries;
    this.searchCacheMs = searchCacheMs;
    this.now = now;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nextAt = 0;
    this.searchCache = new Map(); // key -> { at, rows }, oldest first
    this.searching = new Map(); // key -> in-flight promise of rows
  }

  get configured() {
    return !!this.token;
  }

  /**
   * Wait for this caller's turn. The slot is reserved before sleeping, so
   * overlapping callers queue a full spacing apart in arrival order.
   */
  async slot() {
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.spacingMs;
    if (at > now) await this.sleep(at - now);
  }

  async get(path, params) {
    if (!this.token) throw new BggError("BGG_TOKEN is not set on the server");
    const url = `${BASE}/${path}?${new URLSearchParams(params)}`;
    let queued = 0; // 202 and 429 answers so far
    let transient = 0; // timeouts, network failures and 5xx answers so far
    for (;;) {
      await this.slot();
      let res;
      let body;
      try {
        res = await this.fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        body = await res.text();
      } catch (e) {
        if (transient++ < this.transientRetries) continue;
        throw new BggError(
          e?.name === "TimeoutError" ? `BGG didn't answer within ${Math.round(this.timeoutMs / 1000)} s` : "Couldn't reach BGG",
        );
      }
      // 202 = collection request queued on BGG's side; 429 = slow down. Both mean retry.
      if (res.status === 202 || res.status === 429) {
        if (queued++ < this.maxRetries) {
          // A 429 slows every caller, by pushing back the shared next slot.
          if (res.status === 429) this.nextAt = Math.max(this.nextAt, this.now() + this.retryMs * 2);
          else await this.sleep(this.retryMs);
          continue;
        }
        throw new BggError(
          res.status === 202
            ? "BGG is still preparing the collection. Try the sync again in a minute."
            : "BGG is rate limiting requests (HTTP 429). Try again in a minute.",
        );
      }
      if (res.status === 401) throw new BggError("BGG rejected the token (401). Check BGG_TOKEN.");
      if (TRANSIENT_STATUS.has(res.status) && transient++ < this.transientRetries) continue;
      const doc = parse(body);
      const msg = errorText(doc);
      if (!res.ok) throw new BggError(`BGG ${path} returned HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
      if (msg || doc.errors !== undefined || doc.error !== undefined) throw new BggError(`BGG ${path}: ${msg || "unknown error"}`);
      if (doc.items === undefined) throw new BggError(`BGG ${path} sent an unexpected response`);
      return doc;
    }
  }

  /** Name search. Results are kept for a while per query, and one request is shared by identical queries. */
  async search(query) {
    const key = query.trim().toLowerCase();
    const hit = this.searchCache.get(key);
    if (hit && this.now() - hit.at < this.searchCacheMs) return hit.rows.map((r) => ({ ...r }));
    let pending = this.searching.get(key);
    if (!pending) {
      pending = this.get("search", { query: query.trim(), type: "boardgame,boardgameexpansion" })
        .then((doc) => {
          const rows = (doc.items?.item || []).map((it) => ({
            bggId: Number(it.id),
            name: primaryName(it.name),
            year: num(it.yearpublished?.value),
            type: it.type === "boardgameexpansion" ? "Expansion" : "Base",
          }));
          this.searchCache.delete(key);
          this.searchCache.set(key, { at: this.now(), rows });
          while (this.searchCache.size > SEARCH_CACHE_SIZE) this.searchCache.delete(this.searchCache.keys().next().value);
          return rows;
        })
        .finally(() => this.searching.delete(key));
      this.searching.set(key, pending);
    }
    return (await pending).map((r) => ({ ...r }));
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

  /** One game's details plus what a prediction needs: description, mechanics, categories, designers, base games. */
  async details(id) {
    const doc = await this.get("thing", { id: String(id), stats: "1" });
    const it = doc.items?.item?.[0];
    return it ? { ...parseThing(it), ...parseExtras(it) } : null;
  }

  /** BGG's current Hotness list (about 50 games), in rank order. */
  async hot() {
    const doc = await this.get("hot", { type: "boardgame" });
    return (doc.items?.item || []).map((it) => ({
      bggId: Number(it.id),
      rank: num(it.rank),
      name: primaryName(it.name),
      year: num(it.yearpublished?.value),
      thumbnail: it.thumbnail?.value || null,
    }));
  }

  /** The user's whole collection: base games and expansions (two requests). */
  async collection(username) {
    const base = await this.get("collection", { username, stats: "1", excludesubtype: "boardgameexpansion" });
    const exp = await this.get("collection", { username, stats: "1", subtype: "boardgameexpansion" });
    return [...(base.items?.item || []), ...(exp.items?.item || [])].map(parseCollectionItem);
  }
}

/** Parse a response body. A body that isn't XML (an HTML error page, say) reads as an empty document. */
function parse(body) {
  try {
    return parser.parse(body) ?? {};
  } catch {
    return {};
  }
}

/**
 * BGG's error message, or "". It comes as <errors><error><message>…</message></error></errors>
 * (one error or several) or as <error message="…"/>. `error` is deliberately not
 * in isArray, which would break the attribute form, so both are normalised here.
 */
function errorText(doc) {
  const first = [].concat(doc.errors?.error ?? doc.error ?? [])[0];
  return text(first?.message).trim();
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

const DESCRIPTION_LIMIT = 4000;

/** The descriptive fields parseThing leaves out. Only predictions use them, so they aren't stored. */
export function parseExtras(it) {
  const links = (type) => (it.link || []).filter((l) => l.type === type);
  const names = (type) => links(type).map((l) => l.value);
  const description = decodeEntities(text(it.description)).replace(/\n{3,}/g, "\n\n").trim();
  return {
    description: description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT)}…` : description,
    mechanics: names("boardgamemechanic"),
    categories: names("boardgamecategory"),
    designers: names("boardgamedesigner"),
    // On an expansion, inbound expansion links point at the games it expands.
    baseGames: links("boardgameexpansion")
      .filter((l) => l.inbound === "true")
      .map((l) => ({ bggId: Number(l.id), name: l.value })),
  };
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

/** BGG escapes descriptions twice, so one entity layer is left after XML parsing. */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
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
