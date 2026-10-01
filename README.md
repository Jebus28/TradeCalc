# Trade Lab

Dynasty fantasy football values and (soon) a trade analyser for Sleeper leagues,
starting with the Jessica Alba Dynasty League. It costs nothing to run.

The decisions behind the model are in the
[feasibility study](https://claude.ai/code/artifact/0f7ab9b5-82fc-4d6b-90aa-ab92f8a083a9).

## How it works

1. `scripts/fetch_data.py` pulls everything into `data/`: leagues, players,
   projections and past stats from Sleeper; trade-market values from
   FantasyCalc; expert values and player IDs from DynastyProcess.
2. `scripts/build_values.py` turns that into a value for every player and pick
   at three horizons (Win Now, Balanced, Long-Term) and writes
   `site/data/values-<league>.json`.
3. GitHub Pages serves `site/`.
4. A scheduled Action runs steps 1 and 2 every four hours and publishes the result.

## Changing the model

Edit **`model.config.json`** and nothing else. Every weight the model uses is
there, each with a note saying what it does and which decision it came from:
the horizon mix, the FantasyCalc / DynastyProcess blend, how past seasons count,
age-curve overrides, injury factors, pick discounts and draft-class ratings,
the league QB premium, and kicker/defence values.

Push the change and the site rebuilds within a couple of minutes.

To add a league, add an entry under `leagues` with its Sleeper league ID.

## One-time setup on GitHub

- The repository must be **public** for free GitHub Pages.
- **Settings → Pages → Source: GitHub Actions.**
- Before sharing the site beyond the league, email FantasyCalc
  (fantasycalcff@gmail.com) as their terms ask. They'd rather hear from a
  person than from AI.

## Running it yourself

```
python scripts/fetch_data.py
python scripts/build_values.py
python -m http.server 8765 --directory site
```

Then open http://localhost:8765. Python 3.10 or later; no packages to install.

## Sources and terms

- [Sleeper API](https://docs.sleeper.com/): free for non-commercial use. The
  player list is fetched at most once a day. Projections and stats use
  undocumented endpoints that could change.
- [FantasyCalc](https://fantasycalc.com/api-docs): documented endpoint only,
  cached at least an hour, with attribution on every page showing the data.
- [DynastyProcess](https://github.com/dynastyprocess/data): GPL-3.0 data files.
- KeepTradeCut is not used: its terms forbid using its values in tools.
