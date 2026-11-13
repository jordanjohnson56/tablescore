// PROTOTYPE, throwaway. Question: what should a game's place in my rankings look like?
// Four variants of a rank badge on the existing Games list and scorer header, switchable via
// `?variant=A|B|C|D` before the hash (e.g. /?variant=B#/). With no ?variant the app is unchanged,
// so this can't leak into normal use. Delete this file once a variant wins.
//
// Rank rules assumed here (open questions for Jordan):
// - Ranked set = scored games that the list shows (Settings hide rules apply), minus expansions.
// - Ties share a place (1, 1, 3), compared at the one decimal the app displays.
// - Rank ignores the current filter/search/sort, so #3 is #3 everywhere.

const VARIANTS = {
  A: "Thumbnail corner",
  B: "Leaderboard column",
  C: "Inside score badge",
  D: "Tier icons only",
};
const params = new URLSearchParams(location.search);
export const variant = VARIANTS[params.get("variant")] ? params.get("variant") : null;

let ranks = new Map();
let total = 0;

/** Recompute places. Call before rendering the list or the scorer head. */
export function computeRanks(games, finalOf) {
  const scored = games
    .filter((g) => g.type !== "Expansion")
    .map((g) => ({ g, f: finalOf(g) }))
    .filter((x) => x.f != null)
    .map((x) => ({ ...x, r: Math.round(x.f * 10) }))
    .sort((a, b) => b.r - a.r);
  ranks = new Map();
  scored.forEach((x, i) => {
    const place = i > 0 && x.r === scored[i - 1].r ? ranks.get(scored[i - 1].g.id) : i + 1;
    ranks.set(x.g.id, place);
  });
  total = scored.length;
}

const rankOf = (g) => ranks.get(g.id) ?? null;
const tied = (g) => [...ranks.values()].filter((p) => p === rankOf(g)).length > 1;
const placeText = (g) => `${tied(g) ? "T" : ""}#${rankOf(g)}`;

function tier(g) {
  const p = rankOf(g);
  if (p == null) return null;
  if (p === 1) return { icon: "trophy", label: "Best", cls: "gold" };
  if (p <= 3) return { icon: "medal", label: `Top 3`, cls: "gold" };
  if (p <= 10) return { icon: "star", label: "Top 10", cls: "accent" };
  if (p <= Math.ceil(total * 0.25)) return { icon: "up", label: "Top 25%", cls: "soft" };
  return null;
}

const ICONS = {
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="M8.5 11 6 3h4l2 5 2-5h4l-2.5 8"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  up: '<path d="M12 19V6M6 11l6-6 6 6"/>',
};
const icon = (name) => `<svg class="rk-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- hooks called from app.js ----------

/** Variant A: overlay on the thumbnail. Returns thumb HTML wrapped, or null to keep the original. */
export function thumbWrap(g, thumbHtml) {
  if (variant !== "A" || rankOf(g) == null) return null;
  const top = rankOf(g) <= 3 ? " top" : "";
  return `<div class="rk-thumb">${thumbHtml}<span class="rk-corner${top}" aria-label="Ranked ${rankOf(g)} of ${total}">${rankOf(g)}</span></div>`;
}

/** Variant B: a leading place column on every row (blank for unranked, so names stay aligned). */
export function leadCol(g) {
  if (variant !== "B") return "";
  const p = rankOf(g);
  const cls = p == null ? "" : p <= 3 ? " podium" : p <= 10 ? " ten" : "";
  return `<div class="rk-lead${cls}" aria-label="${p == null ? "Not ranked" : `Ranked ${p}`}">${p == null ? "" : `${tied(g) ? "T" : ""}${p}`}</div>`;
}

/** Variant C: replaces the "score" label under the number. */
export function badgeLabel(g) {
  if (variant !== "C" || rankOf(g) == null) return null;
  return `<span class="rk-lbl">${placeText(g)}</span>`;
}

/** Variant D: a tier tag in the meta line, only for notable places. */
export function metaTag(g) {
  if (variant !== "D") return "";
  const t = tier(g);
  return t ? `<span class="tag rk-tier ${t.cls}" title="Ranked ${rankOf(g)} of ${total}">${icon(t.icon)}${t.label}</span>` : "";
}

/** Scorer header: every variant shows the place there too, in its own style. */
export function headHtml(g) {
  if (!variant || rankOf(g) == null) return "";
  const p = rankOf(g);
  if (variant === "A") return `<span class="rk-pill${p <= 3 ? " top" : ""}">${placeText(g)} of ${total}</span>`;
  if (variant === "B") return `<span class="rk-headnum"><b>${placeText(g)}</b> of ${total} ranked</span>`;
  if (variant === "C") return ` · ${placeText(g)} of ${total}`;
  const t = tier(g);
  return t
    ? `<span class="tag rk-tier ${t.cls}">${icon(t.icon)}${t.label} · #${p}</span>`
    : `<span class="rk-quiet">#${p} of ${total}</span>`;
}

