"use strict";
/* Model lab: replays the test-set trades (testset.json) through the model
   with weights edited on the page, and scores the verdicts against Matt's.
   Edits stay in this page; "Copy changes" lists them for model.config.json.
   Needs model.js and shared.js. */

const HZ = { win_now: 0, balanced: 50, long_term: 100 };
const INGREDIENTS = [
  ["points_this_season", "This season"],
  ["points_years_1_3", "Next 1–3"],
  ["points_years_4_plus", "4+ out"],
  ["market", "Market"],
];
const ANCHOR_NAMES = { win_now: "Win Now", balanced: "Balanced", long_term: "Long-Term" };

let DATA = null, BASE = null, CFG = null, MODEL = null, TRADES = [], FIELDS = [];
const ui = { hz: 50, used: "player" };

const getAt = (obj, path) => path.reduce((o, k) => o?.[k], obj);
const setAt = (obj, path, v) => { path.slice(0, -1).reduce((o, k) => o[k], obj)[path[path.length - 1]] = v; };
const same = (x, y) => (typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 1e-9 : x === y);

async function load() {
  DATA = await loadLeague();
  BASE = structuredClone(DATA.config);
  CFG = structuredClone(BASE);
  TRADES = (await fetch(`data/testset-${DATA.meta.slug}.json`, { cache: "no-cache" }).then((r) => r.json())).trades;
  buildFields();
  $("#compare").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hz]"); if (!b) return;
    ui.hz = +b.dataset.hz;
    $$("#compare [role=radio]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    run();
  });
  $("#used").addEventListener("change", (e) => { ui.used = e.target.value; run(); });
  $("#reset").addEventListener("click", () => { CFG = structuredClone(BASE); fillFields(); run(); });
  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(changesText()); $("#changes").textContent = "Changes copied. Paste them to Claude to put them in model.config.json."; }
    catch { $("#changes").textContent = changesText(); }
  });
  run();
}

/* ------------------------------------------------------------ settings */

