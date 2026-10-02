"""Step 2: turn data/ into a value for every player and pick, per league.

Layer 1  points value  - projected points above a replacement starter, in the
                         league's own scoring, for this season, seasons 1-3
                         ahead and 4+ ahead (age-curved).
Layer 2  market value  - FantasyCalc and DynastyProcess, matched by rank.
The site does layers 3 and 4 in the browser (site/assets/model.js): the
horizon blend, manager sliders, the star value rule and verdicts. That way
the model lab can re-run them with other weights. The build also copies
testset.json for the lab.

Run:  python scripts/build_values.py
"""
import bisect
import datetime as dt
import math
import os
import re
import statistics

from common import (ALL_POS, CACHE, HISTORY, ROOT, SITE_DATA, SKILL, config,
                    league_format, load, save)

FLEX_SLOTS = {
    "WRRB_FLEX": ("WR", "RB"),
    "REC_FLEX": ("WR", "TE"),
    "FLEX": ("RB", "WR", "TE"),
    "SUPER_FLEX": ("QB", "RB", "WR", "TE"),
}
ROUND_WORDS = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6}


# ---------------------------------------------------------------- scoring

def score(stats, pos, scoring):
    """Fantasy points for a stat line in this league's scoring."""
    if not stats:
        return 0.0
    if pos in ("K", "DEF"):
        # Sleeper's projections lack the points-allowed buckets most leagues
        # score, so kickers and defences use Sleeper's own half-PPR total.
        return float(stats.get("pts_half_ppr") or 0)
    pts = 0.0
    for key, value in stats.items():
        weight = scoring.get(key)
        if weight and isinstance(value, (int, float)):
            pts += weight * value
    rec = stats.get("rec") or 0
    pts += rec * scoring.get(f"bonus_rec_{pos.lower()}", 0)
    return pts


# ---------------------------------------------------------------- ages

def parse_date(text):
    try:
        return dt.date.fromisoformat(text[:10])
    except (TypeError, ValueError):
        return None


def age_on(player, when):
    born = parse_date(player.get("birth"))
    if born:
        return (when - born).days / 365.25
    return None


def season_start(season):
    return dt.date(int(season), 9, 1)


# ---------------------------------------------------------------- age curves

def measure_age_curves(players, history, cfg):
    """Year-on-year change in points per game at each age, chained into a curve.

    Both seasons must clear the games and points-per-game bars. Selecting on
    the first season alone makes every age look like a decline, because a
    player coming off a good year tends to fall back whatever his age. The
    price is that players who drop out entirely aren't counted, so the oldest
    ages may be a little kind; Matt reviews the curves (D5)."""
    seasons = sorted(int(s) for s in history)
    deltas = {}
    for s in seasons[:-1]:
        now, nxt = history[str(s)], history[str(s + 1)]
        for pid, st in now.items():
            p = players.get(pid)
            nx = nxt.get(pid)
            if not p or p["pos"] not in SKILL or not nx:
                continue
            gp0, gp1 = st.get("gp") or 0, nx.get("gp") or 0
            if min(gp0, gp1) < cfg["min_games"]:
                continue
            ppg0 = (st.get("pts_half_ppr") or 0) / gp0
            ppg1 = (nx.get("pts_half_ppr") or 0) / gp1
            if min(ppg0, ppg1) < cfg["min_ppg"]:
                continue
            age = age_on(p, season_start(s))
            if age is None:
                continue
            weight = 2 / (1 / gp0 + 1 / gp1)
            deltas.setdefault(p["pos"], {}).setdefault(int(age), []).append((math.log(ppg1 / ppg0), weight))

    curves = {}
    for pos in SKILL:
        by_age = deltas.get(pos, {})
        ages = list(range(21, 39))
        raw = {a: (sum(d * w for d, w in by_age[a]) / sum(w for _, w in by_age[a]), len(by_age[a])) for a in ages
               if len(by_age.get(a, [])) >= cfg["min_pairs_per_age"]}
        if not raw:
            continue
        lo, hi = min(raw), max(raw)
        d = {}
        for a in ages:
            if a in raw:
                d[a] = raw[a][0]
            elif a < lo:
                d[a] = raw[lo][0]
            elif a > hi:
                d[a] = min(raw[hi][0], -0.10)
            else:  # gap in the middle: nearest measured neighbours
                below = max(x for x in raw if x < a)
                above = min(x for x in raw if x > a)
                d[a] = (raw[below][0] + raw[above][0]) / 2
        smooth = {a: statistics.fmean([d[x] for x in (a - 1, a, a + 1) if x in d]) for a in ages}
        level, c = 1.0, {}
        for a in ages:
            c[a] = level
            level *= math.exp(smooth[a])
        peak = max(c.values())
        c = {a: v / peak for a, v in c.items()}
        for a, v in (cfg["overrides"].get(pos) or {}).items():
            c[int(a)] = float(v)
        peak_age = max(c, key=c.get)
        cliff = next((a for a in ages if a > peak_age and c[a] < 0.8), None)
        curves[pos] = {
            "multiplier": {str(a): round(c[a], 3) for a in ages},
            "pairs": {str(a): len(by_age.get(a, [])) for a in ages},
            "peak_age": peak_age,
            "cliff_age": cliff,
        }
    return curves


