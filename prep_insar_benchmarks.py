#!/usr/bin/env python3
"""Give benchmarks a real subsidence series by sampling DWR InSAR at each point — for the subbasins
whose GSP reports carry no coordinate-matched numeric leveling for the mapped benchmarks:

  - Kings: the report only colour-classes benchmarks by InSAR on a map (no numbers at all).
  - Westside: the report DOES tabulate leveling (Table 5-5, "BM #1–26") but those benchmarks have no
    published coordinates and don't match the mapped DWR "SUB0xx" set — so it can't be joined.

Both mapped benchmark sets have accurate coordinates, and DWR's InSAR is authoritative, so we build
each benchmark's cumulative-displacement history by sampling the same DWR "Total displacement since
2015-06-13" ImageServer (TRE ALTAMIRA) the map already displays.

Efficient pattern: one getSamples call per dated catalog raster, every benchmark as a multipoint
(≈130 calls → a full ~2015→2026 series each). Negative = subsidence. Extensometers are skipped
(they're their own aquifer-compaction records).

Run AFTER prep_benchmarks.py (independent of prep_benchmarks_annual.py):
    python3 prep_insar_benchmarks.py
Updates data/benchmarks.geojson + data/benchmark_series.json in place.
"""
import json, os, re, time, urllib.parse, urllib.request
from datetime import datetime

DATA = os.path.join(os.path.dirname(__file__), "data")
SVC = ("https://gis.water.ca.gov/arcgisimg/rest/services/SAR/"
       "Vertical_Displacement_TRE_ALTAMIRA_Total_Since_20150613_Mosaic/ImageServer")
SOURCE = "DWR InSAR (TRE ALTAMIRA) sampled at benchmark"


def http(url, data=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data.encode() if data else None)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(2)


def dec_year(yyyymmdd):
    d = datetime.strptime(yyyymmdd, "%Y%m%d")
    return round(d.year + (d - datetime(d.year, 1, 1)).days / 365.25, 4)


def catalog():
    q = urllib.parse.urlencode({"where": "1=1", "outFields": "OBJECTID,Name",
                                "returnGeometry": "false", "orderByFields": "OBJECTID", "f": "json"})
    feats = http(f"{SVC}/query?{q}")["features"]
    out = []
    for f in feats:
        m = re.search(r"_(\d{8})$", f["attributes"]["Name"])
        if m:
            out.append((f["attributes"]["OBJECTID"], dec_year(m.group(1))))
    return out


def main():
    geo = json.load(open(os.path.join(DATA, "benchmarks.geojson")))
    bser = json.load(open(os.path.join(DATA, "benchmark_series.json")))
    BASINS = ("Kings", "Westside")   # subbasins lacking coordinate-matched numeric leveling
    targets = [f for f in geo["features"]
               if any(b in (f["properties"].get("basin") or "") for b in BASINS)
               and "extensometer" not in (f["properties"].get("site_type") or "").lower()]
    pts = [f["geometry"]["coordinates"] for f in targets]
    print(f"{len(targets)} benchmarks to sample "
          f"({', '.join(sorted({f['properties']['basin'].split()[-1] for f in targets}))})")

    rasters = catalog()
    print(f"{len(rasters)} InSAR dates in catalog")
    series = {i: [] for i in range(len(pts))}   # location index -> [(dy, value)]
    geom = json.dumps({"points": pts, "spatialReference": {"wkid": 4326}})
    for k, (oid, dy) in enumerate(rasters):
        mr = json.dumps({"mosaicMethod": "esriMosaicLockRaster", "lockRasterIds": [oid]})
        body = urllib.parse.urlencode({"geometry": geom, "geometryType": "esriGeometryMultipoint",
                                       "mosaicRule": mr, "f": "json"})
        res = http(f"{SVC}/getSamples", data=body)
        for s in res.get("samples", []):
            try:
                v = float(s["value"])
            except (ValueError, TypeError):
                continue
            series[s["locationId"]].append((dy, round(v, 4)))
        if (k + 1) % 20 == 0:
            print(f"  sampled {k + 1}/{len(rasters)} dates")

    enriched = 0
    for i, f in enumerate(targets):
        pts_i = sorted(series[i])
        if len(pts_i) < 3:
            continue
        sid = f["properties"]["id"]
        bser[sid] = [[dy, v] for dy, v in pts_i]
        f["properties"]["npts"] = len(pts_i)
        f["properties"]["change"] = round(pts_i[-1][1] - pts_i[0][1], 3)
        f["properties"]["source"] = SOURCE
        enriched += 1

    json.dump(geo, open(os.path.join(DATA, "benchmarks.geojson"), "w"))
    json.dump(bser, open(os.path.join(DATA, "benchmark_series.json"), "w"))
    print(f"enriched {enriched} benchmarks with InSAR series.")


if __name__ == "__main__":
    main()
