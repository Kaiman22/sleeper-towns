# Architecture — Sleeper Towns (v2)

> Self-contained project documentation: everything needed to continue development
> without prior chat context. Companion docs: [README.md](README.md) (what & why),
> [RESEARCH.md](RESEARCH.md) (data-source research, metric audits, v2 rethink).

## What this is

A static web map that screens Swiss settlements for "sleeper towns": places that are
cheap today relative to what their commute will be worth once self-driving cars make
travel time usable. One anchor city at a time (Zürich by default), one score.

- **Live:** https://kaiman22.github.io/sleeper-towns/
- **Repo:** https://github.com/Kaiman22/sleeper-towns (renamed from `autonomy-explorer`;
  v1 multi-metric explorer is tagged `v1-explorer`)

```
data/scripts/01–04  →  data/processed/*.json  →  07_build_sleeper_data.py
                                                        ↓
                        frontend/public/data/sleeper.json  (1.7 MB, ships in the build)
                                                        ↓
                        React app: model.js computes everything client-side
```

## Repo layout

```
data/scripts/            Python pipeline (numbered = execution order); config.py = 10 anchor cities, paths
data/processed/          Pipeline outputs & scraper checkpoints (committed)
frontend/src/model.js    THE model: METRICS, computeRows, ranking, colors (≈150 lines)
frontend/src/App.jsx     State, data loading, URL state (?to=&max=&by=), tooltip
frontend/src/Map.jsx     MapLibre: viable/dim layers, quantile colors, rings, anchor marker, legend
frontend/src/Panel.jsx   Controls, search, detail card, Top-15 list, assumptions expander
frontend/src/index.css   Lean dark theme, mobile stacking below 800px
.github/workflows/deploy.yml   Build + deploy to GitHub Pages
```

Removed in v2 (still in git history / tag `v1-explorer`): custom reference locations
(Geoapify + SBB hub routing), multi-city averaging, per-city max-time filters, heatmap
mode, basemap switcher, VTT/cap-rate value-unlock model, `05_compute_scores.py` GeoJSON.
`frontend/.env` (Geoapify key) is no longer needed.

## Data pipeline

| Step | Script | Output | Notes |
|---|---|---|---|
| 1 | `01_fetch_municipalities.py`, `01c_fetch_settlement_points.py` | `municipalities.json`, `settlement_points.json` | 2,128 municipalities, 3,966 settlement points (swissNAMES3D). `01b` (PLZ) legacy. |
| 2 | `02h_fetch_driving_times_google.py` | `settlement_travel_times_driving.json` | Car seconds to 10 cities. Ran on a dedicated machine, synced via git. `02/02b/02c/02d` legacy. |
| 2 | `02g_fetch_pt_breakdown.py` | `settlement_pt_breakdown.json` | **Primary PT source.** Departure-based (`isArrivalTime=0`, Monday 07:00, best of 4), total/walk/wait/ivt seconds. 3,859/3,966 coverage. Never use arrival-based queries (overnight-connection bug). |
| 2 | `02e_fetch_pt_times_sbb.py` + `02f_fix_overnight_pt.py` | `settlement_travel_times_pt.json` | Legacy PT (contains ~7.6k heuristically corrected pairs); used only as fallback where 02g has no data. |
| 3 | `03b_*neho*.py`, `03c_fetch_prices_homegate.py`, `04_merge_prices.py` | `prices.json` | Neho hedonic (1,368) + Homegate medians (237) + IDW-interpolated (467, `type: interpolated`). Playwright + stealth (Cloudflare). |
| 4 | `04_fetch_taxes.py` | `taxes.json` | ESTV multipliers, 2,122 municipalities. |
| **7** | **`07_build_sleeper_data.py`** | `frontend/public/data/sleeper.json` | Builds the lean file and fits the per-anchor hedonic model. Fast, idempotent — the only step to re-run after upstream changes. |

SBB API limit: ~1,000 requests/day/IP — full PT scrapes take days on the dedicated machine.

### `sleeper.json` shape

```
meta:      { generated_at, n_settlements, gradient_model }
anchors:   { zurich: { name, lat, lon,
                       beta, pct_per_10min,       gradient used for the uplift (fallback -0.0024 if fit not robust)
                       r2, n, fitted,
                       fit: { alpha, beta, gamma, fe: {canton: coef}, sigma } } , ... }
settlements: [ { id, name, muni, mid, kt, lat, lon, price, src, tax,
                 t: { zurich: [car_s, pt_total_s, ivt_s], ... } } ]
```