def curve_at(curves, pos, age):
    cv = curves.get(pos)
    if not cv or age is None:
        return 1.0
    m = cv["multiplier"]
    if age > 38:  # past the curve: keep declining at its last year's rate
        return m["38"] * (m["38"] / m["37"]) ** (age - 38) if m["37"] else 0.0
    a = max(21, age)
    lo = int(math.floor(a))
    hi = min(38, lo + 1)
    f = a - lo
    return m[str(lo)] * (1 - f) + m[str(hi)] * f


# ---------------------------------------------------------------- replacement level

def starting_slots(league):
    slots = {}
    for s in league.get("roster_positions") or []:
        if s in ALL_POS or s in FLEX_SLOTS:
            slots[s] = slots.get(s, 0) + 1
    teams = league.get("total_rosters") or 12
    return {s: n * teams for s, n in slots.items()}


def replacement_levels(ppg, players, league):
    """Fill every starting slot in the league from the best players, then take
    the next three at each position as the replacement starter."""
    open_slots = starting_slots(league)
    ranked = sorted((pid for pid in ppg if players[pid]["team"]), key=lambda pid: -ppg[pid])
    used = set()
    flex_order = ("WRRB_FLEX", "REC_FLEX", "FLEX", "SUPER_FLEX")
    for pid in ranked:
        if not any(open_slots.values()):
            break
        pos = players[pid]["pos"]
        if open_slots.get(pos, 0) > 0:
            open_slots[pos] -= 1
            used.add(pid)
            continue
        for slot in flex_order:
            if open_slots.get(slot, 0) > 0 and pos in FLEX_SLOTS[slot]:
                open_slots[slot] -= 1
                used.add(pid)
                break
    repl = {}
    for pos in ALL_POS:
        rest = [ppg[pid] for pid in ranked if pid not in used and players[pid]["pos"] == pos][:3]
        repl[pos] = statistics.fmean(rest) if rest else 0.0
    return repl


# ---------------------------------------------------------------- market

def rank_map(values, curve):
    """Put one source's values on another's scale: the nth best gets the
    curve's nth value."""
    order = sorted(values, key=lambda k: -values[k])
    out = {}
    for i, k in enumerate(order):
        out[k] = curve[i] if i < len(curve) else curve[-1] * 0.97 ** (i - len(curve) + 1)
    return out


def parse_pick(name):
    """'2027 1st (Early)', '2027 Early 1st', '2028 1st' -> (year, round, tier|None)."""
    m = re.match(r"(\d{4}) (?:(Early|Mid|Late) )?(\d)(?:st|nd|rd|th)(?: \((Early|Mid|Late)\))?$", name.strip())
    if not m:
        return None
    tier = (m.group(2) or m.group(4) or "").lower() or None
    return int(m.group(1)), int(m.group(3)), tier


