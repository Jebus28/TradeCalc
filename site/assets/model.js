"use strict";
/* The browser half of the model: layers 3 and 4 in the feasibility study.
   The horizon blend, the manager sliders, the star value rule (D6) and the
   verdict (D7). Every number comes from the config passed in, which is
   model.config.json as built; the model lab passes edited copies.

   Asset keys: a Sleeper player ID ("4866", or "DEN" for a defence); a pick
   by tier, "2027-1-early" / "-mid" / "-late" / "-any"; or an exact slot,
   "2027-1.05"; or FAAB dollars, "faab:100". */

const ANCHORS = ["win_now", "balanced", "long_term"];
const STARTER_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "WRRB_FLEX", "REC_FLEX", "SUPER_FLEX"];
const SKILL_POS = ["QB", "RB", "WR", "TE"];
const SLIDERS = ["rookie", "pick", "star", "risk", "market", "qb", "te"];
const NEUTRAL = Object.freeze(Object.fromEntries(SLIDERS.map((k) => [k, 0])));
const BAND_WIN = { fair: "Fair", slight: "Slight edge", clear: "Clear win", fleece: "Fleece" };
const BAND_LOSS = { fair: "Fair", slight: "Slight loss", clear: "Clear loss", fleece: "Fleeced" };
const ORD = (n) => n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th");
const TIER_NAME = { early: "Early", mid: "Mid", late: "Late" };

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* Straight lines between the anchors: 0 = Win Now, 50 = Balanced, 100 = Long-Term. */
function along(arr, hz) {
  if (hz <= 50) return arr[0] + (arr[1] - arr[0]) * (hz / 50);
  return arr[1] + (arr[2] - arr[1]) * ((hz - 50) / 50);
}

