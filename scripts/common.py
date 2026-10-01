"""Shared helpers: paths, config, HTTP and league-format detection."""
import json
import os
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "cache")      # fetched every run, not committed
HISTORY = os.path.join(ROOT, "data", "history")  # past seasons, fetched once, committed
SITE = os.path.join(ROOT, "site")
SITE_DATA = os.path.join(SITE, "data")           # built values, deployed with the site

SKILL = ("QB", "RB", "WR", "TE")
ALL_POS = SKILL + ("K", "DEF")


def config():
    with open(os.path.join(ROOT, "model.config.json"), encoding="utf-8") as f:
        return json.load(f)


def get(url, tries=3):
    req = urllib.request.Request(url, headers={"User-Agent": "TradeCalc (github.com/Jebus28/TradeCalc)"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def get_json(url):
    return json.loads(get(url))


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(path, obj, compact=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
        else:
            json.dump(obj, f, indent=1, ensure_ascii=False)


def age_hours(path):
    if not os.path.exists(path):
        return 1e9
    return (time.time() - os.path.getmtime(path)) / 3600


def league_format(league):
    """What FantasyCalc and DynastyProcess need to know about a Sleeper league."""
    slots = league.get("roster_positions") or []
    scoring = league.get("scoring_settings") or {}
    teams = league.get("total_rosters") or 12
    superflex = "SUPER_FLEX" in slots or slots.count("QB") >= 2
    rec = scoring.get("rec", 0)
    ppr = min((0, 0.5, 1), key=lambda p: abs(p - rec))
    te_bonus = scoring.get("bonus_rec_te", 0)
    tep = "none" if te_bonus <= 0 else ("te+" if te_bonus <= 0.5 else "te++")
    fc_teams = min((8, 10, 12, 14), key=lambda t: abs(t - teams))
    return {
        "num_qbs": 2 if superflex else 1,
        "ppr": ppr,
        "tep": tep,
        "teams": teams,
        "fc_teams": fc_teams,
        "key": f"{'sf' if superflex else '1qb'}-{fc_teams}t-ppr{ppr}-{tep}",
    }