def interp(points, x):
    xs = [p[0] for p in points]
    i = bisect.bisect_left(xs, x)
    if i == 0:
        return points[0][1]
    if i >= len(points):
        return points[-1][1]
    (x0, y0), (x1, y1) = points[i - 1], points[i]
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def tier_slots(teams):
    third = round(teams / 3)
    return {
        "early": list(range(1, third + 1)),
        "mid": list(range(third + 1, teams - third + 1)),
        "late": list(range(teams - third + 1, teams + 1)),
    }


def pick_curve(rows, year, chart_teams):
    """Tier values for one draft year as points on an overall-pick axis."""
    mids = {t: statistics.fmean(s) for t, s in tier_slots(chart_teams).items()}
    pts = [((rnd - 1) * chart_teams + mids[tier], v) for (yr, rnd, tier), v in rows.items() if yr == year and tier]
    return sorted(pts)


# ---------------------------------------------------------------- build

def build_league(lg, cfg, shared):
    players, proj_season, proj_weekly, history, curves, state = (
        shared[k] for k in ("players", "proj_season", "proj_weekly", "history", "curves", "state"))
    data = load(os.path.join(CACHE, f"league_{lg['slug']}.json"))
    league = data["league"]
    scoring = league.get("scoring_settings") or {}
    fmt = league_format(league)
    teams = fmt["teams"]
    season = int(state["season"])
    today = dt.date.today()
    pcfg = cfg["points"]
    notes = []

    # ---- points per game: projection, history, baseline
    weekly_pts, weekly_games = {}, {}
    for week, rows in proj_weekly.items():
        for pid, st in rows.items():
            p = players.get(pid)
            if not p:
                continue
            pts = score(st, p["pos"], scoring)
            weekly_pts[pid] = weekly_pts.get(pid, 0) + pts
            if pts > 0:
                weekly_games[pid] = weekly_games.get(pid, 0) + 1

    proj_ppg = {}
    for pid, p in players.items():
        g = weekly_games.get(pid, 0)
        if g >= 3:
            proj_ppg[pid] = weekly_pts[pid] / g
        elif pid in proj_season:
            st = proj_season[pid]
            gp = st.get("gp") or 0
            if gp >= 1 and p["pos"] in SKILL:
                proj_ppg[pid] = score(st, p["pos"], scoring) / gp

    prev = int(state["previous_season"])
    hist_ppg = {}
    for pid, p in players.items():
        num = den = 0.0
        for back, w in enumerate(pcfg["history_weights"]):
            st = history.get(str(prev - back), {}).get(pid)
            if not st or (st.get("gp") or 0) < pcfg["min_games_for_history"]:
                continue
            if p["pos"] not in SKILL:
                continue
            if st.get("team") and p["team"] and st["team"] != p["team"]:
                w *= pcfg["role_change_weight"]
            num += w * score(st, p["pos"], scoring) / st["gp"]
            den += w
        if den:
            hist_ppg[pid] = num / den

    baseline = {}
    for pid in set(proj_ppg) | set(hist_ppg):
        a, b = proj_ppg.get(pid), hist_ppg.get(pid)
        if a is not None and b is not None:
            baseline[pid] = pcfg["projection_weight"] * a + (1 - pcfg["projection_weight"]) * b
        else:
            baseline[pid] = a if a is not None else b

    alloc_ppg = {pid: proj_ppg.get(pid, baseline[pid]) for pid in baseline if players[pid]["pos"] in ALL_POS}
    repl = replacement_levels(alloc_ppg, players, league)

    # ---- points above replacement for each horizon ingredient
    inj = cfg["injury_win_now_factor"]
    comp = {"points_this_season": {}, "points_years_1_3": {}, "points_years_4_plus": {}}
    detail = {}
    base_date = season_start(season)
    for pid, p in players.items():
        pos = p["pos"]
        r = repl.get(pos, 0)
        ros = weekly_pts.get(pid, 0)
        games = weekly_games.get(pid, 0)
        ros_par = max(0.0, ros - r * games) * inj.get(p.get("injury") or "", 1.0)
        age_now = age_on(p, base_date)
        y13 = y4 = 0.0
        if pos in SKILL and pid in baseline and p["team"]:
            c_now = curve_at(curves, pos, age_now)
            for y in range(1, pcfg["future_seasons"] + 1):
                mult = curve_at(curves, pos, None if age_now is None else age_now + y) / c_now if c_now else 1
                par = max(0.0, baseline[pid] * mult - r) * pcfg["games_per_future_season"]
                if y <= 3:
                    y13 += par
                else:
                    y4 += par
        if ros_par or y13 or y4:
            comp["points_this_season"][pid] = ros_par
            comp["points_years_1_3"][pid] = y13
            comp["points_years_4_plus"][pid] = y4
        detail[pid] = (ros, games, age_now)

    # ---- market: FantasyCalc + DynastyProcess, on FantasyCalc's scale
    fc_dyn = load(os.path.join(CACHE, f"fc_{fmt['key']}_dynasty.json"), [])
    fc_red = load(os.path.join(CACHE, f"fc_{fmt['key']}_redraft.json"), [])
    if not fc_dyn:
        notes.append("FantasyCalc dynasty values missing: market is DynastyProcess only.")
    fc = {r["player"]["sleeperId"]: r["value"] for r in fc_dyn
          if r["player"].get("position") != "PICK" and r["player"].get("sleeperId") in players}
    fc_redraft = {r["player"]["sleeperId"]: r["value"] for r in fc_red if r["player"].get("sleeperId") in players}
    for r in fc_dyn:
        sid = r["player"].get("sleeperId")
        if sid in players and sid not in fc_redraft and r.get("redraftValue"):
            fc_redraft[sid] = r["redraftValue"]
    dp_rows = load(os.path.join(CACHE, "dp_values.json"), [])
    dp_ids = load(os.path.join(CACHE, "dp_db_playerids.json"), {})
    vkey = "value_2qb" if fmt["num_qbs"] == 2 else "value_1qb"
    dp = {}
    dp_unmatched = 0
    for r in dp_rows:
        if r["pos"] == "PICK":
            continue
        sid = dp_ids.get(r.get("fp_id"))
        if sid in players:
            dp[sid] = float(r[vkey])
        else:
            dp_unmatched += 1
    fc_curve = sorted(fc.values(), reverse=True) or sorted(dp.values(), reverse=True)
    dp_m = rank_map(dp, fc_curve) if dp else {}
    wf, wd = cfg["market"]["fantasycalc_weight"], cfg["market"]["dynastyprocess_weight"]
    market = {}
    for pid in set(fc) | set(dp_m):
        a, b = fc.get(pid), dp_m.get(pid)
        market[pid] = (wf * a + wd * b) / (wf + wd) if a is not None and b is not None else (a if a is not None else b)

    # ---- points ingredients onto the market's scale: by rank across all
    # positions, or within the position for those listed in the config
    curve = sorted(market.values(), reverse=True)
    own = {pos: sorted((v for pid, v in market.items() if players[pid]["pos"] == pos), reverse=True)
           for pos in pcfg.get("map_within_position", [])}
    mapped = {}
    for name, vals in comp.items():
        skill = {pid: v for pid, v in vals.items() if v > 0 and players[pid]["pos"] in SKILL}
        mapped[name] = rank_map(skill, curve) if skill else {}
        for pos, pos_curve in own.items():
            sub = {pid: v for pid, v in skill.items() if players[pid]["pos"] == pos}
            if sub and pos_curve:
                mapped[name].update(rank_map(sub, pos_curve))

    # ---- each player's ingredients; the site blends them by horizon
    kd = cfg["kdef"]
    rookie_exp = cfg["sliders"]["rookie_max_years_exp"]
    rows = []
    owner_of = {}
    names = lg.get("manager_names", {})
    users = {u["user_id"]: u.get("display_name") for u in data["users"]}
    for r in data["rosters"]:
        who = names.get(r.get("owner_id")) or users.get(r.get("owner_id")) or f"Team {r['roster_id']}"
        for pid in r.get("players") or []:
            owner_of[pid] = who
    for pid, p in players.items():
        pos = p["pos"]
        if pos in ("K", "DEF"):
            par = comp["points_this_season"].get(pid, 0)
            ing = {"kd": round(min(kd["value_cap"], par * kd["value_per_point"]))}
        else:
            ing = {
                "fc": fc.get(pid), "dp": round(dp_m[pid]) if pid in dp_m else None,
                "red": fc_redraft.get(pid),
                "p_now": round(mapped["points_this_season"].get(pid, 0)),
                "p_13": round(mapped["points_years_1_3"].get(pid, 0)),
                "p_4": round(mapped["points_years_4_plus"].get(pid, 0)),
            }
        if not any(ing.values()) and pid not in owner_of:
            continue
        ros, games, age = detail.get(pid, (0, 0, None))
        rows.append({
            "id": pid, "name": p["name"], "pos": pos, "team": p["team"],
            "age": round(age, 1) if age else None, "inj": p.get("injury"),
            "owner": owner_of.get(pid),
            **({"rk": True} if p.get("exp") is not None and p["exp"] <= rookie_exp else {}),
            **ing,
            "ppg": round(baseline[pid], 2) if pid in baseline else None,
            "proj": round(proj_ppg[pid], 2) if pid in proj_ppg else None,
            "hist": round(hist_ppg[pid], 2) if pid in hist_ppg else None,
            "ros": round(ros, 1),
        })
    rows.sort(key=lambda r: -(r.get("fc") or r.get("dp") or r.get("kd") or 0))

    picks, owned = build_picks(lg, cfg, data, fmt, fc_dyn, dp_rows, vkey, season, names, users)

    return {
        "meta": {
            "league": lg["name"], "slug": lg["slug"], "sleeper_league_id": lg["sleeper_league_id"],
            "season": season, "week": state.get("week"), "season_type": state.get("season_type"),
            "format": fmt, "starting_slots": league.get("roster_positions"),
            "scoring": {k: scoring.get(k) for k in ("pass_td", "pass_yd", "rec", "bonus_rec_te", "rush_yd", "rec_yd") if k in scoring},
            "replacement_ppg": {k: round(v, 2) for k, v in repl.items()},
            "qb_premium": lg.get("qb_premium", 1.0),
            "situations": lg.get("situations", {}),
            "counts": {"players": len(rows), "fantasycalc": len(fc), "dynastyprocess": len(dp),
                       "dynastyprocess_unmatched": dp_unmatched, "both_sources": len(set(fc) & set(dp))},
            "notes": notes,
        },
        "players": rows,
        "picks": picks,
        "owned_picks": owned,
    }


