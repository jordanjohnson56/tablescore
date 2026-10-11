import {
  CRITERIA, BAND_LABELS, bandIndex, finalScore, rawAverage, scaleEntry, scoredCount,
  rescoreStatus, isProvisional, spread, weightTotal,
} from "./rubric.js";
import {
  STAGES, PLATFORMS, claudeExport, isWatching, isHiddenType as hiddenType, visibleGames as shownGames,
} from "./watchlist.js";
import { api } from "./api.js";

const view = document.getElementById("view");
let state = { settings: null, games: [], bgg: { configured: false } };
const prefs = loadPrefs();

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 1) => (n == null ? "—" : Number(n).toFixed(d));
const final = (g) => finalScore(g.scores, state.settings);
const byId = (id) => state.games.find((g) => g.id === id);
const isHiddenType = (type) => hiddenType(type, state.settings);
const visibleGames = () => shownGames(state.games, state.settings);

function loadPrefs() {
  try {
    return { filter: "all", sort: "score", q: "", ...JSON.parse(localStorage.getItem("tablescore.prefs") || "{}") };
  } catch {
    return { filter: "all", sort: "score", q: "" };
  }
}
function savePrefs() {
  try {
    localStorage.setItem("tablescore.prefs", JSON.stringify(prefs));
  } catch {
    /* private mode: prefs just don't persist */
  }
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function players(g) {
  if (!g.minPlayers) return "";
  const range = g.minPlayers === g.maxPlayers ? `${g.minPlayers}` : `${g.minPlayers}–${g.maxPlayers}`;
  return `${range}p${g.bestPlayers ? ` (best ${g.bestPlayers})` : ""}`;
}

function metaDetails(g) {
  return [players(g), g.playTime ? `${g.playTime} min` : "", g.bggWeight ? `wt ${fmt(g.bggWeight, 1)}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** Score to type into BGG, if it differs from what BGG currently has. */
function bggDrift(g) {
  const f = final(g);
  if (f == null || !g.bggId) return null;
  if (g.bggRating != null && Math.abs(g.bggRating - f) < 0.05) return null;
  return f;
}

/** The game after g in the current list order that still needs a BGG rating. */
function nextDrift(g) {
  const list = filtered();
  const i = list.findIndex((x) => x.id === g.id);
  const order = [...list.slice(i + 1), ...list.slice(0, Math.max(i, 0))];
  return order.find((x) => x.id !== g.id && bggDrift(x) != null) || null;
}

// ---------- save queue: debounced PATCH per game ----------

const pending = new Map();
function queueSave(id, patch) {
  const p = pending.get(id) || { body: {}, timer: null };
  for (const [k, v] of Object.entries(patch)) {
    p.body[k] = k === "scores" ? { ...p.body.scores, ...v } : v;
  }
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(id), 450);
  pending.set(id, p);
  setSaveState("Saving…");
}

async function flush(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  try {
    const saved = await api.patch(`/api/games/${id}`, p.body);
    const i = state.games.findIndex((g) => g.id === id);
    if (i >= 0) state.games[i] = { ...saved, scores: { ...saved.scores, ...pendingScores(id) } };
    if (!pending.size) setSaveState("Saved");
  } catch (e) {
    setSaveState("Not saved");
    toast(`Couldn't save: ${e.message}`, 5000);
  }
}
const pendingScores = (id) => pending.get(id)?.body.scores || {};
function setSaveState(text) {
  const el = document.querySelector(".save-state");
  if (el) el.textContent = text;
}
window.addEventListener("pagehide", () => {
  for (const id of [...pending.keys()]) flush(id);
});

// ---------- router ----------

function route() {
  const hash = location.hash || "#/";
  const tab = hash.startsWith("#/add") ? "add" : hash.startsWith("#/summary") ? "summary" : hash.startsWith("#/settings") ? "settings" : "games";
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const m = hash.match(/^#\/g\/(\d+)/);
  if (m) return renderScorer(Number(m[1]));
  if (tab === "add") return renderAdd();
  if (tab === "summary") return renderSummary();
  if (tab === "settings") return renderSettings();
  return renderList();
}
window.addEventListener("hashchange", () => {
  route();
  window.scrollTo(0, 0);
});

// ---------- list ----------

const FILTERS = [
  ["all", "All"],
  ["todo", "To score"],
  ["scored", "Scored"],
  ["owned", "Owned"],
  ["wishlist", "Wishlist"],
  ["update", "Update BGG"],
  ["avoid", "Avoid theme"],
];

function filtered() {
  const q = prefs.q.trim().toLowerCase();
  const tests = {
    all: () => true,
    todo: (g) => final(g) == null,
    scored: (g) => final(g) != null,
    owned: (g) => g.status === "Owned",
    wishlist: (g) => g.status === "Wishlist" || g.status === "Want" || g.status === "Want to play",
    update: (g) => bggDrift(g) != null,
    avoid: (g) => g.avoidTheme,
  };
  const list = visibleGames().filter((g) => (tests[prefs.filter] || tests.all)(g) && (!q || g.name.toLowerCase().includes(q)));
  const sorters = {
    score: (a, b) => (final(b) ?? -1) - (final(a) ?? -1) || (b.bggRating ?? -1) - (a.bggRating ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
    plays: (a, b) => b.plays - a.plays,
    recent: (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  };
  return list.sort(sorters[prefs.sort] || sorters.score);
}

function renderList() {
  if (!FILTERS.some(([v]) => v === prefs.filter)) prefs.filter = "all";
  view.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-row">
        <input type="search" id="q" placeholder="Search ${visibleGames().length} games" value="${esc(prefs.q)}" aria-label="Search games">
        <select id="sort" aria-label="Sort">
          ${[["score", "Score"], ["name", "Name"], ["plays", "Plays"], ["recent", "Recent"]]
            .map(([v, l]) => `<option value="${v}" ${prefs.sort === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      <div class="chips" role="group" aria-label="Filter">
        ${FILTERS.map(([v, l]) => `<button class="chip" data-f="${v}" aria-pressed="${prefs.filter === v}">${l}</button>`).join("")}
      </div>
      <p class="list-count muted" id="count" aria-live="polite"></p>
    </div>
    <ul class="list" id="games"></ul>`;
  const fill = () => {
    const list = filtered();
    document.getElementById("count").textContent = `${list.length} ${list.length === 1 ? "game" : "games"}`;
    document.getElementById("games").innerHTML = list.length
      ? list.map(rowHtml).join("")
      : `<li class="empty">${visibleGames().length ? "No games match." : state.games.length ? "Every game is hidden: watched games stay out of this list, and Settings may hide expansions." : 'No games yet. Import your spreadsheet or use <a href="#/add">Add</a>.'}</li>`;
  };
  fill();
  view.querySelector("#q").addEventListener("input", (e) => {
    prefs.q = e.target.value;
    savePrefs();
    fill();
  });
  view.querySelector("#sort").addEventListener("change", (e) => {
    prefs.sort = e.target.value;
    savePrefs();
    fill();
  });
  view.querySelectorAll(".chip").forEach((b) =>
    b.addEventListener("click", () => {
      prefs.filter = b.dataset.f;
      savePrefs();
      view.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", c === b));
      fill();
    }),
  );
}

/** Status and tags stay fixed; only the details after them truncate. */
function metaHtml(g, tags) {
  const details = metaDetails(g);
  return [
    g.status ? `<span class="status">${esc(g.status)}</span>` : "",
    tags ? `<span class="tags">${tags}</span>` : "",
    details ? `<span class="details">${g.status ? "· " : ""}${esc(details)}</span>` : "",
  ].join("");
}

function rowHtml(g) {
  const f = final(g);
  const n = scoredCount(g.scores);
  const tags = [
    g.type === "Expansion" ? `<span class="tag">Exp</span>` : "",
    f != null && isProvisional(g) ? `<span class="tag" title="Fewer than 3 plays">Prov</span>` : "",
    n > 0 && n < 7 ? `<span class="tag warn">${n}/7</span>` : "",
    g.avoidTheme ? `<span class="tag danger">Avoid</span>` : "",
    bggDrift(g) != null ? `<span class="tag warn" title="BGG rating differs">BGG</span>` : "",
  ].join("");
  const badge = f != null
    ? `<div class="num">${fmt(f)}</div><div class="lbl">score</div>`
    : g.bggRating != null
      ? `<div class="num old">${fmt(g.bggRating)}</div><div class="lbl">old</div>`
      : `<div class="num old">—</div>`;
  const thumb = g.thumbnail
    ? `<img class="thumb" src="${esc(g.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="thumb" aria-hidden="true"></div>`;
  return `<li class="${g.avoidTheme ? "avoid" : ""}"><a class="game-row" href="#/g/${g.id}">
    ${thumb}
    <div class="info"><div class="name">${esc(g.name)}</div><div class="meta">${metaHtml(g, tags)}</div></div>
    <div class="score-badge">${badge}</div></a></li>`;
}

// ---------- scorer ----------

function renderScorer(id) {
  const g = byId(id);
  if (!g) {
    view.innerHTML = `<p class="empty">That game isn't in your list. <a href="#/">Back to games</a></p>`;
    return;
  }
  const w = state.settings.weights;
  const watching = isWatching(g);
  view.innerHTML = `
    <header class="score-head">
      <a class="back" href="#/" aria-label="Back to games">‹</a>
      <div class="title">
        <div class="name ${g.avoidTheme ? "avoid-name" : ""}">${esc(g.name)}</div>
        <div class="save-state">${esc(rescoreStatus(g.scores))}</div>
      </div>
      <div class="final" id="final"></div>
    </header>
    <div id="drift"></div>
    ${watching ? watchHtml(g) : ""}
    ${watching ? `<details class="score-it"><summary>Score it</summary>` : ""}
    ${CRITERIA.map((c) => `
      <section class="card crit" data-k="${c.key}">
        <div class="crit-top">
          <span class="cname">${esc(c.name)}</span>
          <span class="weight">${w[c.key]}% · ${esc(c.yardstick)}</span>
          <span class="val"></span>
        </div>
        <div class="ask">${esc(c.ask)}</div>
        <div class="slider-row">
          <input type="range" min="0" max="10" step="0.5" aria-label="${esc(c.name)}">
          <button class="clear" type="button" aria-label="Clear ${esc(c.name)}">×</button>
        </div>
        <div class="band"></div>
        <details><summary>Guide</summary>
          <p>${esc(c.purpose)}</p>
          <ol>${c.bands.map((b, i) => `<li data-i="${i}"><b>${BAND_LABELS[i]}</b> ${esc(b)}</li>`).join("")}</ol>
        </details>
      </section>`).join("")}
    ${watching ? "</details>" : watchHtml(g)}
    <section class="card">
      <h2 style="margin-top:0">Details</h2>
      <label class="field"><span>Logged plays</span>
        <div class="stepper">
          <button class="btn" type="button" data-step="-1" aria-label="One fewer play">−</button>
          <input type="number" id="plays" min="0" inputmode="numeric" value="${g.plays}">
          <button class="btn" type="button" data-step="1" aria-label="One more play">+</button>
        </div>
      </label>
      <label class="field"><span>Status</span>
        <select id="status">${["Owned", "Preordered", "Prev. owned", "Wishlist", "Want to play", "Want", ""]
          .map((s) => `<option value="${esc(s)}" ${g.status === s ? "selected" : ""}>${s || "Not in collection"}</option>`).join("")}</select>
      </label>
      <label class="toggle"><input type="checkbox" id="avoid" ${g.avoidTheme ? "checked" : ""}> Avoid theme (demons, spirits, horror)</label>
      <label class="toggle"><input type="checkbox" id="calib" ${g.calibration ? "checked" : ""}> Calibration game</label>
      <label class="field"><span>Notes</span><textarea id="notes">${esc(g.notes)}</textarea></label>
      <dl class="facts">
        <div><dt>BGG rating</dt><dd>${fmt(g.bggRating)}</dd></div>
        <div><dt>Old rating (sheet)</dt><dd>${fmt(g.oldRating)}</dd></div>
        <div><dt>BGG average</dt><dd>${fmt(g.bggAvg, 2)}</dd></div>
        <div><dt>Raw average</dt><dd id="raw">—</dd></div>
        <div><dt>Players</dt><dd>${esc(players(g) || "—")}</dd></div>
        <div><dt>Play time</dt><dd>${g.playTime ? `${g.playTime} min` : "—"}</dd></div>
        <div><dt>Weight</dt><dd>${fmt(g.bggWeight, 2)}</dd></div>
        <div><dt>Year</dt><dd>${g.year ?? "—"}</dd></div>
      </dl>
      ${g.bggId ? `<p class="small"><a href="https://boardgamegeek.com/boardgame/${g.bggId}" target="_blank" rel="noopener">Open on BGG</a></p>` : ""}
      <div class="btn-row"><button class="btn danger" id="del" type="button">Delete game</button></div>
    </section>`;

  const paintHead = () => {
    const f = final(g);
    const n = scoredCount(g.scores);
    const [, label] = f != null ? scaleEntry(f) : [];
    view.querySelector("#final").innerHTML = f != null
      ? `<div class="num">${fmt(f)}</div><div class="lbl">${esc(label)}${isProvisional(g) ? " · prov." : ""}</div>`
      : `<div class="num" style="color:var(--muted)">${n}/7</div><div class="lbl">criteria</div>`;
    const raw = rawAverage(g.scores, state.settings);
    view.querySelector("#raw").textContent = raw == null ? "—" : raw.toFixed(2);
    const d = bggDrift(g);
    view.querySelector("#drift").innerHTML = d != null
      ? `<div class="notice drift">
          <p>Rate it <b>${fmt(d)}</b> on BGG${g.bggRating != null ? ` (it has ${fmt(g.bggRating)})` : ""}.</p>
          <div class="btn-row">
            <a class="btn primary" data-act="open" href="https://boardgamegeek.com/boardgame/${g.bggId}" target="_blank" rel="noopener">Copy ${fmt(d)} &amp; open BGG</a>
            <button class="btn" type="button" data-act="done">I've rated it</button>
          </div>
        </div>`
      : "";
  };

  // The notice repaints on every score change, so its buttons are handled here.
  view.querySelector("#drift").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const d = bggDrift(g);
    if (!act || d == null) return;
    const rating = Number(fmt(d));
    if (act === "open") {
      copyText(String(rating)).then(() => toast(`Copied ${rating}`));
      return; // the link itself opens BGG
    }
    try {
      const next = prefs.filter === "update" ? nextDrift(g) : null;
      const saved = await api.post(`/api/games/${g.id}/bgg-rated`, { rating });
      g.bggRating = saved.bggRating;
      if (prefs.filter !== "update") {
        paintHead();
        toast("Marked as rated on BGG");
      } else if (next) {
        const left = visibleGames().filter((x) => bggDrift(x) != null).length;
        location.hash = `#/g/${next.id}`;
        toast(`${left} left to rate on BGG`);
      } else {
        location.hash = "#/";
        toast("All BGG ratings are up to date");
      }
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, 5000);
    }
  });

  const paintCrit = (card) => {
    const c = CRITERIA.find((x) => x.key === card.dataset.k);
    const v = g.scores[c.key];
    const set = typeof v === "number";
    card.classList.toggle("unset", !set);
    card.querySelector(".val").textContent = set ? fmt(v, v % 1 ? 1 : 0) : "—";
    const range = card.querySelector("input");
    if (document.activeElement !== range) range.value = set ? v : 5;
    const bi = set ? bandIndex(v) : -1;
    card.querySelector(".band").innerHTML = set ? `<b>${BAND_LABELS[bi]}</b> ${esc(c.bands[bi])}` : "Not scored yet. Drag to score.";
    card.querySelectorAll("li").forEach((li) => li.classList.toggle("on", Number(li.dataset.i) === bi));
  };

  view.querySelectorAll(".crit").forEach((card) => {
    const key = card.dataset.k;
    const range = card.querySelector("input");
    const setVal = (v) => {
      g.scores[key] = v;
      paintCrit(card);
      paintHead();
      queueSave(g.id, { scores: { [key]: v } });
    };
    range.addEventListener("input", () => setVal(Number(range.value)));
    // A tap on an unset slider at its resting value fires no input event; count it.
    range.addEventListener("pointerup", () => {
      if (typeof g.scores[key] !== "number") setVal(Number(range.value));
    });
    card.querySelector(".clear").addEventListener("click", () => setVal(null));
    paintCrit(card);
  });
  paintHead();

  const plays = view.querySelector("#plays");
  const setPlays = (n) => {
    g.plays = Math.max(0, Math.floor(n) || 0);
    plays.value = g.plays;
    paintHead();
    queueSave(g.id, { plays: g.plays });
  };
  plays.addEventListener("change", () => setPlays(Number(plays.value)));
  view.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => setPlays(g.plays + Number(b.dataset.step))));
  view.querySelector("#status").addEventListener("change", (e) => queueSave(g.id, { status: (g.status = e.target.value) }));
  view.querySelector("#avoid").addEventListener("change", (e) => {
    g.avoidTheme = e.target.checked;
    view.querySelector(".score-head .name").classList.toggle("avoid-name", g.avoidTheme);
    queueSave(g.id, { avoidTheme: g.avoidTheme });
  });
  view.querySelector("#calib").addEventListener("change", (e) => queueSave(g.id, { calibration: (g.calibration = e.target.checked) }));
  view.querySelector("#notes").addEventListener("input", (e) => queueSave(g.id, { notes: (g.notes = e.target.value) }));
  bindWatch(g);
  view.querySelector("#del").addEventListener("click", async () => {
    if (!confirm(`Delete ${g.name} and its scores? This can't be undone.`)) return;
    try {
      pending.delete(g.id);
      await api.del(`/api/games/${g.id}`);
      state.games = state.games.filter((x) => x.id !== g.id);
      location.hash = "#/";
      toast(`Deleted ${g.name}`);
    } catch (e) {
      toast(`Couldn't delete: ${e.message}`, 5000);
    }
  });
}

// ---------- watch section ----------

/** Start/stop watching and every watch field. Stopping keeps the fields. */
function watchHtml(g) {
  if (!isWatching(g)) {
    return `<section class="card watch">
      <h2 style="margin-top:0">Watch</h2>
      <p class="small muted">Follow a crowdfunded game until backers have it and reviews are out. Watched games leave the main list, Summary and Claude export.</p>
      <div class="btn-row"><button class="btn" type="button" id="watch-start">Start watching</button></div>
    </section>`;
  }
  const opt = (list, cur, blank) =>
    (blank ? `<option value="" ${cur ? "" : "selected"}>${blank}</option>` : "") +
    list.map((o) => `<option value="${o.key}" ${cur === o.key ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  return `<section class="card watch">
    <h2 style="margin-top:0">Watching</h2>
    <label class="field"><span>Watch stage</span><select data-watch="watchStage">${opt(STAGES, g.watchStage)}</select></label>
    <label class="field"><span>Predicted score (0–10)</span>
      <input type="number" data-watch="predictedScore" min="0" max="10" step="0.1" inputmode="decimal" value="${g.predictedScore ?? ""}"></label>
    <div class="pair">
      <label class="field"><span>Target price</span>
        <input type="number" data-watch="targetPrice" min="0" step="0.01" inputmode="decimal" value="${g.targetPrice ?? ""}"></label>
      <label class="field currency"><span>Currency</span>
        <input type="text" data-watch="targetCurrency" maxlength="3" autocapitalize="characters" placeholder="USD" value="${esc(g.targetCurrency ?? "")}"></label>
    </div>
    <label class="field"><span>Platform</span><select data-watch="platform">${opt(PLATFORMS, g.platform, "Not set")}</select></label>
    <label class="field"><span>Campaign URL</span>
      <input type="url" data-watch="campaignUrl" inputmode="url" placeholder="https://" value="${esc(g.campaignUrl ?? "")}"></label>
    ${/^https?:\/\//.test(g.campaignUrl ?? "") ? `<p class="small"><a href="${esc(g.campaignUrl)}" target="_blank" rel="noopener">Open campaign</a></p>` : ""}
    <div class="pair">
      <label class="field"><span>Campaign ends</span><input type="date" data-watch="campaignEnd" value="${esc(g.campaignEnd ?? "")}"></label>
      <label class="field"><span>Estimated delivery</span><input type="month" data-watch="deliveryEst" placeholder="YYYY-MM" value="${esc(g.deliveryEst ?? "")}"></label>
    </div>
    <div class="btn-row"><button class="btn" type="button" id="watch-stop">Stop watching</button></div>
  </section>`;
}

function bindWatch(g) {
  // Watching changes the page layout, so starting or stopping redraws it.
  const setStage = (stage) => {
    g.watchStage = stage;
    queueSave(g.id, { watchStage: stage });
    renderScorer(g.id);
  };
  view.querySelector("#watch-start")?.addEventListener("click", () => setStage(STAGES[0].key));
  view.querySelector("#watch-stop")?.addEventListener("click", () => setStage(null));
  view.querySelectorAll("[data-watch]").forEach((el) => {
    const key = el.dataset.watch;
    el.addEventListener("change", () => {
      let v = el.value.trim();
      if (key === "targetCurrency") v = el.value = v.toUpperCase();
      if (el.type === "number") v = v === "" ? null : Number(v);
      if (v === "") v = null;
      if (key === "watchStage" && !v) return;
      const patch = { [key]: v };
      // A price without a currency is in USD.
      if (key === "targetPrice" && v != null && !g.targetCurrency) patch.targetCurrency = "USD";
      Object.assign(g, patch);
      queueSave(g.id, patch);
      if (key === "campaignUrl") renderScorer(g.id);
    });
  });
}

// ---------- add ----------

function renderAdd() {
  const bggOn = state.bgg.configured;
  view.innerHTML = `
    <h1>Add a game</h1>
    ${bggOn
      ? `<input type="search" id="bq" placeholder="Search BoardGameGeek" aria-label="Search BoardGameGeek" autofocus>
         <ul class="list" id="results"><li class="empty">Type at least 2 letters.</li></ul>`
      : `<p class="notice">BGG search is off because the server has no BGG_TOKEN. You can still add games by name.</p>`}
    <h2>Add by name</h2>
    <form id="manual">
      <label class="field"><span>Name</span><input type="text" id="mname" required></label>
      <label class="field"><span>Type</span><select id="mtype"><option>Base</option><option>Expansion</option></select></label>
      <button class="btn primary" type="submit">Add game</button>
    </form>`;

  view.querySelector("#manual").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = view.querySelector("#mname").value.trim();
    if (!name) return;
    try {
      const g = await api.post("/api/games", { name, type: view.querySelector("#mtype").value });
      state.games.push(g);
      location.hash = `#/g/${g.id}`;
    } catch (err) {
      toast(err.message, 5000);
    }
  });

  if (!bggOn) return;
  const results = view.querySelector("#results");
  let timer;
  let seq = 0;
  view.querySelector("#bq").addEventListener("input", (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) {
      results.innerHTML = `<li class="empty">Type at least 2 letters.</li>`;
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      results.innerHTML = `<li class="empty">Searching…</li>`;
      try {
        const rows = await api.get(`/api/bgg/search?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        const shown = rows.filter((r) => !isHiddenType(r.type));
        results.innerHTML = shown.length
          ? shown.map((r) => `<li><div class="game-row">
              <div class="info"><div class="name">${esc(r.name)}${r.type === "Expansion" ? '<span class="tag">Exp</span>' : ""}</div>
              <div class="meta">${r.year ?? ""}</div></div>
              ${r.inList
                ? `<a class="btn" href="#/g/${state.games.find((g) => g.bggId === r.bggId)?.id}">Open</a>`
                : `<button class="btn primary" data-add="${r.bggId}">Add</button>`}
            </div></li>`).join("")
          : `<li class="empty">No matches on BGG.</li>`;
      } catch (err) {
        if (mine === seq) results.innerHTML = `<li class="empty">${esc(err.message)}</li>`;
      }
    }, 450);
  });
  results.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    b.disabled = true;
    b.textContent = "Adding…";
    try {
      const g = await api.post("/api/games/from-bgg", { bggId: Number(b.dataset.add) });
      if (!byId(g.id)) state.games.push(g);
      location.hash = `#/g/${g.id}`;
    } catch (err) {
      b.disabled = false;
      b.textContent = "Add";
      toast(err.message, 5000);
    }
  });
}

// ---------- summary ----------

function renderSummary() {
  const games = visibleGames();
  const scored = games.filter((g) => final(g) != null);
  const olds = games.map((g) => g.oldRating).filter((x) => x != null);
  const o = spread(olds);
  const n = spread(scored.map(final));
  const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const rows = [
    ["Games", o.n, n.n, ""],
    ["Mean", fmt(o.mean, 2), fmt(n.mean, 2), "~7.0"],
    ["Median", fmt(o.median, 2), fmt(n.median, 2), "~7.0"],
    ["Std. dev.", fmt(o.sd, 2), fmt(n.sd, 2), "wider than old"],
    ["9.0 or above", pct(o.pct9), pct(n.pct9), "~5%"],
    ["8.0–8.9", pct(o.pct8), pct(n.pct8), "well under old"],
    ["Below 6.0", pct(o.pctBelow6), pct(n.pctBelow6), "real use of 4–6"],
  ];
  const max = Math.max(1, ...(o.histogram || []).map(([, c]) => c), ...(n.histogram || []).map(([, c]) => c));
  const hist = Array.from({ length: 10 }, (_, i) => {
    const s = 10 - i;
    const oc = o.histogram?.[i]?.[1] ?? 0;
    const nc = n.histogram?.[i]?.[1] ?? 0;
    return `<div class="s">${s}</div><div class="bars">
      <div class="bar old" title="Old: ${oc} games at ${s}">${oc ? `<span style="width:${(oc / max) * 85}%"></span>` : ""}${oc || ""}</div>
      <div class="bar new" title="New: ${nc} games at ${s}">${nc ? `<span style="width:${(nc / max) * 85}%"></span>` : ""}${nc || ""}</div>
    </div>`;
  }).join("");
  const changes = scored
    .filter((g) => g.oldRating != null)
    .map((g) => ({ g, d: final(g) - g.oldRating }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 10);

  view.innerHTML = `
    <h1>Summary</h1>
    <p class="muted small">Old ratings are the spreadsheet baseline. New scores count fully scored games only (${scored.length} of ${games.length})${state.settings.hideExpansions ? ". Expansions are hidden" : ""}.</p>
    <table>
      <thead><tr><th>Metric</th><th class="num">Old</th><th class="num">New</th><th>Target</th></tr></thead>
      <tbody>${rows.map(([m, a, b, t]) => `<tr><td>${m}</td><td class="num">${a ?? "—"}</td><td class="num">${b ?? "—"}</td><td class="muted small">${t}</td></tr>`).join("")}</tbody>
    </table>
    <h2>Distribution</h2>
    <div class="legend"><span><i style="background:var(--series-old)"></i>Old ratings</span><span><i style="background:var(--series-new)"></i>New scores</span></div>
    <div class="hist" role="img" aria-label="Count of games at each rounded score, old ratings versus new scores">${hist}</div>
    ${changes.length ? `<h2>Biggest changes vs old</h2>
      <table><tbody>${changes.map(({ g, d }) => `<tr><td><a href="#/g/${g.id}">${esc(g.name)}</a></td>
        <td class="num">${fmt(g.oldRating)} → ${fmt(final(g))}</td><td class="num">${d > 0 ? "+" : ""}${fmt(d)}</td></tr>`).join("")}</tbody></table>` : ""}`;
}

// ---------- settings ----------

let syncPoll;
function renderSettings() {
  const s = state.settings;
  view.innerHTML = `
    <h1>Settings</h1>
    <section class="card">
      <h2 style="margin-top:0">Display</h2>
      <label class="toggle"><input type="checkbox" id="hideexp" ${s.hideExpansions ? "checked" : ""}> Hide expansions</label>
      <p class="small muted">Hides expansions from the game list, Summary, BGG search and the Claude export. Their scores are kept.</p>
    </section>
    <section class="card">
      <h2 style="margin-top:0">Weights</h2>
      <p class="muted small">Points out of 100. Every score updates when you save.</p>
      <form id="wform">
        ${CRITERIA.map((c) => `<label class="field"><span>${esc(c.name)}</span>
          <input type="number" min="0" step="1" inputmode="numeric" name="${c.key}" value="${s.weights[c.key]}"></label>`).join("")}
        <label class="field"><span>Stretch factor</span>
          <input type="number" min="0.1" max="5" step="0.05" inputmode="decimal" name="stretch" value="${s.stretch}"></label>
        <p class="small muted">New score = 5 + (weighted average − 5) × stretch, kept within 0–10. 1.0 means no stretch.</p>
        <p id="wtotal" class="small"></p>
        <button class="btn primary" type="submit">Save weights</button>
      </form>
    </section>
    <section class="card">
      <h2 style="margin-top:0">BoardGameGeek</h2>
      ${state.bgg.configured
        ? `<p class="small">Syncs status, plays, your BGG rating and game details for <b>${esc(state.bgg.username || "(no BGG_USERNAME set)")}</b>. Your rubric scores and notes are never changed by a sync.</p>
           <div class="btn-row"><button class="btn primary" id="sync" ${state.bgg.username ? "" : "disabled"}>Sync from BGG</button></div>
           <p id="syncstate" class="small muted"></p>`
        : `<p class="notice">Set BGG_TOKEN and BGG_USERNAME in the server's .env file to turn on search and sync.</p>`}
    </section>
    <section class="card">
      <h2 style="margin-top:0">Your data</h2>
      <p class="small muted">Everything lives in one database on your server, with a daily backup copy kept there.</p>
      <div class="btn-row">
        <a class="btn" href="/api/export" download>Export JSON</a>
        <button class="btn" id="copy">Copy scores for Claude</button>
      </div>
    </section>`;

  const form = view.querySelector("#wform");
  const total = () => {
    const t = weightTotal(Object.fromEntries(CRITERIA.map((c) => [c.key, Number(form[c.key].value)])));
    view.querySelector("#wtotal").innerHTML = t === 100 ? `Total ${t}.` : `<span class="tag warn">Total ${t}, should be 100</span>`;
    return t;
  };
  total();
  form.addEventListener("input", total);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (total() !== 100 && !confirm("Weights don't total 100. Scores still work as a weighted average. Save anyway?")) return;
    try {
      state.settings = await api.put("/api/settings", {
        weights: Object.fromEntries(CRITERIA.map((c) => [c.key, Number(form[c.key].value)])),
        stretch: Number(form.stretch.value),
      });
      toast("Weights saved");
    } catch (err) {
      toast(err.message, 5000);
    }
  });

  view.querySelector("#copy").addEventListener("click", copyForClaude);
  view.querySelector("#hideexp").addEventListener("change", async (e) => {
    try {
      state.settings = await api.put("/api/settings", { hideExpansions: e.target.checked });
      toast(state.settings.hideExpansions ? "Expansions hidden" : "Expansions shown");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`Couldn't save: ${err.message}`, 5000);
    }
  });

  const syncBtn = view.querySelector("#sync");
  if (!syncBtn) return;
  const paint = (job) => {
    const el = view.querySelector("#syncstate");
    if (!el) return;
    syncBtn.disabled = job.running || !state.bgg.username;
    if (job.running) el.textContent = `${job.phase}${job.total ? ` (${job.done}/${job.total})` : ""}…`;
    else if (job.error) el.innerHTML = `<span class="tag warn">Sync failed</span> ${esc(job.error)}`;
    else if (job.result) el.textContent = `Last sync: ${job.result.collection} items, ${job.result.added} new, ${job.result.updated} updated, ${job.result.enriched} detailed.`;
    else el.textContent = "";
  };
  const poll = async () => {
    clearTimeout(syncPoll);
    try {
      const job = await api.get("/api/bgg/sync");
      paint(job);
      if (job.running && location.hash.startsWith("#/settings")) syncPoll = setTimeout(poll, 2000);
      else if (job.result && !job.running) await reload();
    } catch {
      /* server unreachable; next click retries */
    }
  };
  syncBtn.addEventListener("click", async () => {
    try {
      paint(await api.post("/api/bgg/sync", {}));
      syncPoll = setTimeout(poll, 1500);
    } catch (err) {
      toast(err.message, 5000);
    }
  });
  poll();
}

async function copyForClaude() {
  const { text, scored, rest } = claudeExport(state.games, state.settings);
  await copyText(text);
  toast(`Copied ${scored} scored and ${rest} other games`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------- boot ----------

async function reload() {
  state = await api.get("/api/state");
}

(async () => {
  view.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    await reload();
    route();
  } catch (e) {
    view.innerHTML = `<p class="empty">Can't reach the Tablescore server (${esc(e.message)}). Check that it's running and you're on your tailnet.</p>`;
  }
})();