function buildFields() {
  const years = Object.keys(BASE.picks.class_ratings);
  const groups = [
    { title: "Market and QBs", note: BASE._market, items: [
      { path: ["market", "fantasycalc_weight"], label: "FantasyCalc share of the market (DynastyProcess gets the rest)", step: 0.05, min: 0, max: 1 },
      ...(BASE.market.win_now_dynasty_share != null ? [
        { path: ["market", "win_now_dynasty_share"], label: "Win Now market: dynasty share (redraft gets the rest)", step: 0.05, min: 0, max: 1 },
      ] : []),
      { path: ["qb_premium"], label: "League QB premium (×)", step: 0.05, min: 0.5, max: 2, file: `leagues → ${DATA.meta.slug} → qb_premium` },
      ...(BASE.qb_premium_ages ? [
        { path: ["qb_premium_ages", "full_until"], label: "QB premium in full up to age", step: 1, min: 20, max: 40 },
        { path: ["qb_premium_ages", "none_from"], label: "QB premium gone by age", step: 1, min: 20, max: 45 },
      ] : []),
    ] },
    { title: "Picks", note: BASE._picks, items: [
      { path: ["picks", "future_year_discount"], label: "Discount for each year further out", step: 0.05, min: 0, max: 0.5 },
      ...years.map((y) => ({ path: ["picks", "class_ratings", y], label: `${y} class rating (−2 to +2)`, step: 1, min: -2, max: 2 })),
      { path: ["picks", "class_rating_step"], label: "Each class rating step", step: 0.05, min: 0, max: 0.5 },
      { path: ["picks", "long_term_boost"], label: "Long-Term boost for early picks", step: 0.05, min: 0, max: 1 },
      { path: ["picks", "long_term_boost_through_overall"], label: "Boost goes up to overall pick", step: 1, min: 0, max: 50 },
      ...["early", "late"].filter((t) => BASE.picks.ladder?.["1"]?.[t] != null).map((t) => (
        { path: ["picks", "ladder", "1", t], label: `Ladder: ${t} 1st, as a share of a mid 1st`, step: 0.05, min: 0, max: 3 })),
      ...(BASE.picks.stack_strength != null ? [
        { path: ["picks", "stack_strength"], label: "Extra picks on one side: discount strength (0 = off)", step: 0.5, min: 0, max: 6 },
      ] : []),
    ] },
    ...(BASE.veteran ? [{ title: "Older veterans", note: BASE._veteran, items: [
      { path: ["veteran", "min_age"], label: `From age (${BASE.veteran.positions.join(", ")})`, step: 1, min: 25, max: 40 },
      { path: ["veteran", "factor"], label: "Market and future points × (1 = off)", step: 0.05, min: 0.3, max: 1 },
    ] }] : []),
    { title: "Star value", note: BASE._star, items: [
      { path: ["star", "strength"], label: "Strength (0 = off)", step: 0.25, min: 0, max: 5 },
      { path: ["star", "quality_line_share_of_starters"], label: "Quality line, as a share of the league's starters", step: 0.1, min: 0.2, max: 3 },
      { path: ["star", "extra_pieces_only"], label: "Only the extra pieces on the bigger side", type: "checkbox" },
    ] },
    { title: "Manager situations", note: BASE._situation_horizons, items: [
      { path: ["situation_horizons", "contending"], label: "Contending: horizon (0 Win Now – 100 Long-Term)", step: 5, min: 0, max: 100 },
      { path: ["situation_horizons", "building"], label: "Building: horizon", step: 5, min: 0, max: 100 },
      { path: ["situation_horizons", "rebuilding"], label: "Rebuilding: horizon", step: 5, min: 0, max: 100 },
    ] },
    { title: "Verdict bands", note: BASE._verdict, items: [
      { path: ["verdict", "fair_below"], label: "Fair under", step: 0.01, min: 0, max: 1 },
      { path: ["verdict", "slight_below"], label: "Slight edge under", step: 0.01, min: 0, max: 1 },
      { path: ["verdict", "clear_below"], label: "Clear win under (Fleece above)", step: 0.01, min: 0, max: 1 },
    ] },
  ];
  FIELDS = [];
  const mix = `<fieldset><legend>Horizon mix</legend>
    <div class="tablewrap"><table class="mix"><thead><tr><th></th>${INGREDIENTS.map(([, l]) => `<th class="r">${l}</th>`).join("")}<th class="r">Total</th></tr></thead><tbody>
    ${Object.keys(HZ).map((h) => `<tr><th scope="row">${ANCHOR_NAMES[h]}</th>${INGREDIENTS.map(([k, l]) => {
      FIELDS.push({ path: ["horizons", h, k], label: `${ANCHOR_NAMES[h]}: ${l.toLowerCase()}`, step: 0.05, min: 0, max: 1 });
      return `<td><input type="number" data-f="${FIELDS.length - 1}" step="0.05" min="0" max="1" aria-label="${ANCHOR_NAMES[h]}, ${l}"></td>`;
    }).join("")}<td class="r num" data-sum="${h}"></td></tr>`).join("")}
    </tbody></table></div>
    <details><summary>What this does</summary><p class="note">${esc(BASE._horizons)}</p></details></fieldset>`;
  const rest = groups.map((g) => `<fieldset><legend>${g.title}</legend>${g.items.map((f) => {
    FIELDS.push(f);
    const i = FIELDS.length - 1;
    return f.type === "checkbox"
      ? `<label class="check"><input type="checkbox" data-f="${i}"> ${esc(f.label)}</label>`
      : `<label class="field"><span>${esc(f.label)}</span><input type="number" data-f="${i}" step="${f.step}" min="${f.min}" max="${f.max}"></label>`;
  }).join("")}<details><summary>What this does</summary><p class="note">${esc(g.note)}</p></details></fieldset>`).join("");
  $("#fields").innerHTML = mix + rest;
  $("#fields").addEventListener("input", (e) => {
    const f = FIELDS[e.target.dataset.f]; if (!f) return;
    if (f.type === "checkbox") setAt(CFG, f.path, e.target.checked);
    else {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      setAt(CFG, f.path, v);
      if (f.path[0] === "market") CFG.market.dynastyprocess_weight = Math.max(0, 1 - v);
    }
    run();
  });
  fillFields();
}

function fillFields() {
  FIELDS.forEach((f, i) => {
    const el = $(`[data-f="${i}"]`);
    if (f.type === "checkbox") el.checked = getAt(CFG, f.path);
    else el.value = getAt(CFG, f.path);
  });
}

