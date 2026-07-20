#!/usr/bin/env python3
"""Continuous GPS (CGPS) stations in the study area + vertical time series.

Source: Nevada Geodetic Laboratory (UNR / EarthScope), IGS20 24h final solutions.
  Station list: https://geodesy.unr.edu/NGLStationPages/DataHoldings.txt
  Time series:  https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/IGS20/<STA>.tenv3

Writes:
  data/cgps_stations.geojson  — station points (id, name, span, total vertical change ft)
  data/cgps_series.json       — { STA: [[decimal_year, cum_vertical_ft], ...] }  (monthly)

Vertical series is cumulative change (feet) relative to the first month; negative = subsidence.
"""
import json, os, urllib.request, statistics
from collections import defaultdict

DATA = os.path.join(os.path.dirname(__file__), "data")
BBOX = (35.3, -120.3, 36.9, -118.6)   # S, W, N, E
HOLDINGS = "https://geodesy.unr.edu/NGLStationPages/DataHoldings.txt"
TENV3 = "https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/IGS20/{sta}.tenv3"
M_TO_FT = 3.280839895


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "GreenAcres-InSAR-map/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def stations_in_bbox():
    s, w, n, e = BBOX
    out = []
    for i, line in enumerate(get(HOLDINGS).splitlines()):
        if i == 0:
            continue
        p = line.split()
        if len(p) < 9:
            continue
        try:
            lat, lon = float(p[1]), float(p[2])
        except ValueError:
            continue
        lon = lon - 360 if lon > 180 else lon
        if s <= lat <= n and w <= lon <= e:
            out.append({"sta": p[0], "lat": round(lat, 5), "lon": round(lon, 5),
                        "start": p[7], "end": p[8]})
    return out


def vertical_series(sta):
    """Return monthly [[decimal_year, cum_ft], ...] relative to first month."""
    try:
        txt = get(TENV3.format(sta=sta), timeout=60)
    except Exception as ex:
        print(f"  {sta}: fetch failed ({ex})")
        return None
    monthly = defaultdict(list)   # 'YYYY-MM' -> [up_m, ...]
    yr_of = {}
    for i, line in enumerate(txt.splitlines()):
        if i == 0:
            continue
        p = line.split()
        if len(p) < 13:
            continue
        try:
            yr = float(p[2]); up = float(p[11]) + float(p[12])
        except ValueError:
            continue
        ym = p[1][:5]   # YYMMM tag groups by month
        monthly[ym].append(up)
        yr_of[ym] = yr
    if not monthly:
        return None
    pts = sorted(((yr_of[ym], statistics.median(v)) for ym, v in monthly.items()))
    ref = pts[0][1]
    return [[round(y, 4), round((u - ref) * M_TO_FT, 3)] for y, u in pts]


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    stas = stations_in_bbox()
    print(f"{len(stas)} CGPS stations in bbox; fetching series…")
    feats, series = [], {}
    for i, st in enumerate(stas, 1):
        s = vertical_series(st["sta"])
        if not s or len(s) < 6:      # need a few months to be useful
            print(f"  [{i}/{len(stas)}] {st['sta']}: skipped (sparse)")
            continue
        series[st["sta"]] = s
        feats.append({"type": "Feature",
            "properties": {"sta": st["sta"], "start": st["start"], "end": st["end"],
                           "npts": len(s), "change_ft": s[-1][1], "source": "NGL / EarthScope"},
            "geometry": {"type": "Point", "coordinates": [st["lon"], st["lat"]]}})
        print(f"  [{i}/{len(stas)}] {st['sta']}: {len(s)} mo, {s[-1][1]:+.2f} ft")
    json.dump({"type": "FeatureCollection", "features": feats},
              open(os.path.join(DATA, "cgps_stations.geojson"), "w"))
    json.dump(series, open(os.path.join(DATA, "cgps_series.json"), "w"))
    kb = lambda f: os.path.getsize(os.path.join(DATA, f)) // 1024
    print(f"wrote {len(feats)} stations — cgps_stations.geojson ({kb('cgps_stations.geojson')} KB), "
          f"cgps_series.json ({kb('cgps_series.json')} KB)")
