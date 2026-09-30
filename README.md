# Sleeper Towns 🚗💤

**Where self-driving cars wake up Swiss property values.**

Pick the city you commute to (Zürich by default). The map finds settlements that are
cheap today because the drive is long-ish and public transport is weak — exactly the
commute a self-driving car turns into usable time.

**Live:** https://kaiman22.github.io/sleeper-towns/

## Why "Sleeper Towns"?

1. **Investment slang** — a "sleeper" is an undervalued asset nobody noticed yet.
2. **Swiss German** — commuter villages are literally *Schlafgemeinden*.
3. **Literally** — in an autonomous car you can sleep, work or read through the commute.

## The model (all of it)

Per settlement and anchor city, three measured inputs: car minutes, PT door-to-door
minutes, PT in-vehicle minutes.

```
ptComfort = ivt × ptFactor + walk + wait        train time counts less than driving
tNow      = min(car, ptComfort)                  today's best effective commute
tAv       = car × avFactor                       the same drive in a self-driving car
gain      = max(0, tNow − min(tAv, ptComfort))   effective minutes AV takes off the commute
uplift    = exp(|β| × gain) − 1                  β = price gradient per commute minute,
                                                 measured on our own price data (hedonic OLS
                                                 with canton fixed effects, per anchor city)
fairNow   = hedonic fair value today (commute, tax, canton)
Sleeper   = fairNow × (1 + uplift) / price − 1   discount to post-AV fair value
```

Places whose AV trip exceeds your commute limit are greyed out: savings nobody can
use never capitalize into property value. The gradient replaces value-of-time and
cap-rate assumptions with a number measured in the Swiss market (Zürich: −2.4 % per
10 minutes of effective commute, R² 0.61 on 585 municipalities).

The score is a **screening signal, not a forecast**: it ignores zoning reserves,
robotaxi rollout order, congestion and attractiveness (lake, slope, noise, schools).
A cheap town is sometimes cheap for a reason — check that yourself.

## Data

- 3,958 settlement points in 2,069 municipalities (swissNAMES3D)
- Car times: Google routing to 10 reference cities
- PT times: SBB timetable (transport.opendata.ch), Monday 07:00 departures, door to door, with walk/wait/in-vehicle split
- Prices: Neho hedonic estimates (primary) + Homegate listing medians; municipalities without market data are
  interpolated from neighbours ("est.") and excluded from the Sleeper Score
- Tax: ESTV municipal multipliers

See [ARCHITECTURE.md](ARCHITECTURE.md) for the pipeline and [RESEARCH.md](RESEARCH.md) for the
data-source research and the empirical audit behind the model.

## Run

```bash
cd frontend && npm install && npm run dev        # local
python3 data/scripts/07_build_sleeper_data.py    # rebuild data (after any upstream change)
```

Deploys to GitHub Pages via `gh workflow run deploy.yml --ref main` (the push trigger is disabled).
