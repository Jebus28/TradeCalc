"use strict";
/* The Sleeper link (Phase 3): a live league's rosters, who owns which pick,
   each team's record, best starting lineup and roster space. The browser asks
   Sleeper directly; values still come from the build. Every number comes
   from model.config.json (team_context). Needs model.js.

   A linked pick's key names its original team: "2027-1-r3" is roster 3's
   2027 1st. resolve() turns it into a key model.js values: a tier
   ("2027-1-late") before the draft order is set, an exact slot ("2027-1.08")
   after. */

const SLEEPER_API = "https://api.sleeper.app/v1";
const FIXED_SLOTS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FLEX_FILL = [["WRRB_FLEX", ["WR", "RB"]], ["REC_FLEX", ["WR", "TE"]], ["FLEX", ["RB", "WR", "TE"]], ["SUPER_FLEX", ["QB", "RB", "WR", "TE"]]];
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const PICK_KEY = /^(\d{4})-(\d)-r(\d+)$/;

async function sleeper(path) {
  const r = await fetch(SLEEPER_API + path);
  if (!r.ok) throw new Error(`Sleeper didn't answer (error ${r.status}).`);
  return r.json();
}

/* A username's leagues this season. */
async function sleeperLeagues(username, season) {
  const user = await sleeper(`/user/${encodeURIComponent(username.trim())}`);
  if (!user?.user_id) throw new Error(`Sleeper has no user called “${username.trim()}”.`);
  const leagues = (await sleeper(`/user/${user.user_id}/leagues/nfl/${season}`)) || [];
  return { user, leagues };
}

/* Everything the analyser needs about one league, in five calls. */
async function sleeperLeague(id) {
  const [league, users, rosters, traded, drafts] = await Promise.all(
    ["", "/users", "/rosters", "/traded_picks", "/drafts"].map((p) => sleeper(`/league/${id}${p}`)));
  if (!league) throw new Error("Sleeper has no league with that ID.");
  return { league, users: users || [], rosters: rosters || [], traded: traded || [], drafts: drafts || [] };
}

