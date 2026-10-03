"use strict";
/* Trade analyser. General mode: build a trade by hand. Linked mode: connect
   a Sleeper league, pick two teams and trade from their live rosters and
   picks (league.js). Either way each manager judges the trade on their own
   horizon and sliders. The trade lives in the address (#lg=...&a=...&b=...)
   so a link reopens it. Needs model.js, shared.js and league.js. */

const SLIDER_INFO = [
  { k: "rookie", label: "Rookie optimism", help: "Rookies and the next draft's 1sts and 2nds", group: "main" },
  { k: "pick", label: "Pick optimism", help: "Every pick, more so further out", group: "main" },
  { k: "star", label: "Star value", help: "How little extra weak pieces count", group: "main" },
  { k: "risk", label: "Risk tolerance", help: "Injured players and those near their age cliff", group: "more" },
  { k: "market", label: "Market trust", help: "Trade market over projected points", group: "more" },
  { k: "qb", label: "Superflex QB premium", help: "Quarterbacks", group: "more" },
  { k: "te", label: "TE premium confidence", help: "Tight ends", group: "more" },
];
const SIDES = ["a", "b"];
const PLACEHOLDER = { a: "Team A", b: "Team B" };
const USER_KEY = "tradelab-username";

let DATA = null, MODEL = null, INDEX = [];
let LG = null; // the linked Sleeper league, or null in general mode
let MY_LEAGUES = null; // the username's leagues, once looked up
const state = { a: blankSide(), b: blankSide() };

function blankSide() { return { name: "", rid: null, gets: [], hz: 50, s: { ...NEUTRAL } }; }
const other = (x) => (x === "a" ? "b" : "a");
const teamOf = (x) => (LG && state[x].rid != null ? LG.team(state[x].rid) : null);
const nameOf = (x) => teamOf(x)?.name || state[x].name.trim() || PLACEHOLDER[x];
const modelKey = (k) => (LG ? LG.resolve(k) : k);
const sliderText = (v) => (v === 0 ? "Neutral" : v > 0 ? `+${v}` : `−${-v}`);
const storeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

/* A team's default horizon comes from its situation in model.config.json. */
function defaultHz(t) { return DATA.config.situation_horizons?.[t?.situation] ?? 50; }

async function load() {
  DATA = await loadLeague();
  MODEL = makeModel(DATA, DATA.config);
  buildIndex();
  SIDES.forEach(setupSide);
  setupConnect();
  setupActions();
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get("lg")) {
    try { await connect(q.get("lg")); }
    catch (e) { say(`Couldn't open the linked league: ${e.message} Showing general mode.`); }
  }
  applyHash(q);
  SIDES.forEach(syncControls);
  render();
}

/* ------------------------------------------------------------ the Sleeper link */

function say(text) { $("#connectmsg").textContent = text; }

function setupConnect() {
  $("#username").value = storeGet(USER_KEY) || "";
  $("#userform").addEventListener("submit", (e) => { e.preventDefault(); findLeagues(); });
  $("#quick").innerHTML = DATA.leagues.filter((l) => l.sleeper_league_id)
    .map((l) => `<button class="btn" type="button" data-league="${esc(l.sleeper_league_id)}">Open ${esc(l.name)}</button>`).join("");
  $("#quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-league]");
    if (b) openLeague(b.dataset.league, null);
  });
  $("#leaguesel").addEventListener("change", (e) => openLeague(e.target.value, MY_LEAGUES?.user.user_id));
  SIDES.forEach((x) => $(`#team-${x}`).addEventListener("change", (e) => { setTeam(x, +e.target.value); render(); }));
  $("#general").addEventListener("click", () => {
    LG = null;
    state.a = blankSide(); state.b = blankSide();
    buildIndex(); showLink(); SIDES.forEach(syncControls); render();
    say("General mode: add any player or pick and set each side by hand.");
  });
}

