#!/usr/bin/env python3
"""GSA subsidence benchmarks reported to DWR + their historical displacement series.

Source: DWR "GSP Monitoring Data" (data.cnra.ca.gov/dataset/gspmd) — subsidence monitoring
sites and measurements GSAs submit to DWR via the SGMA Portal (used in annual reports).
  Subsidence Sites CSV + Subsidence Data CSV (CUM_DISPLACE_ELEV over DATE_OF_MEASUREMENT).

Writes:
  data/benchmarks.geojson      — benchmark points (id, name, GSA, subbasin, site type, change)
  data/benchmark_series.json   — { site_id: [[decimal_year, cum_displacement], ...] }
"""
import csv, io, json, os, subprocess
from collections import defaultdict
from datetime import datetime

DATA = os.path.join(os.path.dirname(__file__), "data")
BBOX = (35.3, -120.3, 36.9, -118.6)   # S, W, N, E
# Physical benchmarks only (exclude Remote Sensing/InSAR — the map already shows that — and
# Continuous GPS, which is its own layer).
PHYSICAL_TYPES = {"Surveying/Benchmark Sites", "Extensometer"}
BASE = "https://data.cnra.ca.gov/dataset/536dc423-01b3-4094-bdcd-903df84f6768/resource"
SITES_CSV = f"{BASE}/8405de2b-a4bb-4ffd-a9bc-b65e96bc2735/download/subsidence_sites.csv"
DATA_CSV  = f"{BASE}/a79c5e73-2a52-4aa7-affa-5d5fecb94cc3/download/subsidence_data.csv"


def fetch_csv(url):
    # CKAN redirects to storage that rejects urllib (403); curl -L handles it.
    out = subprocess.run(["curl", "-sL", "--max-time", "120", url],
                         capture_output=True, text=True, check=True).stdout
    return list(csv.DictReader(io.StringIO(out)))


def dec_year(iso):
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d")
    except ValueError:
        return None
    start = datetime(d.year, 1, 1)
    return round(d.year + (d - start).days / 365.25, 4)


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    s, w, n, e = BBOX

    # Sites (dedupe by GENERAL_SITE_ID, prefer a row that names a GSP)
    sites = {}
    for r in fetch_csv(SITES_CSV):
        try:
            lat, lon = float(r["LATITUDE"]), float(r["LONGITUDE"])
        except (ValueError, KeyError):
            continue
        if not (s <= lat <= n and w <= lon <= e):
            continue
        if r.get("SITE_TYPE", "") not in PHYSICAL_TYPES:
            continue
        sid = r["GENERAL_SITE_ID"]
        if sid not in sites or (r.get("GSP_NAME") and not sites[sid]["_gsp"]):
            sites[sid] = {
                "id": sid, "name": r.get("LOCAL_SITE_NAME", ""),
                "site_type": r.get("SITE_TYPE", ""), "basin": r.get("BASIN_NAME", ""),
                "gsa": r.get("GSA_NAME", ""), "network": r.get("MONITORING_NETWORK_TYPE", ""),
                "lat": round(lat, 6), "lon": round(lon, 6), "_gsp": r.get("GSP_NAME", ""),
            }
    print(f"{len(sites)} subsidence benchmark sites in bbox")

    # Measurements -> series per site (dedupe by date, keep last value)
    raw = defaultdict(dict)   # sid -> {dec_year: value}
    for r in fetch_csv(DATA_CSV):
        sid = r["GENERAL_SITE_ID"]
        if sid not in sites:
            continue
        y = dec_year(r.get("DATE_OF_MEASUREMENT", ""))
        try:
            v = float(r["CUM_DISPLACE_ELEV"])
        except (ValueError, KeyError, TypeError):
            continue
        if y is not None:
            raw[sid][y] = round(v, 4)

    series, feats = {}, []
    for sid, site in sites.items():
        pts = sorted(raw.get(sid, {}).items())
        change = round(pts[-1][1] - pts[0][1], 3) if len(pts) >= 2 else None
        if pts:
            series[sid] = [[y, v] for y, v in pts]
        feats.append({"type": "Feature",
            "properties": {"id": sid, "name": site["name"], "site_type": site["site_type"],
                           "basin": site["basin"], "gsa": site["gsa"], "network": site["network"],
                           "npts": len(pts), "change": change},
            "geometry": {"type": "Point", "coordinates": [site["lon"], site["lat"]]}})

    json.dump({"type": "FeatureCollection", "features": feats},
              open(os.path.join(DATA, "benchmarks.geojson"), "w"))
    json.dump(series, open(os.path.join(DATA, "benchmark_series.json"), "w"))
    kb = lambda f: os.path.getsize(os.path.join(DATA, f)) // 1024
    withseries = sum(1 for f in feats if f["properties"]["npts"] > 0)
    print(f"wrote {len(feats)} benchmarks ({withseries} with series) — "
          f"benchmarks.geojson ({kb('benchmarks.geojson')} KB), "
          f"benchmark_series.json ({kb('benchmark_series.json')} KB)")
