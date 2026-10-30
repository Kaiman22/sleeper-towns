# Sleeper Towns 🚗💤

**Welche Orte macht das selbstfahrende Auto pendelbar?**

Pick the city you commute to. The map shows every Swiss settlement that is out of
commuting range today and drops below it once the car drives itself: the places that
*kippen* (flip).

**Live:** https://kaiman22.github.io/sleeper-towns/

## Why "Sleeper Towns"?

1. **Swiss German**: commuter villages are literally *Schlafgemeinden*.
2. **Literally**: in an autonomous car you can sleep, work or read through the commute.

## The model (all of it)

Per settlement and destination, two queried numbers: car minutes and PT minutes.

```
today    = min(car, pt)          best option today
av       = car / comfort         effective time in a self-driving car (comfort default 1.5)
tomorrow = min(pt, av)           best option once the car drives itself

TODAY    today ≤ threshold                       commutable already
FLIP     today > threshold and tomorrow ≤ it     becomes commutable ("kippt")
FAR      tomorrow > threshold                    stays out of range
```

The autonomous car is always compared against **today's best option**, never against
driving yourself. Threshold (default 45 min) and comfort factor (default 1.5) are sliders.
One switch, «mit autonomem Auto», flips the map between today and tomorrow.

Defaults, Zürich HB as destination: 336 settlements commutable today, 615 flip (×2.8).
The comfort factor drives the result: at 1.25 only 255 flip.

## Data: queried, not estimated

Every travel time is a direct answer from a routing service, in the commuting direction,
from the same point for both modes: the settlement point (swissNAMES3D) to the main
station of the destination. No distance model, no correction factor, no interpolation.

- **Car**: Google Maps Routes API, `TRAFFIC_AWARE`, departure Tuesday 07:30
  (`02h_fetch_driving_times_google.py`). Car-free places (Zermatt, Wengen, ...) have no
  car time and cannot flip.
- **PT**: SBB timetable 2026 via transport.opendata.ch, fastest of the next four
  connections from Monday 07:00, door to door incl. walks, transfers and transfer waits,
  no wait before the first departure (`02g_fetch_pt_breakdown.py`).
- **Places**: 3,859 settlements with ≥ 100 residents (swissNAMES3D), complete coverage
  for all 10 destinations: Zürich, Bern, Basel, Genève, Lausanne, Luzern, St. Gallen,
  Winterthur, Lugano, Biel/Bienne.

Not modelled: parking, induced AV traffic, cost, destinations other than the main station,
cross-border commuters. More destinations need a new Google + SBB run each
(~3,900 queries per destination and mode).

The earlier property-price version (hedonic fair value, Sleeper Score, Match) is in git
history at commit `02c37e2`; its pipeline (`data/scripts/01–09`) still works and can come
back as an optional layer.

## Run

```bash
cd frontend && npm install && npm run dev        # local
python3 data/scripts/10_build_commute_data.py    # rebuild commute.json from data/processed
```

Deploys to GitHub Pages via `gh workflow run deploy.yml --ref main` (the push trigger is disabled).