async function findLeagues() {
  const name = $("#username").value.trim();
  if (!name) return;
  say("Looking up your leagues on Sleeper…");
  try {
    MY_LEAGUES = await sleeperLeagues(name, DATA.meta.season);
    storeSet(USER_KEY, name);
  } catch (e) { say(e.message); return; }
  const ids = new Set(DATA.leagues.map((l) => l.sleeper_league_id));
  const ours = MY_LEAGUES.leagues.filter((l) => ids.has(l.league_id));
  if (!ours.length) {
    say(`None of ${name}'s ${MY_LEAGUES.leagues.length} leagues this season are set up yet. Trade Lab covers ${DATA.leagues.map((l) => l.name).join(", ")}.`);
    return;
  }
  await openLeague(ours[0].league_id, MY_LEAGUES.user.user_id);
}

/* Link a league, then put the user's team on side A. */
async function openLeague(id, userId) {
  say("Loading the league from Sleeper…");
  try { await connect(id); } catch (e) { say(e.message); return; }
  state.a = blankSide(); state.b = blankSide();
  const mine = LG.teams.find((t) => userId && t.ownerIds.includes(userId));
  const first = mine || LG.teams[0];
  setTeam("a", first.rid);
  setTeam("b", LG.teams.find((t) => t.rid !== first.rid).rid);
  render();
}

async function connect(id) {
  const entry = DATA.leagues.find((l) => l.sleeper_league_id === id);
  if (!entry) throw new Error("That league isn't set up in Trade Lab yet.");
  if (DATA.meta.slug !== entry.slug) {
    DATA = await loadLeague(entry.slug);
    MODEL = makeModel(DATA, DATA.config);
  }
  LG = makeLeague(await sleeperLeague(id), DATA);
  buildIndex();
  showLink();
  say("");
}

function showLink() {
  $("#linkbar").hidden = !LG;
  if (!LG) return;
  const yours = MY_LEAGUES?.leagues || [];
  const ids = new Set(DATA.leagues.map((l) => l.sleeper_league_id));
  const opts = yours.length
    ? yours.map((l) => `<option value="${esc(l.league_id)}"${ids.has(l.league_id) ? "" : " disabled"}>${esc(l.name)}${ids.has(l.league_id) ? "" : " (not set up yet)"}</option>`)
    : DATA.leagues.map((l) => `<option value="${esc(l.sleeper_league_id)}">${esc(l.name)}</option>`);
  $("#leaguesel").innerHTML = opts.join("");
  $("#leaguesel").value = LG.league.league_id;
  const teams = [...LG.teams].sort((x, y) => x.name.localeCompare(y.name));
  SIDES.forEach((x) => { $(`#team-${x}`).innerHTML = teams.map((t) => `<option value="${t.rid}">${esc(t.name)}</option>`).join(""); });
}

/* Put a team on one side. The other side's list comes from this team's
   roster, so it starts again. */
function setTeam(x, rid) {
  if (state[other(x)].rid === rid) { [state.a, state.b] = [state.b, state.a]; SIDES.forEach(syncControls); return; }
  const t = LG.team(rid);
  state[x] = { ...blankSide(), rid, name: t.name, gets: state[x].gets.filter((k) => LG.owns(state[other(x)].rid, k)), hz: defaultHz(t) };
  state[other(x)].gets = [];
  syncControls(x);
}

/* ------------------------------------------------------------ search */

function entry(key) {
  if (LG?.isPick(key)) {
    const info = LG.pickInfo(key), a = MODEL.asset(info.model);
    return { key, label: pickLabel(info), sub: info.how, hay: `${info.year} ${ORD(info.round)} pick round ${info.round} ${info.from.name}`.toLowerCase(), v: MODEL.value(a, 50), pick: true };
  }
  const p = MODEL.asset(key)?.p;
  if (!p) return { key, label: "Unknown player", sub: "Added since the last update", hay: "", v: 0 };
  const sub = [p.pos, p.team || "FA", p.age ? `${p.age}` : null, LG ? null : p.owner || "Free agent"].filter(Boolean).join(" · ");
  return { key, label: p.name, sub, rookie: p.rk, hay: `${p.name} ${p.team || ""} ${p.pos} ${p.owner || ""}`.toLowerCase(), v: MODEL.value(MODEL.asset(p.id), 50) };
}