function makeModel(data, cfg) {
  const { meta, picks: pk } = data;
  const hzc = ANCHORS.map((h) => cfg.horizons[h]);
  const { market: mkt, picks: pc, sliders: sl, star, verdict: vd } = cfg;
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const teams = pk.teams;

  const blend = (a, b) => (a != null && b != null
    ? (mkt.fantasycalc_weight * a + mkt.dynastyprocess_weight * b) / (mkt.fantasycalc_weight + mkt.dynastyprocess_weight)
    : a ?? b ?? 0);

  /* The league QB premium is for young QBs: full up to full_until, fading
     to nothing at none_from. Without the setting it applies at every age. */
  function qbPremiumShare(age) {
    const qa = cfg.qb_premium_ages;
    if (!qa || age == null) return 1;
    if (age <= qa.full_until) return 1;
    if (age >= qa.none_from) return 0;
    return (qa.none_from - age) / (qa.none_from - qa.full_until);
  }

  /* Each anchor value is kept as a market part and a points part, so the
     market trust slider can move weight between them. wm is the market's
     share of the mix; null means the slider doesn't apply. */
  function playerParts(p) {
    if (p.pos === "K" || p.pos === "DEF") return { mk: [0, 0, 0], pts: [p.kd, p.kd, p.kd], wm: null };
    const dyn = blend(p.fc, p.dp);
    const prem = p.pos === "QB" ? 1 + (cfg.qb_premium - 1) * qbPremiumShare(p.age) : 1;
    return {
      mk: hzc.map((w, i) => w.market * (i === 0 ? p.red || 0 : dyn) * prem),
      pts: hzc.map((w) => (w.points_this_season * p.p_now + w.points_years_1_3 * p.p_13 + w.points_years_4_plus * p.p_4) * prem),
      wm: hzc.map((w) => w.market),
    };
  }

  const slotValue = new Map(pk.slots.map((s) => [s.overall, blend(s.fc, s.dp)]));
  function pickParts(year, overalls) {
    const k = Math.max(0, year - pk.first_year);
    const base = mean(overalls.map((n) => slotValue.get(n) ?? 0));
    const bal = base * (1 - pc.future_year_discount) ** k * (1 + pc.class_rating_step * (pc.class_ratings[year] || 0));
    const lt = mean(overalls) <= pc.long_term_boost_through_overall ? bal * (1 + pc.long_term_boost) : bal;
    return { mk: [bal * hzc[0].market, bal, lt], pts: [0, 0, 0], wm: null, k };
  }

  const cache = new Map();
  function asset(key) {
    if (cache.has(key)) return cache.get(key);
    let a = null, m;
    const p = byId.get(key);
    if (p) {
      a = { key, kind: "player", p, name: p.name, ...playerParts(p) };
    } else if ((m = /^(\d{4})-(\d)-(early|mid|late|any)$/.exec(key || "")) && +m[2] <= pk.rounds) {
      const year = +m[1], round = +m[2], tier = m[3];
      const slots = tier === "any" ? Array.from({ length: teams }, (_, i) => i + 1) : pk.tiers[tier];
      const overall = slots.map((s) => (round - 1) * teams + s);
      const name = tier === "any" ? `${year} ${ORD(round)}` : `${year} ${TIER_NAME[tier]} ${ORD(round)}`;
      a = { key, kind: "pick", year, round, tier, overall, name, ...pickParts(year, overall) };
    } else if ((m = /^(\d{4})-(\d)\.(\d{1,2})$/.exec(key || "")) && +m[2] <= pk.rounds && +m[3] >= 1 && +m[3] <= teams) {
      const year = +m[1], round = +m[2], slot = +m[3];
      const overall = [(round - 1) * teams + slot];
      a = { key, kind: "pick", year, round, slot, overall, name: `${year} ${round}.${String(slot).padStart(2, "0")}`, ...pickParts(year, overall) };
    } else if ((m = /^faab:(\d+)$/.exec(key || "")) && +m[1] > 0) {
      /* D13: the whole starting budget is worth one pick of the configured
         round and tier in the next draft; less in proportion. */
      const fc = cfg.faab || {}, budget = meta.waiver_budget || 0;
      const pick = `${pk.first_year}-${Math.min(fc.pick_round || pk.rounds, pk.rounds)}-${fc.pick_tier || "mid"}`;
      a = { key, kind: "faab", amount: +m[1], name: `$${m[1]} FAAB`, pick, share: budget ? Math.min(1, +m[1] / budget) : 0 };
    }
    cache.set(key, a);
    return a;
  }

  function risky(p) {
    const cliff = data.age_curves[p.pos]?.cliff_age;
    return Boolean(p.inj) || (cliff != null && p.age != null && p.age >= cliff - sl.risk_years_before_cliff);
  }

  /* An asset's value at a horizon, through one manager's sliders. */
  function value(a, hz, s = NEUTRAL) {
    if (!a) return 0;
    if (a.kind === "faab") return a.share * value(asset(a.pick), hz);
    let mk = along(a.mk, hz), pts = along(a.pts, hz);
    if (s.market && a.wm) {
      const wm = along(a.wm, hz);
      const wm2 = clamp(wm * (1 + sl.market_trust_step * s.market), 0, 1);
      if (wm > 0) mk *= wm2 / wm;
      if (wm < 1) pts *= (1 - wm2) / (1 - wm);
    }
    let v = mk + pts;
    if (a.kind === "player") {
      const p = a.p;
      if (p.rk) v *= 1 + sl.rookie_step * s.rookie;
      if (p.pos === "QB") v *= 1 + sl.qb_step * s.qb;
      if (p.pos === "TE") v *= 1 + sl.te_step * s.te;
      if (risky(p)) v *= 1 + sl.risk_step * s.risk;
    } else {
      v *= 1 + sl.pick_step * (1 + sl.pick_step_extra_per_year * a.k) * s.pick;
      if (a.k === 0 && a.round <= sl.rookie_pick_rounds) v *= 1 + sl.rookie_step * s.rookie;
    }
    return Math.max(0, v);
  }

  /* The quality line: the value of the last starter if every team filled its
     starting lineup, at this horizon, before anyone's sliders. */
  const starters = Math.max(1, Math.round((meta.starting_slots || []).filter((x) => STARTER_SLOTS.includes(x)).length
    * meta.format.teams * star.quality_line_share_of_starters));
  const lines = new Map();
  function qualityLine(hz) {
    const h = Math.round(hz);
    if (!lines.has(h)) {
      const vals = data.players.filter((p) => SKILL_POS.includes(p.pos)).map((p) => value(asset(p.id), h)).sort((x, y) => y - x);
      lines.set(h, Math.max(1, vals[Math.min(starters, vals.length) - 1] || 1));
    }
    return lines.get(h);
  }

  /* D6: pieces below the quality line count for less, the weaker the less.
     With extra_pieces_only, only the side sending more pieces is touched,
     and only its weakest pieces beyond the other side's count. */
  function counted(getVals, giveVals, hz, starSlider) {
    const strength = Math.max(0, star.strength + star.slider_step * starSlider);
    const line = qualityLine(hz);
    const shrink = (v) => (v >= line ? v : v * (v / line) ** strength);
    const weakest = (vals, n) => new Set(vals.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]).slice(0, n).map((x) => x[1]));
    let g, v;
    if (star.extra_pieces_only) {
      const d = getVals.length - giveVals.length;
      g = weakest(getVals, Math.max(0, d));
      v = weakest(giveVals, Math.max(0, -d));
    } else {
      g = new Set(getVals.keys());
      v = new Set(giveVals.keys());
    }
    return {
      get: getVals.map((x, i) => (g.has(i) ? shrink(x) : x)),
      give: giveVals.map((x, i) => (v.has(i) ? shrink(x) : x)),
      line,
    };
  }

  function verdict(gap) {
    const x = Math.abs(gap);
    const band = x < vd.fair_below ? "fair" : x < vd.slight_below ? "slight" : x < vd.clear_below ? "clear" : "fleece";
    const grade = (vd.grades.find(([t]) => gap >= t) || [0, "F"])[1];
    return { gap, band, grade, label: gap >= 0 ? BAND_WIN[band] : BAND_LOSS[band] };
  }

  /* D14: the starting-lineup change counts a little at Win Now, fading to
     nothing at Balanced. fit is the change priced in full (points a week x
     the league's value of a point a week); a gain adds to what the side
     gets, a loss to what it gives. */
  const lineupWeight = cfg.team_context?.lineup_weight_win_now || 0;
  const fitAt = (fit, hz) => (fit || 0) * along([lineupWeight, 0, 0], hz);

  /* One manager's view: what they get against what they give, at their
     horizon, through their sliders. */
  function sideView(gets, gives, hz, s = NEUTRAL, fit = 0) {
    const ga = gets.map(asset), va = gives.map(asset);
    const gVals = ga.map((a) => value(a, hz, s)), vVals = va.map((a) => value(a, hz, s));
    const c = counted(gVals, vVals, hz, s.star);
    const f = fitAt(fit, hz);
    const get = sum(c.get) + Math.max(0, f), give = sum(c.give) + Math.max(0, -f);
    const gap = Math.max(get, give) > 0 ? (get - give) / Math.max(get, give) : 0;
    const items = (keys, assets, vals, cnt) => keys.map((key, i) => ({ key, asset: assets[i], value: vals[i], counted: cnt[i] }));
    return { get, give, fit: f, line: c.line, gets: items(gets, ga, gVals, c.get), gives: items(gives, va, vVals, c.give), ...verdict(gap) };
  }

  /* t = {a: {gets, hz, s, fit}, b: {gets, hz, s, fit}}; each side gets its
     own list. fit is optional (only a linked league has lineups). */
  function judge(t) {
    return {
      a: sideView(t.a.gets, t.b.gets, t.a.hz, t.a.s, t.a.fit),
      b: sideView(t.b.gets, t.a.gets, t.b.hz, t.b.s, t.b.fit),
      strip: [0, 50, 100].map((hz) => ({ hz, ...sideView(t.a.gets, t.b.gets, hz, NEUTRAL, t.a.fit) })),
    };
  }

  /* "Fair" or "Clear win: Lee", from side A's neutral view. */
  function winnerLabel(v, nameA, nameB) {
    return v.band === "fair" ? "Fair" : `${BAND_WIN[v.band]}: ${v.gap > 0 ? nameA : nameB}`;
  }

  /* Pick values by tier for every year the site shows. */
  function pickRows() {
    const rows = [];
    for (const year of pk.years)
      for (let round = 1; round <= pk.rounds; round++)
        for (const tier of ["early", "mid", "late", "any"]) rows.push(asset(`${year}-${round}-${tier}`));
    return rows;
  }

  return { asset, value, judge, sideView, verdict, winnerLabel, qualityLine, pickRows, risky, starters };
}
