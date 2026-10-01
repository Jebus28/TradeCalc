"use strict";
/* Trade Lab values page. Reads data/values-<league>.json built by
   scripts/build_values.py and lets the reader slide between horizons. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null ? "–" : Math.round(n).toLocaleString("en-GB"));
const POSITIONS = ["All", "QB", "RB", "WR", "TE", "K", "DEF"];
const PAGE = 100;

const state = { q: "", pos: "All", owner: "", hz: 50, sort: "v", dir: -1, limit: PAGE, open: new Set() };
let DATA = null;

/* Horizon slider: 0 = Win Now, 50 = Balanced, 100 = Long-Term; straight lines between anchors. */
function valueAt(p, hz) {
  if (hz <= 50) return p.win + (p.bal - p.win) * (hz / 50);
  return p.bal + (p.lt - p.bal) * ((hz - 50) / 50);
}
function horizonName(hz) {
  if (hz <= 10) return "Win Now";
  if (hz < 40) return "Leaning Win Now";
  if (hz <= 60) return "Balanced";
  if (hz < 90) return "Leaning Long-Term";
  return "Long-Term";
}

async function load() {
  const slug = new URLSearchParams(location.search).get("league");
  const index = await fetch("data/index.json", { cache: "no-cache" }).then((r) => r.json());
  const lg = index.leagues.find((l) => l.slug === slug) || index.leagues[0];
  DATA = await fetch(`data/values-${lg.slug}.json`, { cache: "no-cache" }).then((r) => r.json());
  setup();
}

function setup() {
  const m = DATA.meta;
  $("#leaguename").textContent = `${m.league} · ${m.season} week ${m.week}`;
  const built = new Date(m.built);
  const hours = (Date.now() - built) / 36e5;
  const when = built.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const pill = $("#status");
  const problems = (m.fetch_failures || []).length;
  pill.lastElementChild.textContent = problems ? `Updated ${when} · ${problems} source issue${problems > 1 ? "s" : ""}` : `Updated ${when}`;
  if (problems || hours > 8) pill.classList.add("warn");
  $("#built").textContent = `Last built ${built.toLocaleString("en-GB")}.`;

  $("#pos").innerHTML = POSITIONS.map((p) => `<button type="button" aria-pressed="${p === state.pos}" data-pos="${p}">${p}</button>`).join("");
  const owners = [...new Set(DATA.players.map((p) => p.owner).filter(Boolean))].sort();
  $("#owner").innerHTML = `<option value="">Everyone</option><option value="-">Free agents</option>` +
    owners.map((o) => `<option>${esc(o)}</option>`).join("");

  $("#q").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); state.limit = PAGE; renderPlayers(); });
  $("#pos").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.pos = b.dataset.pos; state.limit = PAGE;
    $("#pos").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderPlayers();
  });
  $("#owner").addEventListener("change", (e) => { state.owner = e.target.value; state.limit = PAGE; renderPlayers(); });
  $("#hz").addEventListener("input", (e) => { state.hz = +e.target.value; $("#hzname").textContent = horizonName(state.hz); renderPlayers(); });
  $("#players thead").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]"); if (!b) return;
    const key = b.dataset.sort;
    state.dir = state.sort === key ? -state.dir : (key === "name" || key === "owner" ? 1 : -1);
    state.sort = key;
    $("#players thead").querySelectorAll("th").forEach((th) => th.removeAttribute("aria-sort"));
    b.parentElement.setAttribute("aria-sort", state.dir < 0 ? "descending" : "ascending");
    renderPlayers();
  });
  $("#players tbody").addEventListener("click", toggleRow);
  $("#players tbody").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(e); } });
  $("#more button").addEventListener("click", () => { state.limit += PAGE; renderPlayers(); });

  setupTabs();
  renderPlayers();
  renderPicks();
  renderCurves();
  renderHow();
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const show = (t) => {
    tabs.forEach((x) => { x.setAttribute("aria-selected", x === t); x.tabIndex = x === t ? 0 : -1; $("#" + x.getAttribute("aria-controls")).hidden = x !== t; });
    t.focus();
  };
  tabs.forEach((t, i) => {
    t.tabIndex = i ? -1 : 0;
    t.addEventListener("click", () => show(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(tabs[(i + 1) % tabs.length]);
      if (e.key === "ArrowLeft") show(tabs[(i - 1 + tabs.length) % tabs.length]);
    });
  });
}

/* ------------------------------------------------------------ players */

