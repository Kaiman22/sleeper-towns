#!/usr/bin/env python3
"""Build the static dataset for "which places become commutable with a self-driving car".

Only directly queried travel times, no model, no correction factor:
  car  Google Maps Routes API, TRAFFIC_AWARE, departure Tue 2026-03-17 07:30
       (02h_fetch_driving_times_google.py -> settlement_travel_times_driving.json)
  pt   SBB timetable via transport.opendata.ch, fastest of the next 4 connections
       departing from Mon 2026-03-16 07:00, door to door incl. walks and transfers,
       no wait before the first departure
       (02g_fetch_pt_breakdown.py -> settlement_pt_breakdown.json)

Both are measured from the same settlement point (swissNAMES3D) to the main station of
each of the 10 anchor cities, in the commuting direction. Car-free settlements (Zermatt,
Wengen, ...) have no car time.

Output: frontend/public/data/commute.json
  hubs:   [ { id, n, station, lat, lon } ]                        destinations
  places: [ { n, alt?, m, mid, kt, lat, lon, pc } ]               one per settlement
  car:    { hubId: [minutes | null per place] }
  pt:     { hubId: [minutes | null per place] }
  pop:    labels for pc (swissNAMES3D population category, residents)

Usage: python3 10_build_commute_data.py
"""
import json
from datetime import date

from config import CITIES, FRONTEND_DATA_DIR, PROCESSED_DIR

# Display names and stations (stations as queried in 02g); chip order in the UI
HUBS = {
    "zurich": ("Zürich", "Zürich HB"),
    "bern": ("Bern", "Bern"),
    "basel": ("Basel", "Basel SBB"),
    "geneve": ("Genève", "Genève"),
    "lausanne": ("Lausanne", "Lausanne"),
    "luzern": ("Luzern", "Luzern"),
    "stgallen": ("St. Gallen", "St. Gallen"),
    "winterthur": ("Winterthur", "Winterthur"),
    "lugano": ("Lugano", "Lugano"),
    "biel": ("Biel/Bienne", "Biel/Bienne"),
}

# swissNAMES3D categories, smallest first
POP = ["100 bis 999", "1'000 bis 1'999", "2'000 bis 9'999",
       "10'000 bis 49'999", "50'000 bis 100'000", "> 100'000"]
POP_LABELS = ["100–999", "1'000–1'999", "2'000–9'999",
              "10'000–49'999", "50'000–100'000", "über 100'000"]


def main():
    points = json.load(open(PROCESSED_DIR / "settlement_points.json"))
    car_s = json.load(open(PROCESSED_DIR / "settlement_travel_times_driving.json"))
    pt_bd = json.load(open(PROCESSED_DIR / "settlement_pt_breakdown.json"))
    assert set(HUBS) == set(CITIES), "hub list out of sync with config.CITIES"

    # settlement_points has one row per name; multilingual places share a uuid
    # (Chur / Coira / Coire / Cuira). Prefer the name matching the municipality
    # ("Ilanz/Glion" -> Ilanz, "Laax" -> Laax GR), else the first listed.
    by_uuid = {}
    for s in points:
        by_uuid.setdefault(s["uuid"], []).append(s)

    def name_rank(r):
        n, m = r["name"], r["municipality_name"]
        return 0 if n == m else 1 if m.startswith(n) or n.startswith(m) else 2

    places, uuids = [], []
    for uuid, rows in by_uuid.items():
        main_row = min(rows, key=name_rank)  # stable: ties keep the listed order
        p = {
            "n": main_row["name"],
            "m": main_row["municipality_name"],
            "mid": main_row["municipality_id"],
            "kt": main_row["canton"],
            "lat": round(main_row["lat"], 5),
            "lon": round(main_row["lon"], 5),
            "pc": POP.index(main_row["pop_category"]),
        }
        alt = [r["name"] for r in rows if r["name"] != p["n"]]
        if alt:
            p["alt"] = alt
        places.append(p)
        uuids.append(uuid)

    car, pt = {}, {}
    for h in HUBS:
        car[h] = [
            round(v / 60) if (v := (car_s.get(u) or {}).get(h)) else None
            for u in uuids
        ]
        pt[h] = [
            round(v / 60) if (v := (((pt_bd.get(u) or {}).get(h)) or {}).get("total_s")) else None
            for u in uuids
        ]

    out = {
        "meta": {
            "generated": date.today().isoformat(),
            "car": "Google Maps Routes API, TRAFFIC_AWARE, departure Tue 2026-03-17 07:30",
            "pt": "SBB timetable (transport.opendata.ch), fastest of next 4 connections from Mon 2026-03-16 07:00",
            "from": "swissNAMES3D settlement point",
            "to": "main station of the destination city",
        },
        "pop": POP_LABELS,
        "hubs": [
            {"id": h, "n": n, "station": st, "lat": CITIES[h]["lat"], "lon": CITIES[h]["lon"]}
            for h, (n, st) in HUBS.items()
        ],
        "places": places,
        "car": car,
        "pt": pt,
    }
    path = FRONTEND_DATA_DIR / "commute.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))

    print(f"{len(places)} places, {len(HUBS)} destinations -> {path} ({path.stat().st_size / 1e3:.0f} KB)")
    for h in HUBS:
        nc = sum(v is None for v in car[h])
        npt = sum(v is None for v in pt[h])
        print(f"  {h:10s} no car time: {nc:3d} (car-free)   no PT connection: {npt}")


if __name__ == "__main__":
    main()
