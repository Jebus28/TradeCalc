"""Step 1: pull everything the model needs from free sources into data/.

Sleeper (leagues, players, projections, past stats), FantasyCalc (trade-market
values) and DynastyProcess (expert values and the player ID map).

Run:  python scripts/fetch_data.py
"""
import csv
import io
import os
import sys
import urllib.parse

from common import (ALL_POS, CACHE, HISTORY, SKILL, age_hours, config, get,
                    get_json, league_format, load, save)

SLEEPER = "https://api.sleeper.app/v1"
SLEEPER_WEB = "https://api.sleeper.com"   # undocumented: projections and stats
FANTASYCALC = "https://api.fantasycalc.com/values/current"
DP_RAW = "https://raw.githubusercontent.com/dynastyprocess/data/master/files"

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