function changed() { return FIELDS.filter((f) => !same(getAt(CFG, f.path), getAt(BASE, f.path))); }

function changesText() {
  const lines = changed().map((f) => `${f.file || f.path.join(" → ")}: ${getAt(BASE, f.path)} → ${getAt(CFG, f.path)}`);
  if (lines.some((l) => l.startsWith("market → fantasycalc_weight"))) lines.push(`market → dynastyprocess_weight: ${BASE.market.dynastyprocess_weight} → ${CFG.market.dynastyprocess_weight}`);
  return `Model lab changes to model.config.json\n${lines.join("\n")}\nTest set: ${$("#score").textContent.replace(/\s+/g, " ").trim()}`;
}

/* ------------------------------------------------------------ test set */

/* testset.json asset -> model key. A pick already used is the player chosen,
   or the same slot in the next draft, as the page option says. */
function keyFor(x) {
  if (x.player) return x.player;
  const m = /^(\d{4}) (?:(\d)\.(\d{1,2})|(\d)(?:st|nd|rd|th))$/.exec(x.pick || "");
  if (!m) return null;
  const year = +m[1];
  if (m[2]) {
    if (x.became && ui.used === "player") return x.became;
    return `${Math.max(year, DATA.picks.first_year)}-${m[2]}.${m[3].padStart(2, "0")}`;
  }
  return `${year}-${m[4]}-${x.tier || "any"}`;
}

function assetText(x) {
  if (x.player) return x.name;
  if (x.became) return ui.used === "player" ? `${x.name} (${x.pick})` : `${x.pick} (as a ${DATA.picks.first_year} pick)`;
  return `${x.from ? `${x.from}'s ` : ""}${x.pick}${x.tier ? ` (${x.tier})` : ""}`;
}

const winnerOf = (label) => (label === "Fair" ? null : label.split(": ")[1]);
const bandOf = (label) => (label === "Fair" ? 0 : label.startsWith("Slight") ? 1 : label.startsWith("Clear") ? 2 : 3);

/* agree: the model's verdict is one Matt accepts. close: the right winner
   at a different size, or Fair against a slight edge. miss: anything else. */
function grade(label, accepted) {
  if (accepted.includes(label)) return "agree";
  const w = winnerOf(label);
  return accepted.some((a) => (w && winnerOf(a) === w) || bandOf(a) + bandOf(label) === 1) ? "close" : "miss";
}
const STATUS = { agree: "Agrees", close: "Close", miss: "Miss" };

/* A side's horizon: a current trade uses the manager's situation from
   model.config.json; a past trade uses its situation at the time. */
function sideHz(t, side) {
  const s = DATA.meta.situations?.[side.manager];
  if (t.kind !== "past" && s && CFG.situation_horizons?.[s] != null) return CFG.situation_horizons[s];
  return HZ[side.horizon] ?? 50;
}

/* One table row; status is null while a current trade awaits Matt's verdict,
   and then the model's answer stays hidden so it can't anchor him. */