`src` ∈ neho | homegate | interpolated | null. PT plausibility filter (PT/car ratio outside
[1/3.5, 3.5] → PT dropped) is applied in step 7.

## The model (frontend, `model.js`)

Per settlement and anchor, with user settings `avFactor` (0.65), `ptFactor` (0.9),
`tolerance` (45 min), `maxPrice`:

```
ptComfort = ivt·ptFactor + (ptTotal − ivt)          (ptTotal·ptFactor if no breakdown; ∞ if no PT)
tNow      = min(car, ptComfort)
tAv       = car·avFactor
gain      = max(0, tNow − min(tAv, ptComfort))
uplift%   = (exp(|anchor.beta|·gain) − 1)·100
fairNow   = exp(fit.alpha + fit.beta·tNow + fit.gamma·tax + fit.fe[kt])
fairPost  = fairNow·(1 + uplift)
sleeper%  = (fairPost / price − 1)·100              null for interpolated prices
viable    = tAv ≤ tolerance AND (no price limit OR price ≤ maxPrice)
```

Metrics: `sleeper` (default), `uplift`, `gain_chf` (= price·uplift), `price`. Colors are
quantile stops (p10/p25/p75/p90) over viable rows; non-viable rows are drawn dim grey.
Ranking = best settlement per municipality, top 15.

Why this shape (details in RESEARCH.md "v2 rethink"):
- Raw AV upside is ~0.9 correlated with distance; an uplift-only ranking degenerates
  into "the ring exactly at the commute limit". The hedonic residual (fairNow vs price)
  is what separates places inside that ring.
- Interpolated prices are excluded from the score: they inherit their neighbours'
  level, so expensive lakeside towns show phantom discounts.
- The gradient β is measured per anchor; where the local fit is not robust (positive
  slope, polycentric markets like Bern/Biel/St. Gallen/Lugano) the Zürich value is used
  and flagged (`fitted: false`, shown in the UI).

**Adding a user setting:** add it to `DEFAULTS` in model.js, read it in `computeRows`,
add a control in Panel.jsx. `readUrl/writeUrl` in App.jsx only persist anchor,
tolerance and metric.

## Build & deploy

```bash
python3 data/scripts/07_build_sleeper_data.py     # if data changed
cd frontend && npm run build                       # sleeper.json ships inside dist/
git add -A && git commit && git push
gh workflow run deploy.yml --ref main              # REQUIRED
```

⚠️ The workflow's `on: push` trigger is disabled (GitHub auto-disabled it during
inactivity, 2026-03). Every deploy is a manual `workflow_dispatch`. The Pages deploy
step occasionally fails transiently ("Deployment failed, try again later") — re-run.

Local preview of the built site: `.claude/launch.json` config `sleeper-towns` serves
`frontend/dist` with `python3 -m http.server`.

## Known caveats

- Prices: Homegate medians accept ≥2 listings (noisy in small towns); 467 municipalities
  interpolated. Top Sleeper Score entries are leads to verify, not answers — cheap can
  mean noisy, industrial, or a nuclear plant next door (Leibstadt ranks high).
- Hedonic fit explains ~60 % of price variance within 100 car-min of Zürich; the residual
  mixes mispricing with unmeasured attractiveness.
- No supply-side data (building-zone reserves), no rollout geography, no congestion.

## Next data worth adding (in priority order)

1. **Attractiveness controls** for the hedonic fit: elevation & sun (swisstopo height
   service, free REST), lake distance (swissBOUNDARIES lakes), noise (BAFU Lärm), population
   growth (BFS STATPOP). Reduces the residual's "cheap for a reason" contamination.
2. **Building-zone reserves** (ARE Bauzonenstatistik, Excel) — supply elasticity decides
   whether demand becomes price or new units.
3. **Fresh price scrape** for interpolated municipalities within ~75 car-min of Zürich
   (targeted Neho/Homegate run; ~120 municipalities) so they can enter the score.
4. **Highway-junction distance** (OSM Overpass, `motorway_junction`) — early AV service
   quality proxy.
