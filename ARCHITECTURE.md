# Architecture — Sleeper Towns (v3)

> Self-contained project documentation: everything needed to continue development
> without prior chat context. Companion docs: [README.md](README.md) (what & why),
> [RESEARCH.md](RESEARCH.md) (data-source research, metric audits, v2 and v3 rethinks).

## What this is

A static web map with one message: **which places become commutable to a chosen
destination once cars drive themselves?** The UI is built on the Faster by Train code base
(MapLibre dots, one switch); the travel times are this repo's own directly queried data,
not Faster by Train's modelled matrices (see RESEARCH.md, v3, for why).

- **Live:** https://kaiman22.github.io/sleeper-towns/
- **Repo:** https://github.com/Kaiman22/sleeper-towns (renamed from `autonomy-explorer`;
  v1 multi-metric explorer is tagged `v1-explorer`, v2 price model is commit `02c37e2`)

```
02h (Google car) + 02g (SBB PT)  →  data/processed/*.json
                         ↓  data/scripts/10_build_commute_data.py
frontend/public/data/commute.json   (651 KB, ships in the build)
                         ↓
React app: model.js classifies every place client-side
```

## Repo layout

```
data/scripts/10_build_commute_data.py   Builds the only file the frontend loads
data/scripts/02h_*, 02g_*               The two travel-time scrapers that feed it
data/scripts/01–09 (rest)               v2 pipeline (prices, taxes, attractiveness, population)
frontend/src/model.js    THE model: DEFAULTS, LIMITS, evaluate(), computeResults() (≈70 lines)
frontend/src/App.jsx     Data loading, URL state, MapLibre layers, panel, tooltip, legend
frontend/src/index.css   Light theme (CARTO Positron basemap), phone layout below 700 px
.github/workflows/deploy.yml   Build + deploy to GitHub Pages
```

## Data

| Input | Script | What it is |
|---|---|---|
| `settlement_points.json` | `01c` | swissNAMES3D settlements (≥ 100 residents), one row per name; multilingual places share a uuid → 3,859 places |
| `settlement_travel_times_driving.json` | `02h` | Google Routes API `TRAFFIC_AWARE`, departure Tue 2026-03-17 07:30, settlement → city station coordinates, seconds. 7 car-free places are null. |
| `settlement_pt_breakdown.json` | `02g` | transport.opendata.ch (SBB timetable), `isArrivalTime=0`, Mon 2026-03-16 07:00, `limit=4`, fastest non-overnight connection, settlement → station name. `total_s` = first departure → arrival (walks, transfers and transfer waits included, no initial wait). Full coverage. |

Do **not** use `settlement_travel_times_pt.json` (02e/02f): it contains ~7.6k
heuristically corrected pairs.

### `commute.json`

```
meta:   { generated, car, pt, from, to }                       provenance strings
pop:    ["100–999", …, "über 100'000"]                         labels for pc
hubs:   [ { id, n, station, lat, lon } ]                       the 10 destinations, chip order
places: [ { n, alt?, m, mid, kt, lat, lon, pc } ]              n = preferred name, alt = other
                                                               languages, m/mid = municipality,
                                                               kt = canton ("" for FL), pc = pop category
car:    { hubId: [minutes | null] }                            aligned with places
pt:     { hubId: [minutes | null] }
```

Preferred name: the one equal to (or prefix of / prefixed by) the municipality name,
else the first listed. Search covers settlement, municipality and alternative names.

## The model (frontend, `model.js`)

```
today    = min(car, pt)                    missing modes are skipped
av       = round(car / comfort)            whole minutes, so display and classification agree
tomorrow = min(pt, av)
cat      = TODAY if today ≤ T  ·  FLIP if tomorrow ≤ T  ·  FAR otherwise
```

Settings: `dest` (default `zurich`), `threshold` T (45 min, 15–90), `comfort` (1.5,
1.0–2.5), `av` (switch, default on). All four persist in the URL (`?to=&max=&k=&av=0`, only
non-defaults are written).

Map: one circle layer per settlement; colour is a `match` on `cat`. The switch only swaps
paint properties: in the "today" view FLIP is painted exactly like FAR, so toggling is what
reveals the flipped places. Destination = black dot; selected / list-hovered place = ring.
On every new destination the map fits to the TODAY ∪ FLIP belt once; slider moves keep the
view.

Panel: destination chips, the switch, counts of TODAY and FLIP, place search, detail card
for a selected place (full arithmetic), the two sliders, list of flipped places (largest
settlements first), method notes.

**Adding a setting:** add it to `DEFAULTS`/`LIMITS` in model.js, pass it to
`computeResults`, add a control in App.jsx, extend `readUrl`/`writeUrl`.

**Adding a destination:** add it to `config.CITIES`, run `02h` (Google key, ~3,900
requests ≈ one free-tier month per key) and `02g` (~3,900 SBB requests, ~1,000/day/IP),
add it to `HUBS` in `10_build_commute_data.py`, rebuild.

## Build & deploy

```bash
python3 data/scripts/10_build_commute_data.py    # if 02g/02h data changed
cd frontend && npm run build                      # commute.json ships inside dist/
git add -A && git commit && git push
gh workflow run deploy.yml --ref main             # REQUIRED
```

⚠️ The workflow's `on: push` trigger is disabled (GitHub auto-disabled it during
inactivity, 2026-03). Every deploy is a manual `workflow_dispatch`. The Pages deploy
step occasionally fails transiently ("Deployment failed, try again later") — re-run.

## Known caveats

- The comfort factor is an assumption, and it drives the result: Zürich at T = 45 has
  615 flipped settlements at 1.5 but 255 at 1.25.
- Train time is counted at full value while AV time is discounted, although train time is
  usable too. This favours the autonomous car; a PT comfort factor would correct it, at the
  cost of a second assumption.
- One query per pair: one Tuesday-morning traffic forecast, one Monday-morning timetable
  window. Day-to-day variance (accidents, delays) is not in the data.
- Query date in March: closed Alpine passes lengthen some mountain car routes.
- Destination is the main station; commuters to other workplaces in the city differ.
- Switzerland and Liechtenstein only; cross-border commuters (Genève, Basel, Ticino) are missing.

## Possible next steps

1. **More destinations** (Zug, Aarau, Baden, Fribourg, Chur …) with fresh 02h + 02g runs.
2. **Optional price layer**: join `data/processed/prices.json` (v2) on `mid`.
3. **PT comfort factor** as a second slider (default 1.0 to keep the current message).
