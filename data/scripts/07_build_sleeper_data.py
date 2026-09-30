"""
Build the lean data file for the Sleeper Towns frontend.

For every settlement: location, price (+source), tax, attractiveness factors and, per
anchor city, three raw travel-time inputs: car seconds, PT door-to-door seconds and
PT in-vehicle seconds. The frontend derives everything else client-side.

Also fits, per anchor, a hedonic price model on our own price data:

    log(CHF/m²) ~ effective_commute_min + controls + canton FE

Controls (transforms mirrored in frontend/src/model.js FEATURES): tax multiplier,
elevation, lake distance, motorway-junction distance, motorway proximity, airport
proximity, population growth. Missing control values are median-imputed; a control
with < 60 % coverage among the fit rows is dropped for that anchor.

The commute coefficient (β) converts AV commute gains into an expected uplift; the
full fit gives each place a "fair value", whose gap to the actual price is the core
of the Sleeper Score.

Inputs (data/processed): settlement_points, settlement_travel_times_driving,
settlement_pt_breakdown (primary PT) + settlement_travel_times_pt (fallback),
prices, taxes, municipalities, settlement_attractiveness (optional), population (optional)

Output: frontend/public/data/sleeper.json
"""
import json
import math
from datetime import datetime, timezone

import numpy as np

from config import CITIES, PROCESSED_DIR, FRONTEND_DATA_DIR

PT_FACTOR_DEFAULT = 0.90   # regression input only ("effective commute" today)
MAX_CAR_MIN_FOR_FIT = 100  # the housing market that matters around an anchor
MIN_OBS_FOR_FIT = 80
MIN_FEATURE_COVERAGE = 0.6
FALLBACK_BETA = -0.0024    # Zürich within-canton estimate, per minute of effective commute


# --- Hedonic control features (keep in sync with model.js FEATURES) ---
def _f(v, fn):
    return fn(v) if v is not None else None


FEATURES = {
    "tax": lambda s: s.get("tax"),
    "elev": lambda s: _f(s.get("elev"), lambda v: v / 1000),
    "lake": lambda s: _f(s.get("lake"), lambda v: math.log1p(v)),
    "mwj": lambda s: _f(s.get("mwj"), lambda v: math.log1p(v)),
    "mw_near": lambda s: _f(s.get("mw"), lambda v: max(0.0, 1 - v)),
    "air_near": lambda s: _f(s.get("air"), lambda v: max(0.0, 8 - v) / 8),
    "grow": lambda s: s.get("grow"),
}