function tradeRow(t) {
  const A = t.a.manager, B = t.b.manager;
  const ka = t.a.gets.map(keyFor), kb = t.b.gets.map(keyFor);
  const missing = [...ka, ...kb].filter((k) => !MODEL.asset(k)).length;
  const head = `<td><details><summary><b>${esc(t.id)}</b> <span class="muted">${esc(t.date)}</span></summary>
      <p class="note">${t.situation ? `<b>Situation:</b> ${esc(t.situation)}.<br>` : ""}${[t.a, t.b].filter((s) => s.motive).map((s) => `<b>${esc(s.manager)}:</b> ${esc(s.motive)}<br>`).join("")}${t.matt_then ? `<b>Matt at the time:</b> ${esc(t.matt_then)}.<br>` : ""}${t.notes ? `<b>Notes:</b> ${esc(t.notes)}` : ""}</p></details>
      <div class="gets"><b>${esc(A)}</b> gets ${t.a.gets.map((x) => esc(assetText(x))).join(", ")}</div>
      <div class="gets"><b>${esc(B)}</b> gets ${t.b.gets.map((x) => esc(assetText(x))).join(", ")}</div>
      ${t.unlikely ? `<div class="note"><span class="tag" title="${esc(t.unlikely)}">Wouldn't happen</span> ${esc(t.unlikely)}</div>` : ""}
      ${missing ? `<div class="note warntext">${missing} asset${missing > 1 ? "s" : ""} not found in this build.</div>` : ""}</td>`;
  if (!t.matt_now?.length) {
    return { status: null, html: `<tr class="lab-pending">${head}<td class="muted">Awaiting Matt's verdict</td>
      <td colspan="6" class="muted">Hidden until Matt has judged it.</td></tr>` };
  }
  const short = (v) => (v.band === "fair" ? `Fair ${pct(v.gap)}` : `${v.gap > 0 ? A : B} ${pct(v.gap)}`);
  const at = (hz) => MODEL.sideView(ka, kb, hz);
  const cmp = at(ui.hz);
  const label = MODEL.winnerLabel(cmp, A, B);
  const st = grade(label, t.matt_now);
  const ha = sideHz(t, t.a), hb = sideHz(t, t.b);
  const va = MODEL.sideView(ka, kb, ha), vb = MODEL.sideView(kb, ka, hb);
  const own = (name, h, v) => `<div><b>${esc(name)}</b> <span class="muted">(${horizonName(h)})</span>: ${v.label} ${signedPct(v.gap)}</div>`;
  const q = new URLSearchParams({ an: A, a: ka.join(","), ah: ha, bn: B, b: kb.join(","), bh: hb });
  return { status: st, html: `<tr class="lab-${st}">${head}
    <td>${esc(t.matt_now_text)}<div class="note">Counts as agreeing: ${t.matt_now.map(esc).join(" or ")}</div></td>
    <td><span class="chip ${st}">${STATUS[st]}</span><div><b>${esc(label)}</b> <span class="muted num">${pct(cmp.gap)}</span></div></td>
    ${[0, 50, 100].map((hz) => `<td class="r num hide-sm${hz === ui.hz ? " cur" : ""}">${esc(short(at(hz)))}</td>`).join("")}
    <td class="hide-sm small">${own(A, ha, va)}${own(B, hb, vb)}</td>
    <td><a class="open" href="trade.html${location.search}#${q}" title="Open in the trade analyser">Open</a></td></tr>` };
}

function run() {
  MODEL = makeModel(DATA, CFG);
  const current = TRADES.filter((t) => t.kind !== "past").map(tradeRow);
  const past = TRADES.filter((t) => t.kind === "past").map(tradeRow);
  $("#lab-current tbody").innerHTML = current.map((r) => r.html).join("") || '<tr><td colspan="8" class="muted">No current trades yet.</td></tr>';
  $("#lab-past tbody").innerHTML = past.map((r) => r.html).join("");
  const judged = current.filter((r) => r.status);
  const counts = { agree: 0, close: 0, miss: 0 };
  judged.forEach((r) => counts[r.status]++);
  const waiting = current.length - judged.length;
  const wait = waiting ? ` · ${waiting} awaiting Matt's verdict` : "";
  $("#score").innerHTML = judged.length
    ? `<b class="big">${counts.agree} of ${judged.length}</b> current trades agree with Matt at ${horizonName(ui.hz)}
      <span class="note">· ${counts.close} close (right side, different size) · ${counts.miss} miss${counts.miss === 1 ? "" : "es"}${wait}</span>`
    : `<b class="big">No current trades judged yet</b><span class="note">${wait}</span>`;
  $("#lineinfo").textContent = `Quality line at ${horizonName(ui.hz)}: ${fmt(MODEL.qualityLine(ui.hz))}, the value of the ${ORD(MODEL.starters)}-best player.`;
  Object.keys(HZ).forEach((h) => {
    const total = INGREDIENTS.reduce((s, [k]) => s + CFG.horizons[h][k], 0);
    const cell = $(`[data-sum="${h}"]`);
    cell.textContent = total.toFixed(2);
    cell.classList.toggle("warntext", Math.abs(total - 1) > 0.001);
  });
  const ch = changed();
  FIELDS.forEach((f, i) => $(`[data-f="${i}"]`).classList.toggle("changed", ch.includes(f)));
  $("#reset").disabled = $("#copy").disabled = !ch.length;
  $("#changes").textContent = ch.length ? `${ch.length} setting${ch.length > 1 ? "s" : ""} changed from model.config.json (highlighted).` : "These are the values in model.config.json.";
}

load().catch(loadFailed);
