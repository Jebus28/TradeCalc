"use strict";
/* Trade analyser, general mode: build a trade by hand, set each manager's
   horizon and sliders, and see the verdict from both sides. The trade lives
   in the address (#a=...&b=...) so a link reopens it. Needs model.js and
   shared.js. */

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

let DATA = null, MODEL = null, INDEX = [];
const state = { a: blankSide(), b: blankSide() };

function blankSide() { return { name: "", gets: [], hz: 50, s: { ...NEUTRAL } }; }
const nameOf = (x) => state[x].name.trim() || PLACEHOLDER[x];
const sliderText = (v) => (v === 0 ? "Neutral" : v > 0 ? `+${v}` : `−${-v}`);

async function load() {
  DATA = await loadLeague();
  MODEL = makeModel(DATA, DATA.config);
  buildIndex();
  readHash();
  const owners = [...new Set(DATA.players.map((p) => p.owner).filter(Boolean))].sort();
  $("#managers").innerHTML = owners.map((o) => `<option value="${esc(o)}">`).join("");
  SIDES.forEach(setupSide);
  $("#swap").addEventListener("click", () => { [state.a, state.b] = [state.b, state.a]; SIDES.forEach(syncControls); render(); });
  $("#clear").addEventListener("click", () => { state.a = blankSide(); state.b = blankSide(); SIDES.forEach(syncControls); render(); });
  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); $("#copied").textContent = "Link copied."; }
    catch { $("#copied").textContent = "Copy the address bar to share this trade."; }
  });
  render();
}

/* ------------------------------------------------------------ search */

function buildIndex() {
  const players = DATA.players.map((p) => {
    const sub = [p.pos, p.team || "FA", p.age ? `${p.age}` : null, p.owner || "Free agent"].filter(Boolean).join(" · ");
    return { key: p.id, label: p.name, sub, rookie: p.rk, hay: `${p.name} ${p.team || ""} ${p.pos} ${p.owner || ""}`.toLowerCase(), v: MODEL.value(MODEL.asset(p.id), 50) };
  });
  const picks = MODEL.pickRows().map((a) => {
    const first = a.overall[0], last = a.overall[a.overall.length - 1];
    const sub = a.tier === "any" ? `Pick · slot unknown (${first}–${last} overall)` : `Pick · ${first}–${last} overall`;
    return { key: a.key, label: a.name, sub, hay: `${a.name} ${a.tier} pick round ${a.round}`.toLowerCase(), v: MODEL.value(a, 50), pick: true };
  });
  INDEX = [...players, ...picks];
}

function search(q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const used = new Set([...state.a.gets, ...state.b.gets]);
  const lead = tokens.join(" ");
  return INDEX.filter((e) => !used.has(e.key) && tokens.every((t) => e.hay.includes(t)))
    .sort((x, y) => (y.label.toLowerCase().startsWith(lead) - x.label.toLowerCase().startsWith(lead)) || y.v - x.v)
    .slice(0, 8);
}

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
    hits = search(box.value);
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
  syncControls(x);
}

/* Put the controls back in line with state (after swap, clear or a link). */
function syncControls(x) {
  const el = $(`#side-${x}`), st = state[x];
  $('[data-field="name"]', el).value = st.name;
  $('[data-field="hz"]', el).value = st.hz;
  SLIDER_INFO.forEach(({ k }) => { $(`[data-slider="${k}"]`, el).value = st.s[k]; });
  const changed = SLIDER_INFO.some(({ k, group }) => group === "more" && st.s[k]);
  if (changed) $("details", el).open = true;
}

/* ------------------------------------------------------------ render */

function render() {
  const t = { a: { gets: state.a.gets, hz: state.a.hz, s: state.a.s }, b: { gets: state.b.gets, hz: state.b.hz, s: state.b.s } };
  const j = MODEL.judge(t);
  SIDES.forEach((x) => renderSide(x, j[x]));
  renderVerdict(j);
  writeHash();
}

function renderSide(x, view) {
  const el = $(`#side-${x}`), st = state[x];
  $('[data-out="hz"]', el).textContent = horizonName(st.hz);
  SLIDER_INFO.forEach(({ k }) => { $(`[data-out="${k}"]`, el).textContent = sliderText(st.s[k]); });
  $(".assets", el).innerHTML = view.gets.map((it, i) => {
    const a = it.asset;
    let sub;
    if (!a) sub = "Not in this league's values";
    else if (a.kind === "player") sub = [a.p.pos, a.p.team || "FA", a.p.age, a.p.owner].filter(Boolean).join(" · ");
    else sub = `Pick · ${a.overall[0] === a.overall[a.overall.length - 1] ? `${a.overall[0]} overall` : `${a.overall[0]}–${a.overall[a.overall.length - 1]} overall`}`;
    const share = it.value > 0 ? it.counted / it.value : 1;
    const cut = share < 0.995 ? `<span class="note" title="Star value: an extra piece below the quality line">counts ${Math.round(share * 100)}%</span>` : "";
    const inj = a?.p?.inj ? `<span class="tag">${esc(a.p.inj)}</span>` : "";
    const rk = a?.p?.rk ? '<span class="tag rk" title="Rookie">R</span>' : "";
    return `<li><div class="who"><b>${esc(a ? a.name : it.key)}${rk}${inj}</b><span>${esc(sub)}</span></div>
      <div class="val"><span class="num">${fmt(it.value)}</span>${cut}</div>
      <button type="button" class="x" data-remove="${i}" aria-label="Remove ${esc(a ? a.name : it.key)}">×</button></li>`;
  }).join("") || '<li class="empty note">Nothing yet.</li>';
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
    <h3>Same trade at every horizon, neutral settings</h3>
    <div class="strip">${strip}</div>`;
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
  SIDES.forEach((x) => {
    const st = state[x];
    if (st.name.trim()) q.set(`${x}n`, st.name.trim());
    if (st.gets.length) q.set(x, st.gets.join(","));
    if (st.hz !== 50) q.set(`${x}h`, st.hz);
    if (SLIDER_INFO.some(({ k }) => st.s[k])) q.set(`${x}s`, SLIDER_INFO.map(({ k }) => st.s[k]).join(","));
  });
  history.replaceState(null, "", `${location.pathname}${location.search}${q.toString() ? "#" + q : ""}`);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  SIDES.forEach((x) => {
    const st = state[x];
    st.name = q.get(`${x}n`) || "";
    st.gets = (q.get(x) || "").split(",").filter((k) => k && MODEL.asset(k));
    const hz = Number(q.get(`${x}h`));
    st.hz = q.has(`${x}h`) && Number.isFinite(hz) ? clamp(Math.round(hz), 0, 100) : 50;
    const s = (q.get(`${x}s`) || "").split(",").map(Number);
    SLIDER_INFO.forEach(({ k }, i) => { st.s[k] = Number.isFinite(s[i]) ? clamp(Math.round(s[i]), -2, 2) : 0; });
  });
}

load().catch(loadFailed);
