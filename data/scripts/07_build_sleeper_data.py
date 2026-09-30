"""
Build the lean data file for the Sleeper Towns frontend (v2).

For every settlement: location, price (+source), tax multiplier and, per anchor
city, three raw travel-time inputs: car seconds, PT door-to-door seconds and PT
in-vehicle seconds. The frontend derives everything else client-side.

Also estimates, per anchor, the empirical price gradient w.r.t. effective commute
time from our own price data (hedonic OLS with canton fixed effects). The frontend
uses that gradient to translate AV commute gains into an expected price uplift,
replacing the earlier VTT × cap-rate assumptions with a number measured in the
Swiss market itself.

PT source priority: 02g breakdown totals (clean, departure-based queries) over the
legacy 02e file (contains ~7.6k heuristically corrected overnight pairs).

Output: frontend/public/data/sleeper.json
"""
import json
import math
from datetime import datetime, timezone

import numpy as np

from config import CITIES, PROCESSED_DIR, FRONTEND_DATA_DIR

PT_FACTOR_DEFAULT = 0.90   # used only for the regression's "effective commute" input
MAX_CAR_MIN_FOR_FIT = 100  # relevant housing market around an anchor
MIN_OBS_FOR_FIT = 80
FALLBACK_BETA = -0.0024    # Zürich within-canton estimate, per minute of effective commute


def load(name):
    with open(PROCESSED_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def main():
    settlements = load("settlement_points.json")
    driving = load("settlement_travel_times_driving.json")
    pt_legacy = load("settlement_travel_times_pt.json")
    breakdown = load("settlement_pt_breakdown.json")
    prices = load("prices.json")
    taxes = load("taxes.json")
    munis = {m["id"]: m for m in load("municipalities.json")}

    def travel(uuid, city):
        car = driving.get(uuid, {}).get(city)
        bd = breakdown.get(uuid, {}).get(city)
        if bd:
            pt_total, ivt = bd["total_s"], bd["ivt_s"]
        else:
            pt_total, ivt = pt_legacy.get(uuid, {}).get(city), None
        # Plausibility: drop PT when wildly off vs car (residual bad routings)
        if car and pt_total and car > 0 and (pt_total / car > 3.5 or pt_total / car < 1 / 3.5):
            pt_total, ivt = None, None
        return car, pt_total, ivt

    out_settlements = []
    for i, s in enumerate(settlements):
        mid = s["municipality_id"]
        m = munis.get(mid, {})
        pr = prices.get(mid) or {}
        tx = taxes.get(mid) or {}
        t = {}
        for city in CITIES:
            car, pt_total, ivt = travel(s["uuid"], city)
            if car is None:
                continue
            t[city] = [int(car), int(pt_total) if pt_total else None, int(ivt) if ivt else None]
        if not t:
            continue
        out_settlements.append({
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
            "t": t,
        })

    # --- Hedonic gradient per anchor (municipality level, real prices only) ---
    anchors = {}
    for city, c in CITIES.items():
        best = {}
        for s in out_settlements:
            tt = s["t"].get(city)
            if not tt:
                continue
            if s["mid"] not in best or tt[0] < best[s["mid"]]["t"][city][0]:
                best[s["mid"]] = s
        rows = []
        for mid, s in best.items():
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
            rows.append((min(car, ptc), s["tax"], s["kt"], math.log(s["price"])))

        beta, r2, n, fitted, fit = FALLBACK_BETA, None, len(rows), False, None
        if n >= MIN_OBS_FOR_FIT:
            cantons = sorted({r[2] for r in rows})
            X = np.array([[1.0, r[0], r[1]] + [1.0 if r[2] == k else 0.0 for k in cantons[1:]] for r in rows])
            y = np.array([r[3] for r in rows])
            b, *_ = np.linalg.lstsq(X, y, rcond=None)
            resid = y - X @ b
            r2 = float(1 - resid.var() / y.var())
            if b[1] < 0:  # only accept an economically sensible (negative) gradient
                beta, fitted = float(b[1]), True
            # Full fit is kept regardless, so the frontend can compute each place's
            # residual ("cheap or expensive for its access") = log(price) - prediction.
            fit = {
                "alpha": round(float(b[0]), 5),
                "beta": round(float(b[1]), 6),
                "gamma": round(float(b[2]), 6),       # per tax-multiplier point
                "fe": {k: round(float(v), 4) for k, v in zip(cantons[1:], b[3:])},
                "sigma": round(float(resid.std()), 4),
            }
        anchors[city] = {
            "name": c["name"], "lat": c["lat"], "lon": c["lon"],
            "beta": round(beta, 6),            # d log(price) / d minute of effective commute (uplift)
            "pct_per_10min": round(100 * (1 - math.exp(beta * 10)), 1),
            "r2": round(r2, 3) if r2 is not None else None,
            "n": n,
            "fitted": fitted,
            "fit": fit,
        }
        print(f"{city:11s} n={n:4d} beta={beta:+.5f} ({anchors[city]['pct_per_10min']}%/10min) "
              f"r2={r2 if r2 is None else round(r2, 2)} {'' if fitted else '[fallback]'}")

    data = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "n_settlements": len(out_settlements),
            "gradient_model": "log(price/m2) ~ effective_commute_min + tax_multiplier + canton FE, "
                              "municipalities with market prices within 100 car-min of anchor",
        },
        "anchors": anchors,
        "settlements": out_settlements,
    }
    out = FRONTEND_DATA_DIR / "sleeper.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Saved {out} ({out.stat().st_size / 1e6:.2f} MB, {len(out_settlements)} settlements)")


if __name__ == "__main__":
    main()
