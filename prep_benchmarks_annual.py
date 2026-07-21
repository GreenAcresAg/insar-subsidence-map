#!/usr/bin/env python3
"""Enrich the Tulare Lake benchmarks with the full annual-report series (WY2020–WY2025).

DWR's GSP-Monitoring export (what prep_benchmarks.py pulls) has almost no measurements for the
Tulare Lake subbasin — most benchmarks show 1–2 points or none. The real per-benchmark history
lives in the annual-report PDFs and is consolidated in the sibling repo `sgma-annual-report-data`
(data/benchmark_displacement_annual.csv). This script builds a cumulative subsidence series per
benchmark from those annual increments and merges it into the map's benchmarks.

Run AFTER prep_benchmarks.py:
    python3 prep_benchmarks.py            # DWR base layer
    python3 prep_benchmarks_annual.py     # enrich Tulare Lake from annual reports

Series basis (see sgma-annual-report-data/SURVEY_BASIS.md): the reports give two metrics —
per-water-year "Average Annual Change" (WY2020–WY2022, map-figure labels) and Fall-to-Fall
releveling (WY2022→2025, Table E-1). Both are ~annual increments in feet; we chain them into one
cumulative curve (0 at the start of the first available year), preferring the surveyed
Fall-to-Fall value where a year has both. This is a stitched estimate, flagged as such in-popup.
"""
import csv, json, os

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "data")
AR_CSV = os.path.join(HERE, "..", "sgma-annual-report-data", "data",
                      "benchmark_displacement_annual.csv")

# (label, start_decimalyear, end_decimalyear, [(report_year, metric) preference order])
PERIODS = [
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


def build():
    # value lookup + coordinates from the consolidated annual-report CSV (Tulare Lake only).
    # Canonicalize station ids: the same benchmark is labelled e.g. "CRCN" some years and
    # "CRCN (RMS)" in others — collapse them so the series doesn't split.
    def canon(sid):
        return (sid or "").replace("(RMS)", "").strip()

    val, coords = {}, {}
    for r in csv.DictReader(open(AR_CSV)):
        if r["subbasin"] != "Tulare Lake":
            continue
        st = canon(r["station_id"])
        v = r["value"]
        if v not in ("", None, "None"):
            val[(st, r["report_year"], r["metric"])] = float(v)
        if r["latitude"] and r["longitude"]:
            try:
                coords[norm(st)] = [round(float(r["longitude"]), 6),
                                    round(float(r["latitude"]), 6)]
            except ValueError:
                pass
    stations = sorted({k[0] for k in val})

    # cumulative series per station by chaining available annual increments
    series = {}
    for st in stations:
        cum, pts, started = 0.0, [], False
        for _, start, end, prefs in PERIODS:
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


def main():
    geo = json.load(open(os.path.join(DATA, "benchmarks.geojson")))
    bser = json.load(open(os.path.join(DATA, "benchmark_series.json")))
    series, coords = build()
    by_norm = {norm(st): st for st in series}

    enriched, matched = 0, set()
    for f in geo["features"]:
        p = f["properties"]
        if "Tulare Lake" not in (p.get("basin") or ""):
            continue
        st = by_norm.get(norm(p.get("name")))
        if not st:
            continue
        s = series[st]
        bser[p["id"]] = s
        p["npts"] = len(s)
        p["change"] = round(s[-1][1] - s[0][1], 3)
        p["source"] = "SGMA annual reports (WY2020–25)"
        enriched += 1
        matched.add(st)

    # add annual-report benchmarks that have no existing map feature
    added = 0
    next_id = max((int(p["properties"]["id"]) for p in geo["features"]
                   if str(p["properties"]["id"]).isdigit()), default=1000)
    for st, s in series.items():
        if st in matched:
            continue
        c = coords.get(norm(st))
        if not c:
            continue  # can't place it without coordinates
        next_id += 1
        sid = str(next_id)
        bser[sid] = s
        geo["features"].append({
            "type": "Feature",
            "properties": {"id": sid, "name": st, "site_type": "Surveying/Benchmark Sites",
                           "basin": "5-022.12 Tulare Lake", "gsa": "", "network": "SGMA Representative",
                           "npts": len(s), "change": round(s[-1][1] - s[0][1], 3),
                           "source": "SGMA annual reports (WY2020–25)"},
            "geometry": {"type": "Point", "coordinates": c}})
        added += 1

    json.dump(geo, open(os.path.join(DATA, "benchmarks.geojson"), "w"))
    json.dump(bser, open(os.path.join(DATA, "benchmark_series.json"), "w"))
    unplaced = len(series) - len(matched) - added
    print(f"{len(series)} stations have an annual-report series: "
          f"{len(matched)} matched existing map benchmarks ({enriched} features updated, "
          f"incl. duplicate registrations), {added} added as new points, "
          f"{unplaced} unplaced (no coordinates).")


if __name__ == "__main__":
    main()