function filtered() {
  const { q, pos, owner, hz, sort, dir } = state;
  const rows = DATA.players.filter((p) =>
    (pos === "All" || p.pos === pos) &&
    (!owner || (owner === "-" ? !p.owner : p.owner === owner)) &&
    (!q || p.name.toLowerCase().includes(q) || (p.team || "").toLowerCase() === q));
  rows.forEach((p) => { p.v = valueAt(p, hz); });
  rows.sort((a, b) => {
    const x = a[sort], y = b[sort];
    if (typeof x === "string" || typeof y === "string") return dir * String(x || "~").localeCompare(String(y || "~"));
    return dir * ((x ?? -1) - (y ?? -1));
  });
  return rows;
}

function renderPlayers() {
  const rows = filtered();
  const top = Math.max(1, ...DATA.players.map((p) => Math.max(p.win, p.bal, p.lt)));
  const shown = rows.slice(0, state.limit);
  $("#players tbody").innerHTML = shown.map((p, i) => {
    const w = Math.max(0.5, (p.v / top) * 100);
    const inj = p.inj ? `<span class="tag" title="Sleeper status">${esc(p.inj)}</span>` : "";
    const sub = [p.pos, p.team || "FA", p.age ? `${p.age}` : null].filter(Boolean).join(" · ");
    const open = state.open.has(p.id);
    return `<tr class="row" tabindex="0" data-id="${p.id}" aria-expanded="${open}">
      <td class="r muted num">${i + 1}</td>
      <td><div class="who"><b>${esc(p.name)}${inj}</b><span>${esc(sub)}<span class="hide-lg">${p.owner ? " · " + esc(p.owner) : ""}</span></span></div></td>
      <td class="hide-sm">${p.owner ? esc(p.owner) : '<span class="muted">Free agent</span>'}</td>
      <td class="valcell"><div class="bar"><i style="width:${w.toFixed(1)}%"></i><span>${fmt(p.v)}</span></div></td>
      <td class="r num hide-sm">${fmt(p.win)}</td>
      <td class="r num hide-sm">${fmt(p.bal)}</td>
      <td class="r num hide-sm">${fmt(p.lt)}</td>
      <td class="r num hide-sm muted">${fmt(p.fc)}</td>
      <td class="r num hide-sm muted">${fmt(p.dp)}</td>
    </tr>${open ? detailRow(p) : ""}`;
  }).join("") || `<tr><td colspan="9" class="muted">No players match.</td></tr>`;
  $("#more").hidden = rows.length <= state.limit;
}

function detailRow(p) {
  const h = DATA.config.horizons;
  const item = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const parts = p.pos === "K" || p.pos === "DEF"
    ? item("Rest-of-season points", p.ros) + item("Value", `${fmt(p.bal)} (points only, capped)`)
    : item("Points this season (on value scale)", fmt(p.p_now)) +
      item("Points next 1–3 seasons", fmt(p.p_13)) +
      item("Points 4+ seasons out", fmt(p.p_4)) +
      item("Dynasty market (blend)", fmt(blend(p))) +
      item("Redraft market (Win Now)", fmt(p.red)) +
      item("Baseline points per game", p.ppg ?? "–") +
      item("Projected ppg this season", p.proj ?? "–") +
      item("Last 3 seasons ppg", p.hist ?? "–") +
      item("Rest-of-season points", p.ros);
  const mix = (k) => `${Math.round(h[k].points_this_season * 100)}/${Math.round(h[k].points_years_1_3 * 100)}/${Math.round(h[k].points_years_4_plus * 100)}/${Math.round(h[k].market * 100)}`;
  return `<tr class="detail"><td></td><td colspan="8"><dl class="parts">${parts}</dl>
    <p class="note">Mix (this season / 1–3 / 4+ / market): Win Now ${mix("win_now")}, Balanced ${mix("balanced")}, Long-Term ${mix("long_term")}.${p.pos === "QB" && DATA.meta.qb_premium !== 1 ? ` Includes the league QB premium (×${DATA.meta.qb_premium}).` : ""}</p></td></tr>`;
}

function blend(p) {
  const m = DATA.config.market;
  if (p.fc != null && p.dp != null) return (m.fantasycalc_weight * p.fc + m.dynastyprocess_weight * p.dp) / (m.fantasycalc_weight + m.dynastyprocess_weight);
  return p.fc ?? p.dp;
}