def load(name, optional=False):
    path = PROCESSED_DIR / name
    if optional and not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    settlements = load("settlement_points.json")
    driving = load("settlement_travel_times_driving.json")
    pt_legacy = load("settlement_travel_times_pt.json")
    breakdown = load("settlement_pt_breakdown.json")
    prices = load("prices.json")
    taxes = load("taxes.json")
    munis = {m["id"]: m for m in load("municipalities.json")}
    attract = load("settlement_attractiveness.json", optional=True)
    population = load("population.json", optional=True)
    print(f"attractiveness: {len(attract)} settlements, population: {len(population)} municipalities")

    def travel(uuid, city):
        car = driving.get(uuid, {}).get(city)
        bd = breakdown.get(uuid, {}).get(city)
        if bd:
            pt_total, ivt = bd["total_s"], bd["ivt_s"]
        else:
            pt_total, ivt = pt_legacy.get(uuid, {}).get(city), None
        if car and pt_total and car > 0 and (pt_total / car > 3.5 or pt_total / car < 1 / 3.5):
            pt_total, ivt = None, None  # residual bad routings
        return car, pt_total, ivt

    out = []
    for i, s in enumerate(settlements):
        mid = s["municipality_id"]
        m = munis.get(mid, {})
        pr = prices.get(mid) or {}
        tx = taxes.get(mid) or {}
        a = attract.get(s["uuid"], {})
        pop = population.get(mid, {})
        t = {}
        for city in CITIES:
            car, pt_total, ivt = travel(s["uuid"], city)
            if car is None:
                continue
            t[city] = [int(car), int(pt_total) if pt_total else None, int(ivt) if ivt else None]
        if not t:
            continue
        out.append({
            "id": f"s_{i}",
            "name": s["name"],
            "muni": s["municipality_name"],
            "mid": mid,
            "kt": m.get("canton_code") or s.get("canton"),
            "lat": round(s["lat"], 5),
            "lon": round(s["lon"], 5),
            "price": pr.get("chf_per_m2"),
            "src": pr.get("type"),
            "tax": tx.get("multiplier"),
            "elev": a.get("elev_m"),
            "lake": a.get("lake_km"),
            "mwj": a.get("mwj_km"),
            "mw": a.get("mw_km"),
            "air": a.get("airport_km"),
            "grow": pop.get("growth_pct"),
            "t": t,
        })

    # --- Hedonic fit per anchor (municipality level: best-connected settlement, market prices only) ---
    anchors = {}
    for city, c in CITIES.items():
        best = {}
        for s in out:
            tt = s["t"].get(city)
            if tt and (s["mid"] not in best or tt[0] < best[s["mid"]]["t"][city][0]):
                best[s["mid"]] = s
        rows = []
        for s in best.values():
            if s["src"] in (None, "interpolated") or not s["price"] or s["tax"] is None:
                continue
            car_s, pt_s, ivt_s = s["t"][city]
            car = car_s / 60
            if car > MAX_CAR_MIN_FOR_FIT:
                continue
            if pt_s:
                ptc = (ivt_s * PT_FACTOR_DEFAULT + (pt_s - ivt_s)) / 60 if ivt_s else pt_s * PT_FACTOR_DEFAULT / 60
            else:
                ptc = math.inf
            rows.append((min(car, ptc), s, math.log(s["price"])))

        n = len(rows)
        beta, r2, fitted, fit = FALLBACK_BETA, None, False, None
        if n >= MIN_OBS_FOR_FIT:
            # controls with enough coverage, median-imputed
            feat_names, cols, medians = [], [], {}
            for name, fn in FEATURES.items():
                vals = [fn(s) for _, s, _ in rows]
                have = [v for v in vals if v is not None]
                if len(have) < MIN_FEATURE_COVERAGE * n:
                    continue
                med = float(np.median(have))
                feat_names.append(name)
                medians[name] = round(med, 5)
                cols.append([v if v is not None else med for v in vals])
            cantons = sorted({s["kt"] for _, s, _ in rows})
            X = np.column_stack(
                [np.ones(n), np.array([r[0] for r in rows])]
                + [np.array(col) for col in cols]
                + [np.array([1.0 if s["kt"] == k else 0.0 for _, s, _ in rows]) for k in cantons[1:]]
            )
            y = np.array([r[2] for r in rows])
            b, *_ = np.linalg.lstsq(X, y, rcond=None)
            resid = y - X @ b
            r2 = float(1 - resid.var() / y.var())
            if b[1] < 0:
                beta, fitted = float(b[1]), True
            k = 2 + len(feat_names)
            fit = {
                "alpha": round(float(b[0]), 5),
                "beta": round(float(b[1]), 6),
                "coefs": {nm: round(float(v), 6) for nm, v in zip(feat_names, b[2:k])},
                "medians": medians,
                "fe": {kt: round(float(v), 4) for kt, v in zip(cantons[1:], b[k:])},
                "sigma": round(float(resid.std()), 4),
            }
        anchors[city] = {
            "name": c["name"], "lat": c["lat"], "lon": c["lon"],
            "beta": round(beta, 6),
            "pct_per_10min": round(100 * (1 - math.exp(beta * 10)), 1),
            "r2": round(r2, 3) if r2 is not None else None,
            "n": n, "fitted": fitted, "fit": fit,
        }
        coefs = fit["coefs"] if fit else {}
        print(f"{city:11s} n={n:4d} beta={beta:+.5f} ({anchors[city]['pct_per_10min']}%/10min) "
              f"r2={'-' if r2 is None else round(r2, 2)} {'' if fitted else '[fallback]'} "
              f"controls={ {k: round(v, 3) for k, v in coefs.items()} }")

    data = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "n_settlements": len(out),
            "gradient_model": "log(price/m2) ~ effective_commute_min + tax + elevation + lake/motorway/airport "
                              "distance + population growth + canton FE; market prices within 100 car-min",
            "factor_coverage": {k: sum(1 for s in out if s.get(k) is not None) for k in ["price", "tax", "elev", "lake", "mwj", "mw", "air", "grow"]},
        },
        "anchors": anchors,
        "settlements": out,
    }
    path = FRONTEND_DATA_DIR / "sleeper.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Saved {path} ({path.stat().st_size / 1e6:.2f} MB, {len(out)} settlements) coverage={data['meta']['factor_coverage']}")


if __name__ == "__main__":
    main()