function buildIndex() {
  if (LG) { INDEX = []; return; }
  const players = DATA.players.map((p) => entry(p.id));
  const picks = MODEL.pickRows().map((a) => {
    const first = a.overall[0], last = a.overall[a.overall.length - 1];
    const sub = a.tier === "any" ? `Pick · slot unknown (${first}–${last} overall)` : `Pick · ${first}–${last} overall`;
    return { key: a.key, label: a.name, sub, hay: `${a.name} ${a.tier} pick round ${a.round}`.toLowerCase(), v: MODEL.value(a, 50), pick: true };
  });
  INDEX = [...players, ...picks];
}

/* Linked: only the other team's players and picks. */
function pool(x) {
  if (!LG) return INDEX;
  const from = state[other(x)].rid;
  return from == null ? [] : LG.assets(from, (id) => MODEL.value(MODEL.asset(id), 50)).map(entry);
}

function search(q, x) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const used = new Set([...state.a.gets, ...state.b.gets]);
  const lead = tokens.join(" ");
  return pool(x).filter((e) => !used.has(e.key) && tokens.every((t) => e.hay.includes(t)))
    .sort((p, q2) => (q2.label.toLowerCase().startsWith(lead) - p.label.toLowerCase().startsWith(lead)) || q2.v - p.v)
    .slice(0, 8);
}

/* "Ross's 2027 1st", or "2027 1st" for a team's own pick shown on its side. */
function pickLabel(info) { return `${info.from.name}'s ${info.year} ${ORD(info.round)}`; }

/* ------------------------------------------------------------ side panels */

function setupSide(x) {
  const el = $(`#side-${x}`);
  el.append($("#side-tpl").content.cloneNode(true));
  $('[data-id="name-label"]', el).id = `name-${x}-label`;
  const name = $('[data-field="name"]', el);
  name.placeholder = PLACEHOLDER[x];
  name.addEventListener("input", () => { state[x].name = name.value; render(); });

  const groups = { main: $('[data-group="main"]', el), more: $('[data-group="more"]', el) };
  SLIDER_INFO.forEach(({ k, label, help, group }) => {
    groups[group].insertAdjacentHTML("beforeend", `<label class="slider"><span class="sl-top"><span>${label}</span><output data-out="${k}">Neutral</output></span>
      <input type="range" min="-2" max="2" step="1" value="0" data-slider="${k}" aria-describedby="help-${x}-${k}">
      <span class="note" id="help-${x}-${k}">${help}</span></label>`);
  });
  $$("[data-slider]", el).forEach((inp) => inp.addEventListener("input", () => { state[x].s[inp.dataset.slider] = +inp.value; render(); }));
  $('[data-field="hz"]', el).addEventListener("input", (e) => { state[x].hz = +e.target.value; render(); });

  const box = $('[data-field="search"]', el);
  const list = $(".results", el);
  list.id = `results-${x}`;
  box.setAttribute("aria-controls", list.id);
  box.setAttribute("aria-label", "Add a player or pick");
  let hits = [], active = -1;
  const close = () => { list.hidden = true; box.setAttribute("aria-expanded", "false"); box.removeAttribute("aria-activedescendant"); active = -1; };
  const show = () => {
    hits = search(box.value, x);
    active = hits.length ? 0 : -1;
    list.innerHTML = hits.map((h, i) => `<li role="option" id="opt-${x}-${i}" data-i="${i}" aria-selected="${i === active}">
      <b>${esc(h.label)}${h.rookie ? ' <span class="tag rk">R</span>' : ""}</b><span>${esc(h.sub)}</span><span class="num">${fmt(h.v)}</span></li>`).join("")
      || (box.value.trim() ? '<li class="none">Nothing matches.</li>' : "");
    list.hidden = !box.value.trim();
    box.setAttribute("aria-expanded", String(!list.hidden));
    mark();
  };
  const mark = () => {
    $$("[role=option]", list).forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    if (active >= 0) box.setAttribute("aria-activedescendant", `opt-${x}-${active}`); else box.removeAttribute("aria-activedescendant");
  };
  const pick = (i) => {
    if (!hits[i]) return;
    state[x].gets.push(hits[i].key);
    box.value = "";
    close();
    render();
    box.focus();
  };
  box.addEventListener("input", show);
  box.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && hits.length) { e.preventDefault(); active = (active + 1) % hits.length; mark(); }
    else if (e.key === "ArrowUp" && hits.length) { e.preventDefault(); active = (active - 1 + hits.length) % hits.length; mark(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") close();
  });
  box.addEventListener("blur", () => setTimeout(close, 150));
  list.addEventListener("pointerdown", (e) => { const li = e.target.closest("[data-i]"); if (li) { e.preventDefault(); pick(+li.dataset.i); } });

  $(".assets", el).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-remove]"); if (!b) return;
    state[x].gets.splice(+b.dataset.remove, 1);
    render();
  });
  $(".rlist", el).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]"); if (!b) return;
    const gets = state[x].gets, i = gets.indexOf(b.dataset.key);
    if (i >= 0) gets.splice(i, 1); else gets.push(b.dataset.key);
    render();
  });
  syncControls(x);
}

