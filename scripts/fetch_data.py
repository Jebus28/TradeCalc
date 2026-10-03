"""Step 1: pull everything the model needs from free sources into data/.

Sleeper (leagues, players, projections, past stats, every season's
transactions), FantasyCalc (trade-market
values) and DynastyProcess (expert values and the player ID map).

Run:  python scripts/fetch_data.py
"""
import csv
import io
import os
import sys
import time
import urllib.parse

from common import (ALL_POS, CACHE, HISTORY, SKILL, age_hours, config, get,
                    get_json, league_format, load, save)

SLEEPER = "https://api.sleeper.app/v1"
SLEEPER_WEB = "https://api.sleeper.com"   # undocumented: projections and stats
FANTASYCALC = "https://api.fantasycalc.com/values/current"
DP_RAW = "https://raw.githubusercontent.com/dynastyprocess/data/master/files"
TX_WEEKS = range(0, 19)   # Sleeper files transactions by week; 0 is the offseason
SLEEPER_PAUSE = 0.1       # seconds between transaction calls: Sleeper allows 1,000 a minute

# Stat lines are trimmed to what league scoring can use.
SKIP_WORDS = ("rank", "adp", "lng", "ypc", "ypa", "ypt", "pct", "rtg", "air", "snp", "_0_", "_10_", "_20_", "_30_", "_40_")


def keep_stat(key):
    if key in ("gp", "pts_half_ppr", "pts_ppr", "pts_std"):
        return True
    if key.startswith(("pts_", "pos_", "gms_")) or any(w in key for w in SKIP_WORDS):
        return False
    return key.startswith(("pass_", "rush_", "rec", "fum", "bonus_", "fgm", "fgmiss", "xp"))


def positions_query(positions):
    return "&".join(f"position[]={p}" for p in positions)


def fetch_players():
    """Sleeper asks for the full player list at most once a day."""
    path = os.path.join(CACHE, "players.json")
    if age_hours(path) < 20:
        print("players: cached")
        return
    raw = get_json(f"{SLEEPER}/players/nfl")
    slim = {}
    for pid, p in raw.items():
        pos = p.get("position")
        if pos not in ALL_POS:
            # Two-way players such as Travis Hunter are listed at their
            # defensive position; use their fantasy position instead.
            pos = next((f for f in p.get("fantasy_positions") or [] if f in ALL_POS), None)
            if not pos:
                continue
        slim[pid] = {
            "name": p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip() or pid,
            "pos": pos,
            "team": p.get("team"),
            "birth": p.get("birth_date"),
            "age": p.get("age"),
            "exp": p.get("years_exp"),
            "injury": p.get("injury_status"),
            "status": p.get("status"),
            "active": p.get("active"),
            "depth": p.get("depth_chart_order"),
        }
    save(path, slim)
    print(f"players: {len(slim)}")


def fetch_projections(state):
    season = state["season"]
    pos = positions_query(ALL_POS)
    season_proj = get_json(f"{SLEEPER_WEB}/projections/nfl/{season}?season_type=regular&{pos}")
    save(os.path.join(CACHE, "proj_season.json"), {r["player_id"]: r["stats"] for r in season_proj if r.get("stats")})
    weekly = {}
    if state.get("season_type") == "regular":
        last = config()["points"]["last_regular_week"]
        for week in range(int(state["week"]), last + 1):
            rows = get_json(f"{SLEEPER_WEB}/projections/nfl/{season}/{week}?season_type=regular&{pos}")
            weekly[str(week)] = {r["player_id"]: {k: v for k, v in r["stats"].items() if keep_stat(k)}
                                 for r in rows if r.get("stats")}
    save(os.path.join(CACHE, "proj_weekly.json"), weekly)
    print(f"projections: season {len(season_proj)}, weeks {list(weekly)}")


def fetch_history(state):
    """Completed seasons never change, so each is fetched once and committed."""
    first = config()["age_curves"]["first_season"]
    last = int(state["previous_season"])
    pos = positions_query(SKILL + ("K",))
    for season in range(first, last + 1):
        path = os.path.join(HISTORY, f"stats_{season}.json")
        if os.path.exists(path):
            continue
        rows = get_json(f"{SLEEPER_WEB}/stats/nfl/{season}?season_type=regular&{pos}")
        out = {}
        for r in rows:
            stats = r.get("stats") or {}
            if not stats.get("gp"):
                continue
            out[r["player_id"]] = {"team": r.get("team"), **{k: v for k, v in stats.items() if keep_stat(k)}}
        save(path, out)
        print(f"history {season}: {len(out)} players")


def fetch_leagues(state):
    for lg in config()["leagues"]:
        lid = lg["sleeper_league_id"]
        league = get_json(f"{SLEEPER}/league/{lid}")
        data = {
            "league": league,
            "users": get_json(f"{SLEEPER}/league/{lid}/users"),
            "rosters": get_json(f"{SLEEPER}/league/{lid}/rosters"),
            "traded_picks": get_json(f"{SLEEPER}/league/{lid}/traded_picks"),
            "drafts": get_json(f"{SLEEPER}/league/{lid}/drafts"),
        }
        save(os.path.join(CACHE, f"league_{lg['slug']}.json"), data)
        print(f"league {lg['slug']}: {league['name']}, {len(data['rosters'])} rosters")