function toggleRow(e) {
  const tr = e.target.closest("tr.row"); if (!tr) return;
  const id = tr.dataset.id;
  state.open.has(id) ? state.open.delete(id) : state.open.add(id);
  renderPlayers();
  const again = $(`#players tr.row[data-id="${CSS.escape(id)}"]`);
  if (again && e.type === "keydown") again.focus();
}

/* ------------------------------------------------------------ picks */

const ORD = (n) => n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th");
const TIER = { early: "Early", mid: "Mid", late: "Late", any: "Unknown slot" };

function renderPicks() {
  $("#pickvalues tbody").innerHTML = DATA.picks.map((k) => `<tr>
    <td>${k.tier === "any" ? `${k.year} ${ORD(k.round)} <span class="muted">(any slot)</span>` : `${k.year} ${TIER[k.tier]} ${ORD(k.round)}`}</td>
    <td class="r num muted">${k.overall[0] === k.overall[1] ? k.overall[0] : k.overall.join("–")}</td>
    <td class="r num">${fmt(k.win)}</td><td class="r num">${fmt(k.bal)}</td><td class="r num">${fmt(k.lt)}</td></tr>`).join("");
  const anyVal = {};
  DATA.picks.filter((k) => k.tier === "any").forEach((k) => { anyVal[`${k.year}-${k.round}`] = k.bal; });
  const byOwner = {};
  DATA.owned_picks.forEach((k) => { (byOwner[k.owner] ||= []).push(k); });
  const rows = Object.entries(byOwner).map(([o, list]) => ({ o, list, total: list.reduce((s, k) => s + (anyVal[`${k.year}-${k.round}`] || 0), 0) }))
    .sort((a, b) => b.total - a.total);
  $("#pickowners tbody").innerHTML = rows.map(({ o, list, total }) => {
    const firsts = list.filter((k) => k.round <= 2).map((k) => `${k.year} ${ORD(k.round)}${k.from !== o ? ` (${esc(k.from)})` : ""}`).join(", ");
    return `<tr><td><b>${esc(o)}</b></td><td>${list.length} picks<br><span class="note">1sts and 2nds: ${firsts || "none"}</span></td><td class="r num">${fmt(total)}</td></tr>`;
  }).join("");
}

/* ------------------------------------------------------------ age curves */

