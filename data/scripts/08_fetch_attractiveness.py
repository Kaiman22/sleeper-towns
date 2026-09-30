"""
Fetch attractiveness / disamenity factors per settlement from free sources.

Per settlement (keyed by swissNAMES3D uuid):
  elev_m      elevation (swisstopo height service) — above ~700 m you escape Mittelland fog
  lake_km     distance to the nearest named lake shore (OpenStreetMap via Overpass)
  mwj_km      distance to the nearest motorway junction (OSM) — early AV service / access
  mw_km       distance to the nearest motorway carriageway (OSM) — noise if very close
  airport_km  distance to the nearest major airport (ZRH / GVA / BSL) — noise proxy

Every source is cached under data/processed/attractiveness/ so a failing source
does not lose the others; re-running only fetches what is missing.

Output: data/processed/settlement_attractiveness.json
"""
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import requests
from scipy.spatial import cKDTree

from config import PROCESSED_DIR

CACHE = PROCESSED_DIR / "attractiveness"
CACHE.mkdir(exist_ok=True)
OUT = PROCESSED_DIR / "settlement_attractiveness.json"

OVERPASS_ENDPOINTS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
HEIGHT_URL = "https://api3.geo.admin.ch/rest/services/height"
AIRPORTS = {"ZRH": (47.4582, 8.5481), "GVA": (46.2381, 6.1090), "BSL": (47.5896, 7.5299)}

Q_JUNCTIONS = """[out:json][timeout:300];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
node["highway"="motorway_junction"](area.ch);
out body;"""
Q_MOTORWAYS = """[out:json][timeout:300];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
way["highway"="motorway"](area.ch);
out geom;"""
Q_LAKES = """[out:json][timeout:600];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
(
  way["natural"="water"]["water"="lake"]["name"](area.ch);
  relation["natural"="water"]["water"="lake"]["name"](area.ch);
);
out geom;"""


def overpass(query, cache_name):
    path = CACHE / f"{cache_name}.json"
    if path.exists():
        with open(path) as f:
            return json.load(f)
    last_err = None
    for ep in OVERPASS_ENDPOINTS:
        try:
            print(f"  Overpass {cache_name} via {ep} ...", flush=True)
            # Overpass instances reject the default python-requests User-Agent (HTTP 406)
            r = requests.post(ep, data=query.encode("utf-8"),
                              headers={"Content-Type": "text/plain", "User-Agent": "sleeper-towns/1.0 (github.com/Kaiman22/sleeper-towns)"},
                              timeout=700)
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code}"
                continue
            data = r.json()
            if "elements" not in data:
                last_err = "no elements"
                continue
            with open(path, "w") as f:
                json.dump(data, f)
            print(f"  -> {len(data['elements'])} elements, cached", flush=True)
            return data
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            time.sleep(5)
    raise RuntimeError(f"Overpass failed for {cache_name}: {last_err}")


def fetch_elevations(settlements):
    path = CACHE / "elevation.json"
    elev = json.load(open(path)) if path.exists() else {}
    todo = [s for s in settlements if s["uuid"] not in elev and s.get("e_lv95") and s.get("n_lv95")]
    print(f"  Elevation: {len(elev)} cached, {len(todo)} to fetch", flush=True)

    def one(s):
        for attempt in range(3):
            try:
                r = requests.get(HEIGHT_URL, params={"easting": s["e_lv95"], "northing": s["n_lv95"]}, timeout=20)
                if r.status_code == 200:
                    return s["uuid"], float(r.json()["height"])
            except Exception:  # noqa: BLE001
                pass
            time.sleep(1 + attempt)
        return s["uuid"], None

    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for fut in as_completed([ex.submit(one, s) for s in todo]):
            uuid, h = fut.result()
            if h is not None:
                elev[uuid] = h
            done += 1
            if done % 250 == 0:
                with open(path, "w") as f:
                    json.dump(elev, f)
                print(f"    {done}/{len(todo)}", flush=True)
    with open(path, "w") as f:
        json.dump(elev, f)
    return elev