/* Put the controls back in line with state (after swap, clear or a link). */
function syncControls(x) {
  const el = $(`#side-${x}`), st = state[x];
  const name = $('[data-field="name"]', el);
  name.value = teamOf(x)?.name || st.name;
  name.readOnly = Boolean(LG);
  $('[data-field="hz"]', el).value = st.hz;
  SLIDER_INFO.forEach(({ k }) => { $(`[data-slider="${k}"]`, el).value = st.s[k]; });
  const changed = SLIDER_INFO.some(({ k, group }) => group === "more" && st.s[k]);
  if (changed) $("details.more-settings", el).open = true;
  if (LG && st.rid != null) $(`#team-${x}`).value = st.rid;
}

function setupActions() {
  $("#swap").addEventListener("click", () => { [state.a, state.b] = [state.b, state.a]; SIDES.forEach(syncControls); render(); });
  $("#clear").addEventListener("click", () => {
    SIDES.forEach((x) => {
      const t = teamOf(x);
      state[x] = t ? { ...blankSide(), rid: t.rid, name: t.name, hz: defaultHz(t) } : blankSide();
    });
    SIDES.forEach(syncControls);
    render();
  });
  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); $("#copied").textContent = "Link copied."; }
    catch { $("#copied").textContent = "Copy the address bar to share this trade."; }
  });
}

/* ------------------------------------------------------------ render */

function render() {
  const t = {};
  SIDES.forEach((x) => { t[x] = { gets: state[x].gets.map(modelKey), hz: state[x].hz, s: state[x].s }; });
  const j = MODEL.judge(t);
  SIDES.forEach((x) => renderSide(x, j[x]));
  renderVerdict(j);
  writeHash();
}

function assetText(key, a) {
  if (LG?.isPick(key)) {
    const info = LG.pickInfo(key);
    return { name: pickLabel(info), sub: info.how };
  }
  if (!a) return { name: key, sub: "Not in this league's values" };
  if (a.kind === "player") return { name: a.name, sub: [a.p.pos, a.p.team || "FA", a.p.age, LG ? null : a.p.owner].filter(Boolean).join(" · ") };
  const first = a.overall[0], last = a.overall[a.overall.length - 1];
  return { name: a.name, sub: `Pick · ${first === last ? `${first} overall` : `${first}–${last} overall`}` };
}

function tags(key, a, from) {
  let html = "";
  if (a?.p?.rk) html += '<span class="tag rk" title="Rookie">R</span>';
  if (a?.p?.inj) html += `<span class="tag">${esc(a.p.inj)}</span>`;
  if (from?.reserve.has(key)) html += '<span class="tag" title="In an IR spot">IR spot</span>';
  if (from?.taxi.has(key)) html += '<span class="tag rk" title="On the taxi squad">Taxi</span>';
  return html;
}