def build_picks(lg, cfg, data, fmt, fc_dyn, dp_rows, vkey, season, names, users):
    """Market value of every slot in the next draft, plus who owns which pick.
    The site applies the yearly discount, class ratings and Long-Term boost."""
    pc = cfg["picks"]
    teams = fmt["teams"]
    league = data["league"]
    rounds = (league.get("settings") or {}).get("draft_rounds") or 4
    done = any(str(d.get("season")) == str(season) and d.get("status") == "complete" for d in data["drafts"])
    first_year = season + 1 if done or league.get("status") in ("in_season", "post_season", "complete") else season

    fc_rows = {}
    for r in fc_dyn:
        if r["player"].get("position") == "PICK":
            key = parse_pick(r["player"]["name"])
            if key:
                fc_rows[key] = r["value"]
    dp_rows_p = {}
    for r in dp_rows:
        if r["pos"] == "PICK":
            key = parse_pick(r["player"])
            if key:
                dp_rows_p[key] = float(r[vkey])
    fc_pts = pick_curve(fc_rows, first_year, fmt["fc_teams"])
    dp_pts = pick_curve(dp_rows_p, first_year, 12)  # experts chart in 12s

    def through_round(pts):
        """A source only speaks for the rounds it charts (FantasyCalc stops early)."""
        return math.ceil(pts[-1][0] / teams) * teams if pts else 0

    fc_last, dp_last = through_round(fc_pts), through_round(dp_pts)

    def charted(pts, last, other, other_last, n):
        """Past the last round a source charts, carry its curve on with the
        other source's shape, so values fall smoothly instead of jumping."""
        if n <= last:
            return round(interp(pts, n))
        if not pts or not other or n > other_last or interp(other, last) <= 0:
            return None
        return round(interp(pts, last) * interp(other, n) / interp(other, last))

    out = {
        "first_year": first_year,
        "years": [first_year + k for k in range(pc["years_ahead"])],
        "rounds": rounds,
        "teams": teams,
        "tiers": tier_slots(teams),
        "slots": [{"overall": n,
                   "fc": charted(fc_pts, fc_last, dp_pts, dp_last, n),
                   "dp": charted(dp_pts, dp_last, fc_pts, fc_last, n)}
                  for n in range(1, rounds * teams + 1)],
    }

    # who owns which pick in this league
    by_roster = {r["roster_id"]: names.get(r.get("owner_id")) or users.get(r.get("owner_id")) or f"Team {r['roster_id']}"
                 for r in data["rosters"]}
    owner = {}
    for k in range(pc["years_ahead"]):
        for rnd in range(1, rounds + 1):
            for rid in by_roster:
                owner[(first_year + k, rnd, rid)] = rid
    for t in data["traded_picks"]:
        key = (int(t["season"]), t["round"], t["roster_id"])
        if key in owner:
            owner[key] = t["owner_id"]
    owned = [{"year": y, "round": rnd, "from": by_roster[orig], "owner": by_roster.get(cur, "?")}
             for (y, rnd, orig), cur in sorted(owner.items())]
    return out, owned


