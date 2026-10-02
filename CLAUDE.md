# Notes for Claude

- Matt (Sleeper "Jebus") makes the modelling decisions and doesn't code. Explain
  changes in plain English and keep every tunable number in `model.config.json`
  with an underscore-prefixed note key beside it (e.g. `_horizons`), never
  hard-coded in scripts.
- Decisions D1–D16, the 12-trade test set and the lessons from it are in the
  feasibility study doc linked from README.md. Check it before changing the model.
- The test set itself lives in `testset.json`; the model lab (`site/lab.html`)
  scores it. Layers 1–2 (points, market) are Python; layers 3–4 (horizon blend,
  sliders, star rule, verdicts) are `site/assets/model.js`. Don't duplicate them.
- Python standard library only (the Action installs nothing). The site is plain
  HTML/CSS/JS with no build step; colours and fonts follow the JADL site
  (Jebus28/jadl `assets/site.css`), dark mode included.
- `data/cache/` and `site/data/` are generated and not committed;
  `data/history/` (completed seasons) is committed and fetched once.
- Respect source terms: Sleeper player list at most daily; FantasyCalc
  documented endpoint only, cached at least an hour, attributed on every page;
  no KeepTradeCut data.
- UK English in everything user-facing.