def slim_transaction(t):
    """What the tendency and FAAB studies need from a Sleeper transaction."""
    return {
        "id": t.get("transaction_id"),
        "type": t.get("type"),
        "created": t.get("created"),
        "week": t.get("leg"),
        "roster_ids": t.get("roster_ids") or [],
        "adds": t.get("adds") or {},
        "drops": t.get("drops") or {},
        "draft_picks": [{k: p.get(k) for k in ("season", "round", "roster_id", "owner_id", "previous_owner_id")}
                        for p in t.get("draft_picks") or []],
        "waiver_budget": t.get("waiver_budget") or [],
        "waiver_bid": (t.get("settings") or {}).get("waiver_bid"),
    }


def fetch_season_transactions(lid, league):
    """One season of a league: who owned each roster, its drafts and every
    completed transaction (trades, waiver claims, free-agent pickups)."""
    users = get_json(f"{SLEEPER}/league/{lid}/users")
    rosters = get_json(f"{SLEEPER}/league/{lid}/rosters")
    drafts = get_json(f"{SLEEPER}/league/{lid}/drafts")
    seen = {}
    for week in TX_WEEKS:
        for t in get_json(f"{SLEEPER}/league/{lid}/transactions/{week}") or []:
            if t.get("status") == "complete" and t.get("transaction_id") not in seen:
                seen[t.get("transaction_id")] = slim_transaction(t)
        time.sleep(SLEEPER_PAUSE)
    return {
        "season": int(league["season"]),
        "league_id": lid,
        "previous_league_id": league.get("previous_league_id"),
        "owners": {str(r["roster_id"]): r.get("owner_id") for r in rosters},
        "users": {u["user_id"]: u.get("display_name") for u in users},
        "drafts": [{k: d.get(k) for k in ("draft_id", "season", "type", "status", "start_time", "last_picked")}
                   for d in drafts],
        "transactions": sorted(seen.values(), key=lambda t: t["created"] or 0),
    }


def fetch_transactions(state):
    """Follow each league back to its first season. Completed seasons never
    change, so each is fetched once into data/history and committed; the
    current season is refetched every run."""
    current = int(state["season"])
    for lg in config()["leagues"]:
        lid, guess = lg["sleeper_league_id"], None
        while lid and lid != "0":
            # A season already saved needs no calls at all, not even the league.
            if guess is not None:
                path = os.path.join(HISTORY, f"transactions_{lg['slug']}_{guess}.json")
                saved = load(path)
                if saved and saved.get("league_id") == lid:
                    lid, guess = saved.get("previous_league_id"), guess - 1
                    continue
            league = get_json(f"{SLEEPER}/league/{lid}")
            season = int(league["season"])
            folder = HISTORY if season < current else CACHE
            path = os.path.join(folder, f"transactions_{lg['slug']}_{season}.json")
            if folder == CACHE or not os.path.exists(path):
                data = fetch_season_transactions(lid, league)
                save(path, data)
                trades = sum(t["type"] == "trade" for t in data["transactions"])
                print(f"transactions {lg['slug']} {season}: {len(data['transactions'])} ({trades} trades)")
            lid, guess = league.get("previous_league_id"), season - 1


def fetch_fantasycalc():
    """One call per league format and type. FantasyCalc asks for at least an hour between refreshes."""
    seen = set()
    for lg in config()["leagues"]:
        league = load(os.path.join(CACHE, f"league_{lg['slug']}.json"))["league"]
        fmt = league_format(league)
        if fmt["key"] in seen:
            continue
        seen.add(fmt["key"])
        for dynasty in (True, False):
            path = os.path.join(CACHE, f"fc_{fmt['key']}_{'dynasty' if dynasty else 'redraft'}.json")
            if age_hours(path) < 1:
                continue
            url = (f"{FANTASYCALC}?isDynasty={'true' if dynasty else 'false'}&numQbs={fmt['num_qbs']}"
                   f"&numTeams={fmt['fc_teams']}&ppr={fmt['ppr']}&tep={urllib.parse.quote(fmt['tep'])}")
            rows = get_json(url)
            save(path, rows)
            print(f"fantasycalc {fmt['key']} {'dynasty' if dynasty else 'redraft'}: {len(rows)}")


def fetch_dynastyprocess():
    """Updated weekly upstream, so once a day is plenty."""
    for name in ("values.csv", "db_playerids.csv"):
        path = os.path.join(CACHE, f"dp_{name.replace('.csv', '.json')}")
        if age_hours(path) < 20:
            continue
        text = get(f"{DP_RAW}/{name}").decode("utf-8")
        rows = list(csv.DictReader(io.StringIO(text)))
        if name == "db_playerids.csv":
            rows = {r["fantasypros_id"]: r["sleeper_id"] for r in rows
                    if r.get("fantasypros_id") not in (None, "", "NA") and r.get("sleeper_id") not in (None, "", "NA")}
        save(path, rows)
        print(f"dynastyprocess {name}: {len(rows)}")


def main():
    os.makedirs(CACHE, exist_ok=True)
    state = get_json(f"{SLEEPER}/state/nfl")
    save(os.path.join(CACHE, "state.json"), state)
    print(f"NFL state: {state['season']} {state['season_type']} week {state['week']}")
    steps = [("players", fetch_players), ("projections", lambda: fetch_projections(state)),
             ("history", lambda: fetch_history(state)), ("leagues", lambda: fetch_leagues(state)),
             ("transactions", lambda: fetch_transactions(state)),
             ("fantasycalc", fetch_fantasycalc), ("dynastyprocess", fetch_dynastyprocess)]
    failed = []
    for name, step in steps:
        try:
            step()
        except Exception as e:  # one broken source must not stop the others
            failed.append(name)
            print(f"FAILED: {name}: {e}", file=sys.stderr)
    save(os.path.join(CACHE, "fetch_failures.json"), failed)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