function renderSide(x, view) {
  const el = $(`#side-${x}`), st = state[x];
  const from = teamOf(other(x));
  $('[data-out="hz"]', el).textContent = horizonName(st.hz);
  SLIDER_INFO.forEach(({ k }) => { $(`[data-out="${k}"]`, el).textContent = sliderText(st.s[k]); });
  $(".assets", el).innerHTML = view.gets.map((it, i) => {
    const key = st.gets[i], a = it.asset, txt = assetText(key, a);
    const share = it.value > 0 ? it.counted / it.value : 1;
    const cut = share < 0.995 ? `<span class="note" title="Star value: an extra piece below the quality line">counts ${Math.round(share * 100)}%</span>` : "";
    return `<li><div class="who"><b>${esc(txt.name)}${tags(key, a, from)}</b><span>${esc(txt.sub)}</span></div>
      <div class="val"><span class="num">${fmt(it.value)}</span>${cut}</div>
      <button type="button" class="x" data-remove="${i}" aria-label="Remove ${esc(txt.name)}">×</button></li>`;
  }).join("") || `<li class="empty note">${LG ? `Pick from ${esc(nameOf(other(x)))}'s roster below, or search.` : "Nothing yet."}</li>`;
  $('[data-field="search"]', el).placeholder = LG ? `Search ${nameOf(other(x))}'s players and picks` : "Add a player or pick (e.g. 2027 1st)";
  renderTeamLine(x, el);
  renderRoster(x, el, from);
}

/* Record, lineup strength, roster space and FAAB for a linked team. */
function renderTeamLine(x, el) {
  const line = $('[data-out="team"]', el), t = teamOf(x);
  line.hidden = !t;
  if (!t) return;
  const rec = `${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ""}`;
  const sit = t.situation ? `${t.situation[0].toUpperCase()}${t.situation.slice(1)} (horizon defaults to ${horizonName(defaultHz(t))})`
    : "No situation set: horizon defaults to Balanced, so set it by hand";
  const bits = [sit, `${rec}, ${ORD(t.recordRank)} on record`];
  if (LG.weeksLeft) bits.push(`lineup ${ORD(t.strengthRank)} best (${t.strength.toFixed(1)} a week)`);
  bits.push(`${t.active} of ${LG.limit} roster spots`);
  if (t.faab != null) bits.push(`$${t.faab} FAAB left`);
  line.textContent = bits.join(" · ");
}

/* The other team's players and picks, ready to tap into this side. */
function renderRoster(x, el, from) {
  const box = $(".roster", el);
  box.hidden = !from;
  if (!from) return;
  const st = state[x], chosen = new Set(st.gets);
  const val = (k) => MODEL.value(MODEL.asset(modelKey(k)), st.hz, st.s);
  const keys = LG.assets(from.rid, (id) => val(id));
  $("summary", box).textContent = `${from.name}'s roster: ${from.players.length} players, ${from.picks.length} picks`;
  let group = "";
  $(".rlist", box).innerHTML = keys.map((k) => {
    const a = MODEL.asset(modelKey(k)), txt = assetText(k, a);
    const g = LG.isPick(k) ? "Picks" : a?.p?.pos || "Other";
    const head = g !== group ? `<li class="rgroup">${esc((group = g))}</li>` : "";
    const on = chosen.has(k);
    return `${head}<li><button type="button" data-key="${esc(k)}" aria-pressed="${on}">
      <span class="who"><b>${esc(txt.name)}${tags(k, a, from)}</b><span>${esc(txt.sub)}</span></span>
      <span class="num">${fmt(val(k))}</span><span class="tick" aria-hidden="true">${on ? "✓" : "+"}</span></button></li>`;
  }).join("");
}