# Local equirectangular projection (km) — accurate enough for nearest-distance within CH
LAT0 = 46.8
KX = 111.32 * math.cos(math.radians(LAT0))
KY = 111.32


def proj(lat, lon):
    return (lon * KX, lat * KY)


def _coords(geometry):
    # With a bbox query, `out geom` returns null for vertices outside the bbox
    return [proj(p["lat"], p["lon"]) for p in (geometry or []) if p]


def geom_points(elements):
    """All vertices of ways / relation members as projected points."""
    pts = []
    for el in elements:
        if el["type"] == "way":
            pts.extend(_coords(el.get("geometry")))
        elif el["type"] == "relation":
            for m in el.get("members", []):
                pts.extend(_coords(m.get("geometry")))
    return np.array(pts) if pts else np.zeros((0, 2))


def lake_points(elements):
    """Vertices of lakes that are not mere ponds (bbox diagonal > 700 m)."""
    pts = []
    kept = 0
    for el in elements:
        if el["type"] == "way":
            g = [p for p in (el.get("geometry") or []) if p]
        else:
            g = [p for m in el.get("members", []) for p in (m.get("geometry") or []) if p]
        if len(g) < 8:
            continue
        lats = [p["lat"] for p in g]; lons = [p["lon"] for p in g]
        dx = (max(lons) - min(lons)) * KX; dy = (max(lats) - min(lats)) * KY
        if math.hypot(dx, dy) < 0.7:
            continue
        kept += 1
        pts.extend(proj(p["lat"], p["lon"]) for p in g)
    print(f"  Lakes kept: {kept} (of {len(elements)} named water bodies), {len(pts)} shore vertices", flush=True)
    return np.array(pts)


def nearest_km(tree, settlements):
    if tree is None:
        return [None] * len(settlements)
    q = np.array([proj(s["lat"], s["lon"]) for s in settlements])
    d, _ = tree.query(q)
    return [round(float(x), 2) for x in d]


def main():
    with open(PROCESSED_DIR / "settlement_points.json") as f:
        settlements = json.load(f)
    print(f"{len(settlements)} settlements")

    results = {s["uuid"]: {} for s in settlements}

    print("Elevation (swisstopo)")
    elev = fetch_elevations(settlements)
    for s in settlements:
        results[s["uuid"]]["elev_m"] = round(elev[s["uuid"]]) if s["uuid"] in elev else None

    print("Motorway junctions (OSM)")
    try:
        j = overpass(Q_JUNCTIONS, "junctions")
        pts = np.array([proj(e["lat"], e["lon"]) for e in j["elements"] if "lat" in e])
        for s, d in zip(settlements, nearest_km(cKDTree(pts), settlements)):
            results[s["uuid"]]["mwj_km"] = d
    except Exception as e:  # noqa: BLE001
        print("  skipped:", e)

    print("Motorway carriageways (OSM)")
    try:
        m = overpass(Q_MOTORWAYS, "motorways")
        pts = geom_points(m["elements"])
        for s, d in zip(settlements, nearest_km(cKDTree(pts), settlements)):
            results[s["uuid"]]["mw_km"] = d
    except Exception as e:  # noqa: BLE001
        print("  skipped:", e)

    print("Lakes (OSM)")
    try:
        lk = overpass(Q_LAKES, "lakes")
        pts = lake_points(lk["elements"])
        for s, d in zip(settlements, nearest_km(cKDTree(pts), settlements)):
            results[s["uuid"]]["lake_km"] = d
    except Exception as e:  # noqa: BLE001
        print("  skipped:", e)

    print("Airports")
    ap = np.array([proj(lat, lon) for lat, lon in AIRPORTS.values()])
    for s, d in zip(settlements, nearest_km(cKDTree(ap), settlements)):
        results[s["uuid"]]["airport_km"] = d

    with open(OUT, "w") as f:
        json.dump(results, f)
    have = {k: sum(1 for v in results.values() if v.get(k) is not None) for k in ["elev_m", "lake_km", "mwj_km", "mw_km", "airport_km"]}
    print(f"Saved {OUT}: coverage {have}")


if __name__ == "__main__":
    sys.exit(main())