function makeLeague(live, data) {
  const cfg = data.config, tc = cfg.team_context, meta = data.meta, pk = data.picks;
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const names = meta.manager_names || {};
  const users = new Map(live.users.map((u) => [u.user_id, u]));
  const settings = live.league.settings || {};
  const slots = live.league.roster_positions || meta.starting_slots || [];
  const limit = slots.length; // starters and bench; IR and taxi spots are extra
  const weeksLeft = meta.season_type === "regular" ? Math.max(0, cfg.points.last_regular_week - meta.week + 1) : 0;

  /* Projected points a week for the rest of the regular season. Sleeper
     projects injured weeks and byes as zero, so they're already allowed for. */
  const perWeek = (id) => (weeksLeft ? (byId.get(id)?.ros || 0) / weeksLeft : 0);

  /* The best starting lineup from a set of players: fixed slots first, then
     the flex slots from the narrowest to Superflex. */
  function lineup(ids) {
    const pool = ids.map((id) => byId.get(id)).filter(Boolean)
      .map((p) => ({ id: p.id, pos: p.pos, pts: perWeek(p.id) })).sort((x, y) => y.pts - x.pts);
    const used = new Set();
    const fill = (ok) => { const p = pool.find((q) => !used.has(q.id) && ok.includes(q.pos)); if (p) used.add(p.id); return p ? p.pts : 0; };
    let total = 0;
    for (const s of slots) if (FIXED_SLOTS.includes(s)) total += fill([s]);
    for (const [flex, ok] of FLEX_FILL) for (const s of slots) if (s === flex) total += fill(ok);
    return { total, starters: used };
  }

  const teams = live.rosters.map((r) => {
    const u = users.get(r.owner_id);
    const name = names[r.owner_id] || u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`;
    const st = r.settings || {};
    const players = r.players || [];
    const reserve = new Set(r.reserve || []), taxi = new Set(r.taxi || []);
    return {
      rid: r.roster_id, ownerIds: [r.owner_id, ...(r.co_owners || [])], name,
      situation: meta.situations?.[name] || null,
      wins: st.wins || 0, losses: st.losses || 0, ties: st.ties || 0,
      fpts: (st.fpts || 0) + (st.fpts_decimal || 0) / 100,
      faab: settings.waiver_budget ? settings.waiver_budget - (st.waiver_budget_used || 0) : null,
      players, reserve, taxi,
      active: players.filter((id) => !reserve.has(id) && !taxi.has(id)).length,
      strength: lineup(players).total,
    };
  });
  const byRid = new Map(teams.map((t) => [t.rid, t]));
  const n = teams.length;

  /* D8: the next draft's order from roster strength and record. */
  const winPct = (t) => { const g = t.wins + t.losses + t.ties; return g ? (t.wins + t.ties / 2) / g : 0.5; };
  [...teams].sort((x, y) => y.strength - x.strength).forEach((t, i) => { t.strengthRank = i + 1; });
  [...teams].sort((x, y) => winPct(y) - winPct(x) || y.fpts - x.fpts).forEach((t, i) => { t.recordRank = i + 1; });
  const played = Math.max(0, ...teams.map((t) => t.wins + t.losses + t.ties));
  const regular = Math.max(1, (settings.playoff_week_start || cfg.points.last_regular_week + 1) - 1);
  const recordShare = tc.record_share_at_season_end * Math.min(1, played / regular);
  const blendRank = (t) => (1 - recordShare) * t.strengthRank + recordShare * t.recordRank;
  [...teams].sort((x, y) => blendRank(x) - blendRank(y) || x.strengthRank - y.strengthRank)
    .forEach((t, i) => { t.projSlot = n - i; });

  /* Once Sleeper has a draft order for a coming draft, picks use it. */
  const exact = {};
  for (const d of live.drafts) {
    if (d.status === "complete") continue;
    const y = +d.season, order = (exact[y] = {});
    if (d.slot_to_roster_id) for (const [slot, rid] of Object.entries(d.slot_to_roster_id)) { if (rid != null) order[rid] = +slot; }
    else if (d.draft_order) for (const [uid, slot] of Object.entries(d.draft_order)) {
      const t = teams.find((x) => x.ownerIds.includes(uid));
      if (t) order[t.rid] = +slot;
    }
  }

  /* Who owns which pick: everyone owns their own, then the trades. */
  const owner = new Map();
  for (const y of pk.years) for (let rd = 1; rd <= pk.rounds; rd++) for (const t of teams) owner.set(`${y}-${rd}-r${t.rid}`, t.rid);
  for (const tp of live.traded) {
    const k = `${tp.season}-${tp.round}-r${tp.roster_id}`;
    if (owner.has(k)) owner.set(k, tp.owner_id);
  }

  const tierOfSlot = (slot) => Object.keys(pk.tiers).find((k) => pk.tiers[k].includes(slot)) || "any";
  function pickInfo(key) {
    const m = PICK_KEY.exec(key || "");
    if (!m) return null;
    const year = +m[1], round = +m[2], from = byRid.get(+m[3]);
    if (!from) return null;
    const slot = exact[year]?.[from.rid];
    let tier, model, how;
    if (slot) {
      model = `${year}-${round}.${String(slot).padStart(2, "0")}`;
      how = `Slot ${round}.${String(slot).padStart(2, "0")}`;
    } else if (year === pk.first_year) {
      tier = tierOfSlot(from.projSlot);
      model = `${year}-${round}-${tier}`;
      how = `Projected ${tier}: on current form ${from.name} would pick ${ORD(from.projSlot)}`;
    } else {
      tier = tc.later_years[from.situation || "unknown"] || "any";
      model = `${year}-${round}-${tier}`;
      how = tier === "any" ? "Slot unknown" : `Expected ${tier}: ${from.name} ${from.situation ? `is ${from.situation}` : "has no situation set"}`;
    }
    return { year, round, from, tier, slot, model, how };
  }

  teams.forEach((t) => {
    t.picks = [...owner].filter(([, o]) => o === t.rid).map(([k]) => k)
      .sort((x, y) => { const a = pickInfo(x), b = pickInfo(y); return a.year - b.year || a.round - b.round || (a.slot || a.from.projSlot) - (b.slot || b.from.projSlot); });
  });

  /* A team's lineup and roster space before and after a trade. */
  function change(rid, givesKeys, getsKeys) {
    const t = byRid.get(rid);
    const outIds = new Set(givesKeys.filter((k) => !PICK_KEY.test(k)));
    const inIds = getsKeys.filter((k) => !PICK_KEY.test(k));
    const before = lineup(t.players), after = lineup([...t.players.filter((id) => !outIds.has(id)), ...inIds]);
    const freed = [...outIds].filter((id) => !t.reserve.has(id) && !t.taxi.has(id)).length;
    return {
      before: before.total, after: after.total,
      in: [...after.starters].filter((id) => !before.starters.has(id)),
      out: [...before.starters].filter((id) => !after.starters.has(id)),
      active: t.active, activeAfter: t.active - freed + inIds.length, limit,
    };
  }

  return {
    teams, limit, weeksLeft, recordShare,
    league: live.league,
    team: (rid) => byRid.get(+rid) || null,
    isPick: (key) => PICK_KEY.test(key),
    pickInfo,
    resolve: (key) => pickInfo(key)?.model ?? key,
    owns: (rid, key) => { const t = byRid.get(+rid); return Boolean(t) && (PICK_KEY.test(key) ? owner.get(key) === t.rid : t.players.includes(key)); },
    /* A team's tradeable assets: players by position then value, then picks. */
    assets: (rid, valueOf) => {
      const t = byRid.get(+rid);
      if (!t) return [];
      const pos = (id) => { const i = POS_ORDER.indexOf(byId.get(id)?.pos); return i < 0 ? 99 : i; };
      const players = [...t.players].sort((x, y) => pos(x) - pos(y) || valueOf(y) - valueOf(x));
      return [...players, ...t.picks];
    },
    perWeek, change,
  };
}