function settingsText(x) {
  const st = state[x];
  const moved = SLIDER_INFO.filter(({ k }) => st.s[k]).map(({ k, label }) => `${label.toLowerCase()} ${sliderText(st.s[k])}`);
  return `Judged at ${horizonName(st.hz)}${moved.length ? `, ${moved.join(", ")}` : ", neutral settings"}.`;
}

function renderVerdict(j) {
  const box = $("#verdict");
  if (!state.a.gets.length || !state.b.gets.length) {
    box.innerHTML = '<p class="note">Add at least one player or pick to each side to see the verdict.</p>';
    return;
  }
  const mood = (v) => (v.band === "fair" ? "fair" : v.gap > 0 ? "won" : "lost");
  const sideHtml = (x) => {
    const v = j[x];
    const total = v.get + v.give || 1;
    const cut = [...v.gets, ...v.gives].filter((it) => it.value > 0 && it.counted / it.value < 0.995).length;
    return `<div class="vside ${mood(v)}">
      <div class="vhead"><span class="grade" aria-label="Grade ${v.grade}">${v.grade}</span>
        <div class="vname"><b>${esc(nameOf(x))}</b><span class="vlabel">${v.label}</span></div>
        <span class="vgap num">${signedPct(v.gap)}</span></div>
      <div class="tug" role="img" aria-label="Gets ${fmt(v.get)}, gives ${fmt(v.give)}"><i class="get" style="width:${(v.get / total * 100).toFixed(1)}%"></i><i class="give" style="width:${(v.give / total * 100).toFixed(1)}%"></i></div>
      <div class="tugkey"><span>Gets <b class="num">${fmt(v.get)}</b></span><span>Gives <b class="num">${fmt(v.give)}</b></span></div>
      <p class="note">${esc(settingsText(x))}${cut ? ` ${cut} extra piece${cut > 1 ? "s" : ""} below the quality line count${cut > 1 ? "" : "s"} for less (star value).` : ""}</p>
    </div>`;
  };
  const strip = j.strip.map((v) => {
    const who = v.band === "fair" ? "Fair" : `${esc(v.gap > 0 ? nameOf("a") : nameOf("b"))} by ${pct(v.gap)}`;
    return `<div class="${v.band === "fair" ? "fair" : ""}"><span class="note">${horizonName(v.hz)}</span><b>${who}</b><span class="note">${v.band === "fair" ? pct(v.gap) + " gap" : BAND_WIN[v.band]}</span></div>`;
  }).join("");
  box.innerHTML = `<h2>Verdict</h2><p class="read">${esc(readLine(j))}</p>
    <div class="vgrid">${sideHtml("a")}${sideHtml("b")}</div>
    ${lineupHtml()}
    <h3>Same trade at every horizon, neutral settings</h3>
    <div class="strip">${strip}</div>`;
}

/* D14: each team's best starting lineup before and after, plus roster space.
   Shown, not yet counted in the verdict. */
function lineupHtml() {
  if (!LG || teamOf("a") == null || teamOf("b") == null) return "";
  const nm = (id) => MODEL.asset(id)?.name || "Unknown player";
  const cards = SIDES.map((x) => {
    const c = LG.change(state[x].rid, state[other(x)].gets, state[x].gets);
    const d = c.after - c.before;
    const moves = [c.in.length ? `In: ${c.in.map(nm).join(", ")}.` : "", c.out.length ? `Out: ${c.out.map(nm).join(", ")}.` : ""].filter(Boolean).join(" ") || "No change to the starters.";
    const over = c.activeAfter - c.limit;
    const space = over > 0
      ? `<p class="note warntext">${c.activeAfter} players for ${c.limit} roster spots: ${over} must be dropped, or moved to IR or the taxi squad if eligible.</p>`
      : `<p class="note">${c.activeAfter} of ${c.limit} roster spots after the trade.</p>`;
    const cls = Math.abs(d) < 0.05 ? "" : d > 0 ? "won" : "lost";
    return `<div class="vside ${cls}"><div class="vname"><b>${esc(nameOf(x))}</b></div>
      <p class="lu"><span class="num">${c.before.toFixed(1)}</span> → <span class="num">${c.after.toFixed(1)}</span> a week <b class="num">(${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)})</b></p>
      <p class="note">${esc(moves)}</p>${space}</div>`;
  }).join("");
  const why = LG.weeksLeft
    ? `Best lineup from each roster, in projected points a week over the last ${LG.weeksLeft} weeks of the regular season (Sleeper's projections in this league's scoring). Shown alongside the verdict; not yet counted in it.`
    : "Lineups aren't projected outside the regular season.";
  return `<h3>Starting lineups</h3><div class="vgrid">${cards}</div><p class="note">${why}</p>`;
}