def main():
    cfg = config()
    state = load(os.path.join(CACHE, "state.json"))
    players = load(os.path.join(CACHE, "players.json"))
    history = {}
    for name in sorted(os.listdir(HISTORY)):
        m = re.match(r"stats_(\d{4})\.json$", name)
        if m:
            history[m.group(1)] = load(os.path.join(HISTORY, name))
    shared = {
        "state": state,
        "players": players,
        "proj_season": load(os.path.join(CACHE, "proj_season.json"), {}),
        "proj_weekly": load(os.path.join(CACHE, "proj_weekly.json"), {}),
        "history": history,
        "curves": measure_age_curves(players, history, cfg["age_curves"]),
    }
    failures = load(os.path.join(CACHE, "fetch_failures.json"), [])
    testset = load(os.path.join(ROOT, "testset.json"), {"trades": []})
    built = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    index = []
    for lg in cfg["leagues"]:
        out = build_league(lg, cfg, shared)
        out["meta"]["built"] = built
        out["meta"]["fetch_failures"] = failures
        out["age_curves"] = shared["curves"]
        # Everything but the league list, notes included: the lab shows them.
        out["config"] = {k: v for k, v in cfg.items() if k != "leagues"}
        trades = [t for t in testset["trades"] if t.get("league") == lg["slug"]]
        for t in trades:
            for side in ("a", "b"):
                for asset in t[side]["gets"]:
                    pid = asset.get("player") or asset.get("became")
                    if pid and pid not in players:
                        out["meta"]["notes"].append(f"Test trade {t['id']}: {asset.get('name', pid)} isn't in Sleeper's player list.")
        save(os.path.join(SITE_DATA, f"values-{lg['slug']}.json"), out)
        save(os.path.join(SITE_DATA, f"testset-{lg['slug']}.json"), {"trades": trades})
        index.append({"slug": lg["slug"], "name": lg["name"], "built": built})
        top = ", ".join(f"{r['name']} {r['fc']}" for r in out["players"][:5])
        print(f"{lg['slug']}: {len(out['players'])} players, {len(trades)} test trades. Top on FantasyCalc: {top}")
    save(os.path.join(SITE_DATA, "index.json"), {"built": built, "leagues": index})
    for pos, c in shared["curves"].items():
        print(f"age curve {pos}: peak {c['peak_age']}, cliff {c['cliff_age']}")


if __name__ == "__main__":
    main()