// ---------- floating switcher ----------

function go(delta) {
  const keys = Object.keys(VARIANTS);
  const next = keys[(keys.indexOf(variant) + delta + keys.length) % keys.length];
  params.set("variant", next);
  location.search = params.toString(); // full reload keeps it dead simple; the hash survives
}

export function mountSwitcher() {
  if (!variant) return;
  const bar = document.createElement("div");
  bar.className = "rk-switcher";
  bar.innerHTML = `<button type="button" aria-label="Previous variant">‹</button>
    <span><b>${variant}</b> ${VARIANTS[variant]}</span>
    <button type="button" aria-label="Next variant">›</button>`;
  const [prev, next] = bar.querySelectorAll("button");
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  document.body.append(bar);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });
  const css = document.createElement("style");
  css.textContent = STYLES;
  document.head.append(css);
}

const STYLES = `
.rk-switcher { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--tabs-h) + 12px + env(safe-area-inset-bottom));
  z-index: 50; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px;
  background: #111; color: #fff; box-shadow: 0 6px 20px rgb(0 0 0 / .35); font-size: .85rem; white-space: nowrap; }
.rk-switcher button { width: 36px; height: 36px; border: 0; border-radius: 50%; background: #333; color: #fff; font-size: 1.2rem; cursor: pointer; }
.rk-switcher span { padding: 0 8px; }
.rk-switcher b { color: #ffd166; }

/* A: corner chip on the thumbnail */
.rk-thumb { position: relative; flex: none; }
.rk-corner { position: absolute; top: -6px; left: -6px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: var(--ink); color: var(--bg); font-size: .7rem; font-weight: 800; line-height: 20px; text-align: center;
  font-variant-numeric: tabular-nums; border: 2px solid var(--bg); }
.rk-corner.top { background: #c8961e; color: #1d1f23; }
.rk-pill { display: inline-block; margin-top: 2px; font-size: .75rem; font-weight: 700; padding: 1px 8px; border-radius: 999px;
  background: var(--ink); color: var(--bg); }
.rk-pill.top { background: #c8961e; color: #1d1f23; }

/* B: leaderboard column */
.rk-lead { flex: none; width: 26px; margin-right: -4px; text-align: right; font-size: .95rem; font-weight: 700;
  color: var(--muted); font-variant-numeric: tabular-nums; }
.rk-lead.ten { color: var(--ink); }
.rk-lead.podium { color: #b07f10; font-size: 1.1rem; }
.rk-headnum { font-size: .78rem; color: var(--muted); }
.rk-headnum b { color: var(--ink); font-size: .9rem; }

/* C: inside the score badge */
.rk-lbl { font-weight: 700; color: var(--ink-2); font-variant-numeric: tabular-nums; }

/* D: tier tags */
.rk-tier { display: inline-flex; align-items: center; gap: 3px; }
.rk-tier.gold { background: #f6e3b0; color: #6b4a00; }
.rk-tier.accent { background: var(--accent-soft); color: var(--accent); }
.rk-tier.soft { background: var(--surface-2); color: var(--ink-2); }
.rk-ico { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.rk-quiet { font-size: .75rem; color: var(--muted); }
@media (prefers-color-scheme: dark) {
  .rk-tier.gold { background: #3d3216; color: #f3d58a; }
  .rk-lead.podium { color: #e2b54a; }
}
`;