function renderCurves() {
  const W = 300, H = 170, L = 30, R = 10, T = 12, B = 26;
  const ages = Array.from({ length: 18 }, (_, i) => 21 + i);
  const x = (a) => L + ((a - 21) / 17) * (W - L - R);
  const y = (v) => T + (1 - v) * (H - T - B);
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; document.body.appendChild(tip);
  const box = $("#curves");
  box.innerHTML = Object.entries(DATA.age_curves).map(([pos, c]) => {
    const pts = ages.map((a) => [a, c.multiplier[a]]);
    const path = pts.map(([a, v], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    const ticks = [21, 25, 29, 33, 37].map((a) => `<text class="axis" x="${x(a)}" y="${H - 8}" text-anchor="middle">${a}</text>`).join("");
    const cliff = c.cliff_age ? `<line class="ref" x1="${x(c.cliff_age)}" x2="${x(c.cliff_age)}" y1="${T}" y2="${H - B}"/><text class="axis" x="${x(c.cliff_age) + 4}" y="${T + 10}">cliff ${c.cliff_age}</text>` : "";
    const hits = pts.map(([a, v]) => `<rect class="hit" data-pos="${pos}" data-age="${a}" x="${x(a) - 8}" y="${T}" width="16" height="${H - T - B}"/>`).join("");
    return `<div class="card"><h3>${pos}</h3><p class="note">Peak at ${c.peak_age}; below 0.8 of peak from ${c.cliff_age ?? "–"}</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${pos} age curve: peak at ${c.peak_age}, cliff at ${c.cliff_age}">
        ${grid}${ticks}${cliff}<path class="line" d="${path}"/><circle class="dot" r="4" cx="0" cy="0" visibility="hidden"/>${hits}</svg></div>`;
  }).join("");
  box.addEventListener("pointermove", (e) => {
    const r = e.target.closest(".hit");
    if (!r) { tip.hidden = true; box.querySelectorAll(".dot").forEach((d) => d.setAttribute("visibility", "hidden")); return; }
    const c = DATA.age_curves[r.dataset.pos], a = +r.dataset.age, v = c.multiplier[a];
    const dot = r.closest("svg").querySelector(".dot");
    box.querySelectorAll(".dot").forEach((d) => d.setAttribute("visibility", "hidden"));
    dot.setAttribute("cx", x(a)); dot.setAttribute("cy", y(v)); dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${r.dataset.pos} age ${a}: ${v.toFixed(2)} of peak (${c.pairs[a]} season pairs)`;
    tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = e.clientY - 34 + "px";
  });
  box.addEventListener("pointerleave", () => { tip.hidden = true; box.querySelectorAll(".dot").forEach((d) => d.setAttribute("visibility", "hidden")); });

  const pos = Object.keys(DATA.age_curves);
  $("#curvetable").innerHTML = `<table><thead><tr><th>Age</th>${pos.map((p) => `<th class="r">${p}</th>`).join("")}</tr></thead><tbody>` +
    ages.map((a) => `<tr><td>${a}</td>${pos.map((p) => `<td class="r num">${DATA.age_curves[p].multiplier[a].toFixed(2)} <span class="muted">(${DATA.age_curves[p].pairs[a]})</span></td>`).join("")}</tr>`).join("") +
    `</tbody></table>`;
  $("#curvetable-toggle").addEventListener("click", (e) => {
    const t = $("#curvetable"); t.hidden = !t.hidden;
    e.target.setAttribute("aria-expanded", !t.hidden);
    e.target.textContent = t.hidden ? "Show as a table" : "Hide the table";
  });
}

/* ------------------------------------------------------------ how it works */

function renderHow() {
  const { meta: m, config: c } = DATA;
  const pct = (v) => `${Math.round(v * 100)}%`;
  const hz = c.horizons;
  const row = (label, key) => `<tr><td>${label}</td>${["win_now", "balanced", "long_term"].map((h) => `<td class="r num">${pct(hz[h][key])}</td>`).join("")}</tr>`;
  const repl = Object.entries(m.replacement_ppg).map(([k, v]) => `${k} ${v}`).join(", ");
  $("#how").innerHTML = `
    <h3>What a value is made of</h3>
    <p>Each player's value blends two things: <b>points</b> (projected fantasy points above a replacement starter, in ${esc(m.league)}'s own scoring) and <b>market value</b> (what managers pay in trades). The horizon slider decides the mix.</p>
    <div class="tablewrap"><table><thead><tr><th>Ingredient</th><th class="r">Win Now</th><th class="r">Balanced</th><th class="r">Long-Term</th></tr></thead><tbody>
      ${row("Points this season", "points_this_season")}${row("Points next 1–3 seasons (age-curved)", "points_years_1_3")}${row("Points 4+ seasons out (age-curved)", "points_years_4_plus")}${row("Market value", "market")}
    </tbody></table></div>
    <p>Points are put on the same scale as the market by rank: the 10th-best points total gets the 10th-highest market value. Win Now uses FantasyCalc's redraft values as its market; the other horizons use the dynasty market, ${pct(c.market.fantasycalc_weight)} FantasyCalc and ${pct(c.market.dynastyprocess_weight)} DynastyProcess.</p>
    <h3>This league</h3>
    <p>Format ${esc(m.format.key)}, ${m.format.teams} teams. Replacement starter, points per game: ${esc(repl)}.${m.qb_premium !== 1 ? ` QBs carry a league premium of ×${m.qb_premium}.` : ""}
    ${m.counts.both_sources} players are valued by both market sources; ${m.counts.fantasycalc} by FantasyCalc and ${m.counts.dynastyprocess} by DynastyProcess.</p>
    <h3>Not in yet</h3>
    <p>Manager sliders (rookie, pick and star value), the star value rule for trades, roster fit, slot projections for future picks and the trade builder come in Phases 2 and 3.</p>
    ${m.notes.length || m.fetch_failures.length ? `<h3>Problems in this build</h3><p>${[...m.notes, ...m.fetch_failures.map((f) => `Fetching ${f} failed; the last good copy was used where there was one.`)].map(esc).join("<br>")}</p>` : ""}
    <h3>Sources</h3>
    <p>Trade-market values from <a href="https://fantasycalc.com" target="_blank" rel="noopener">FantasyCalc.com</a>. Expert values and the player ID map from <a href="https://github.com/dynastyprocess/data" target="_blank" rel="noopener">DynastyProcess</a>. Leagues, rosters, projections and stats from the <a href="https://docs.sleeper.com/" target="_blank" rel="noopener">Sleeper API</a>. Rebuilt every four hours.</p>`;
}

load().catch((err) => {
  $("#status").classList.add("warn");
  $("#status").lastElementChild.textContent = "Couldn't load values";
  console.error(err);
});
