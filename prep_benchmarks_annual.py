#!/usr/bin/env python3
"""Enrich Tulare Lake + Kaweah benchmarks with the full annual-report series.

DWR's GSP-Monitoring export (what prep_benchmarks.py pulls) has almost no measurements for these
subbasins — most benchmarks show 1–2 points or none. The real per-benchmark history lives in the
annual-report PDFs and is consolidated in the sibling repo `sgma-annual-report-data`
(data/benchmark_displacement_annual.csv). This builds a cumulative subsidence series per benchmark
and merges it into the map (negative = subsidence, matching the survey monuments).

Run AFTER prep_benchmarks.py:
    python3 prep_benchmarks.py            # DWR base layer
    python3 prep_benchmarks_annual.py     # enrich Tulare Lake + Kaweah from annual reports

Two subbasins, two bases (see sgma-annual-report-data/SURVEY_BASIS.md):
- Tulare Lake: per-WY average annual change (WY2020–22 map-figure labels) chained with Fall-to-Fall
  releveling (WY2022→2025, Table E-1), cumulative from 2019, preferring the surveyed value.
- Kaweah: per-benchmark ground-surface elevations (2020/2022/2023/2024/2025); displacement =
  elevation − 2020 baseline. Directly measured, cumulative from 2020.
Both are best-effort stitched estimates, flagged as such in-popup. Coordinates come from the
existing map features by name-match (the reports carry none); Tulare Lake also has coords in-CSV.
"""
import csv, json, os, re
from collections import defaultdict

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "data")
AR_CSV = os.path.join(HERE, "..", "sgma-annual-report-data", "data",
                      "benchmark_displacement_annual.csv")

# Tulare Lake: (label, start_dy, end_dy, [(report_year, metric) preference order])
TL_PERIODS = [
    ("WY2020", 2019.75, 2020.75, [("WY2020", "WY2020 Average Annual Change (ft)")]),
    ("WY2021", 2020.75, 2021.75, [("WY2021", "WY2021 Average Annual Change (ft)"),
                                  ("WY2022", "WY2021 Average Annual Change (ft)")]),
    ("WY2022", 2021.87, 2022.87, [("WY2023", "Fall 2021 to Fall 2022 (feet)"),
                                  ("WY2022", "WY2022 Average Annual Change (ft)")]),
    ("WY2023", 2022.87, 2023.87, [("WY2025", "Fall 2022 to Fall 2023 (feet)"),
                                  ("WY2024", "Fall 2022 to Fall 2023 (feet)"),
                                  ("WY2023", "Fall 2022 to Fall 2023 (feet)")]),
    ("WY2024", 2023.87, 2024.87, [("WY2025", "Fall 2023 to Fall 2024 (feet)"),
                                  ("WY2024", "Fall 2023 to Fall 2024 (feet)")]),
    ("WY2025", 2024.87, 2025.87, [("WY2025", "Fall 2024 to Fall 2025 (feet)")]),
]


def norm(name):
    return (name or "").replace("(RMS)", "").replace("(rms)", "").strip().upper()


def canon(sid):
    return (sid or "").replace("(RMS)", "").strip()


def rows_for(subbasin):
    for r in csv.DictReader(open(AR_CSV)):
        if r["subbasin"] == subbasin:
            yield r


def build_tulare():
    val, coords = {}, {}
    for r in rows_for("Tulare Lake"):
        st = canon(r["station_id"])
        if r["value"] not in ("", None, "None"):
            val[(st, r["report_year"], r["metric"])] = float(r["value"])
        if r["latitude"] and r["longitude"]:
            try:
                coords[norm(st)] = [round(float(r["longitude"]), 6), round(float(r["latitude"]), 6)]
            except ValueError:
                pass
    series = {}
    for st in sorted({k[0] for k in val}):
        cum, pts, started = 0.0, [], False
        for _, start, end, prefs in TL_PERIODS:
            inc = next((val[(st, ry, mt)] for ry, mt in prefs if (st, ry, mt) in val), None)
            if inc is None:
                continue
            if not started:
                pts.append([start, 0.0]); started = True
            cum = round(cum + inc, 4)
            pts.append([round(end, 2), cum])
        if len(pts) >= 2:
            series[st] = pts
    return series, coords