function readLine(j) {
  const A = nameOf("a"), B = nameOf("b");
  const won = (v) => v.band !== "fair" && v.gap > 0, lost = (v) => v.band !== "fair" && v.gap < 0;
  const a = j.a, b = j.b;
  if (won(a) && won(b)) return "Both sides come out ahead on their own horizons: a good trade.";
  if (!won(a) && !lost(a) && !won(b) && !lost(b)) return "Fair for both sides.";
  if (lost(a) && lost(b)) return "Both sides lose on their own horizons.";
  const [W, L, wv, lv] = won(a) || (lost(b) && !lost(a)) ? [A, B, a, b] : [B, A, b, a];
  if (won(wv) && lost(lv)) return `${W} wins from both sides' point of view.`;
  if (won(wv)) return `${W} wins; for ${L} it's about even.`;
  return `${L} loses on their own horizon; for ${W} it's about even.`;
}

/* ------------------------------------------------------------ the address */

function writeHash() {
  const q = new URLSearchParams();
  if (LG) q.set("lg", LG.league.league_id);
  SIDES.forEach((x) => {
    const st = state[x];
    if (LG && st.rid != null) q.set(`${x}t`, st.rid);
    else if (st.name.trim()) q.set(`${x}n`, st.name.trim());
    if (st.gets.length) q.set(x, st.gets.join(","));
    if (st.hz !== (LG ? defaultHz(teamOf(x)) : 50)) q.set(`${x}h`, st.hz);
    if (SLIDER_INFO.some(({ k }) => st.s[k])) q.set(`${x}s`, SLIDER_INFO.map(({ k }) => st.s[k]).join(","));
  });
  history.replaceState(null, "", `${location.pathname}${location.search}${q.toString() ? "#" + q : ""}`);
}

function applyHash(q) {
  SIDES.forEach((x) => {
    const st = state[x];
    const t = LG ? LG.team(q.get(`${x}t`)) : null;
    st.rid = t ? t.rid : null;
    st.name = t ? t.name : q.get(`${x}n`) || "";
    const hz = Number(q.get(`${x}h`));
    st.hz = q.has(`${x}h`) && Number.isFinite(hz) ? clamp(Math.round(hz), 0, 100) : LG ? defaultHz(t) : 50;
    const s = (q.get(`${x}s`) || "").split(",").map(Number);
    SLIDER_INFO.forEach(({ k }, i) => { st.s[k] = Number.isFinite(s[i]) ? clamp(Math.round(s[i]), -2, 2) : 0; });
  });
  if (LG && (state.a.rid == null || state.b.rid == null)) {
    const a = state.a.rid != null ? LG.team(state.a.rid) : LG.teams[0];
    setTeam("a", a.rid);
    setTeam("b", (state.b.rid != null && state.b.rid !== a.rid ? LG.team(state.b.rid) : LG.teams.find((t) => t.rid !== a.rid)).rid);
  }
  /* A linked list only keeps what the other team still owns. */
  SIDES.forEach((x) => {
    state[x].gets = (q.get(x) || "").split(",").filter((k) => k && MODEL.asset(modelKey(k)) && (!LG || LG.owns(state[other(x)].rid, k)));
  });
  showLink();
}

/* A different trade link pasted into an open page: start again from it. */
window.addEventListener("hashchange", () => location.reload());

load().catch(loadFailed);
