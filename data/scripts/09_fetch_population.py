"""
Population growth per municipality from the BFS STAT-TAB cube
"Demografische Bilanz nach institutionellen Gliederungen" (px-x-0102020000_201).

growth_pct = resident population 31 Dec YEAR1 vs YEAR0, in percent.

Output: data/processed/population.json  { bfs_id: {pop_y0, pop_y1, growth_pct} }
"""
import json
import sys

import requests

from config import PROCESSED_DIR

URL = "https://www.pxweb.bfs.admin.ch/api/v1/de/px-x-0102020000_201/px-x-0102020000_201.px"
Y0, Y1 = "2013", "2023"
GEO = "Kanton (-) / Bezirk (>>) / Gemeinde (......)"

QUERY = {
    "query": [
        {"code": "Jahr", "selection": {"filter": "item", "values": [Y0, Y1]}},
        {"code": GEO, "selection": {"filter": "all", "values": ["*"]}},  # omitted dims get aggregated away
        {"code": "Staatsangehörigkeit (Kategorie)", "selection": {"filter": "item", "values": ["0"]}},
        {"code": "Geschlecht", "selection": {"filter": "item", "values": ["0"]}},
        {"code": "Demografische Komponente", "selection": {"filter": "item", "values": ["16"]}},  # Bestand 31. Dezember
    ],
    "response": {"format": "json-stat2"},
}


def main():
    r = requests.post(URL, json=QUERY, timeout=180)
    r.raise_for_status()
    d = r.json()
    dims = d["id"]
    sizes = d["size"]
    strides = [1] * len(dims)
    for i in range(len(dims) - 2, -1, -1):
        strides[i] = strides[i + 1] * sizes[i + 1]
    cat = {k: d["dimension"][k]["category"] for k in dims}
    idx_of = {k: cat[k]["index"] for k in dims}
    # json-stat2 dimension ids differ from the PX codes: locate the geo and year dims by content
    geo = next(k for k in dims if any(str(l).startswith("......") for l in cat[k]["label"].values()))
    year = next(k for k in dims if Y0 in idx_of[k] and Y1 in idx_of[k])
    labels = cat[geo]["label"]
    values = d["value"]

    def at(**sel):
        flat = 0
        for k, code in sel.items():
            flat += idx_of[k][code] * strides[dims.index(k)]
        return values[flat]

    fixed = {k: next(iter(idx_of[k])) for k in dims if k not in (geo, year)}
    out = {}
    for code, label in labels.items():
        if not str(label).startswith("......"):
            continue
        bfs_id = label[6:10]
        p0 = at(**{geo: code, year: Y0}, **fixed)
        p1 = at(**{geo: code, year: Y1}, **fixed)
        if p0 and p1:
            out[bfs_id] = {f"pop_{Y0}": p0, f"pop_{Y1}": p1, "growth_pct": round((p1 / p0 - 1) * 100, 1)}

    path = PROCESSED_DIR / "population.json"
    with open(path, "w") as f:
        json.dump(out, f)
    g = sorted(v["growth_pct"] for v in out.values())
    print(f"Saved {path}: {len(out)} municipalities, growth {Y0}->{Y1} median {g[len(g)//2]}%, p10 {g[len(g)//10]}%, p90 {g[9*len(g)//10]}%")


if __name__ == "__main__":
    sys.exit(main())