def build_elev(subbasin, month_frac):
    """Elevation-based subbasins (Kaweah, Tule): displacement = elevation(year) − earliest-year
    elevation; negative = subsidence. Coordinates taken from the CSV when present (Tule), else {}
    (Kaweah has none in-CSV and is name-matched to existing map features)."""
    elev, coords = defaultdict(dict), {}
    for r in rows_for(subbasin):
        st = canon(r["station_id"])
        m = re.match(r"(20\d\d) Elevation", r["metric"])
        if m and r["value"] not in ("", None, "None"):
            e = float(r["value"])
            if 50 < e < 700:   # real amsl elevations; 0/blank is bad data
                elev[st][int(m.group(1))] = e
        if r["latitude"] and r["longitude"] and st not in coords:
            try:
                coords[norm(st)] = [round(float(r["longitude"]), 6), round(float(r["latitude"]), 6)]
            except ValueError:
                pass
    series = {}
    for st, ys in elev.items():
        base = ys[min(ys)]
        pts = [[round(y + month_frac, 2), round(ys[y] - base, 4)] for y in sorted(ys)]
        if len(pts) >= 2:
            series[st] = pts
    return series, coords


def merge(geo, bser, series, coords, basin_key, basin_full, source, next_id):
    by_norm = {norm(st): st for st in series}
    matched, enriched = set(), 0
    for f in geo["features"]:
        p = f["properties"]
        if basin_key not in (p.get("basin") or ""):
            continue
        st = by_norm.get(norm(p.get("name")))
        if not st:
            continue
        s = series[st]
        bser[p["id"]] = s
        p["npts"] = len(s); p["change"] = round(s[-1][1] - s[0][1], 3); p["source"] = source
        enriched += 1; matched.add(st)
    added = 0
    for st, s in series.items():
        if st in matched or norm(st) not in coords:
            continue
        next_id += 1; sid = str(next_id)
        bser[sid] = s
        geo["features"].append({"type": "Feature", "properties": {
            "id": sid, "name": st, "site_type": "Surveying/Benchmark Sites", "basin": basin_full,
            "gsa": "", "network": "SGMA Representative", "npts": len(s),
            "change": round(s[-1][1] - s[0][1], 3), "source": source},
            "geometry": {"type": "Point", "coordinates": coords[norm(st)]}})
        added += 1
    return matched, enriched, added, next_id


def main():
    geo = json.load(open(os.path.join(DATA, "benchmarks.geojson")))
    bser = json.load(open(os.path.join(DATA, "benchmark_series.json")))
    next_id = max((int(p["properties"]["id"]) for p in geo["features"]
                   if str(p["properties"]["id"]).isdigit()), default=1000)
    configs = [
        (build_tulare, "Tulare Lake", "5-022.12 Tulare Lake", "SGMA annual reports (WY2020–25)"),
        (lambda: build_elev("Kaweah", 0.8), "Kaweah", "5-022.11 Kaweah", "Kaweah annual reports (WY2023–25)"),
        (lambda: build_elev("Tule", 0.55), "Tule", "5-022.13 Tule", "Tule annual reports (WY2024–25)"),
    ]
    for build, key, full, source in configs:
        series, coords = build()
        matched, enriched, added, next_id = merge(geo, bser, series, coords, key, full, source, next_id)
        unplaced = len(series) - len(matched) - added
        print(f"{key}: {len(series)} stations w/ series — {len(matched)} matched map benchmarks "
              f"({enriched} features), {added} added, {unplaced} unplaced (no coords).")

    json.dump(geo, open(os.path.join(DATA, "benchmarks.geojson"), "w"))
    json.dump(bser, open(os.path.join(DATA, "benchmark_series.json"), "w"))


if __name__ == "__main__":
    main()
