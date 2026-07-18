#!/usr/bin/env python3
"""Fetch infrastructure overlays from OpenStreetMap (Overpass) into data/*.geojson.

Produces, for the InSAR subsidence map:
  data/friant_kern_canal.geojson   — canal centerline (MultiLineString)
  data/california_aqueduct.geojson  — canal centerline (MultiLineString)
  data/highways.geojson             — motorway/trunk/primary in the study area
  data/hsr_alignment.geojson        — California High-Speed Rail alignment

The two canals are buffered 1 mile either side at runtime (turf.js). Re-run to refresh.
"""
import json, urllib.request, urllib.parse, time, os

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "GreenAcres-InSAR-map/1.0 (greenacresag@gmail.com)"
DATA = os.path.join(os.path.dirname(__file__), "data")

# Study-area bounding box (S, W, N, E) — Tulare Lake + Tule subbasins and the valley trough.
BBOX = (34.8, -120.8, 37.5, -118.5)
# Tighter box for highways/rail (drops the coast) centred on the two subbasins.
HWY_BBOX = (35.3, -120.3, 36.9, -118.6)


def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as e:
            print(f"  overpass retry {attempt+1}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("Overpass failed: " + query[:60])


def ways_to_lines(elements):
    """Each Overpass way with `out geom` -> a [ [lon,lat], ... ] line."""
    lines = []
    for e in elements:
        if e.get("type") != "way":
            continue
        coords = [[p["lon"], p["lat"]] for p in e.get("geometry", []) if p]
        if len(coords) >= 2:
            lines.append(coords)
    return lines


def multiline_feature(lines, props):
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "MultiLineString", "coordinates": lines}}


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def write(name, obj):
    path = os.path.join(DATA, name)
    with open(path, "w") as f:
        json.dump(obj, f)
    print(f"  wrote {name}  ({os.path.getsize(path)//1024} KB)")


def fetch_canal(name):
    s, w, n, e = BBOX
    q = (f'[out:json][timeout:90];'
         f'way["waterway"="canal"]["name"="{name}"]({s},{w},{n},{e});'
         f'out geom;')
    print(f"Fetching {name}…")
    lines = ways_to_lines(overpass(q)["elements"])
    return multiline_feature(lines, {"name": name})


def fetch_highways():
    s, w, n, e = HWY_BBOX
    q = (f'[out:json][timeout:90];'
         f'(way["highway"~"^(motorway|trunk|primary)$"]({s},{w},{n},{e}););'
         f'out geom;')
    print("Fetching highways…")
    els = overpass(q)["elements"]
    feats = []
    for el in els:
        coords = [[p["lon"], p["lat"]] for p in el.get("geometry", []) if p]
        if len(coords) < 2:
            continue
        t = el.get("tags", {})
        ref = t.get("ref", "")
        # Keep only Interstate / US / CA state routes; drops city streets & county roads.
        if not ref or ref.split()[0] not in ("I", "US", "CA"):
            continue
        feats.append({"type": "Feature",
                      "properties": {"ref": ref, "name": t.get("name", ""),
                                     "class": t.get("highway", "")},
                      "geometry": {"type": "LineString", "coordinates": coords}})
    return fc(feats)


def fetch_railroads():
    s, w, n, e = HWY_BBOX
    q = (f'[out:json][timeout:120];'
         f'(way["railway"="rail"]["usage"="main"]({s},{w},{n},{e}););'
         f'out geom;')
    print("Fetching railroads (mainlines)…")
    els = overpass(q)["elements"]
    feats = []
    for el in els:
        coords = [[p["lon"], p["lat"]] for p in el.get("geometry", []) if p]
        if len(coords) < 2:
            continue
        t = el.get("tags", {})
        feats.append({"type": "Feature",
                      "properties": {"name": t.get("name", ""), "operator": t.get("operator", "")},
                      "geometry": {"type": "LineString", "coordinates": coords}})
    return fc(feats)


def fetch_major_canals():
    # Named canals other than FKC / CA Aqueduct (those get their own buffered layers).
    s, w, n, e = HWY_BBOX
    q = (f'[out:json][timeout:120];'
         f'(way["waterway"="canal"]["name"]({s},{w},{n},{e}););'
         f'out geom;')
    print("Fetching major canals (named)…")
    els = overpass(q)["elements"]
    skip = {"Friant-Kern Canal", "California Aqueduct"}
    feats = []
    for el in els:
        coords = [[p["lon"], p["lat"]] for p in el.get("geometry", []) if p]
        if len(coords) < 2:
            continue
        t = el.get("tags", {})
        name = t.get("name", "")
        if name in skip:
            continue
        feats.append({"type": "Feature",
                      "properties": {"name": name, "operator": t.get("operator", "")},
                      "geometry": {"type": "LineString", "coordinates": coords}})
    return fc(feats)


def fetch_facilities():
    # Critical facilities: prisons, hospitals, and named water/wastewater treatment plants.
    s, w, n, e = HWY_BBOX
    sel = ('node["amenity"~"^(prison|hospital)$"]({b});way["amenity"~"^(prison|hospital)$"]({b});'
           'node["man_made"~"^(wastewater_plant|water_works)$"]({b});way["man_made"~"^(wastewater_plant|water_works)$"]({b});')
    box = f"{s},{w},{n},{e}"
    q = f'[out:json][timeout:120];({sel.format(b=box)});out center tags;'
    print("Fetching critical facilities…")
    els = overpass(q)["elements"]
    feats = []
    for el in els:
        if el.get("type") == "node":
            lon, lat = el.get("lon"), el.get("lat")
        else:
            c = el.get("center", {}); lon, lat = c.get("lon"), c.get("lat")
        if lon is None or lat is None:
            continue
        t = el.get("tags", {})
        name = t.get("name", "")
        if not name:            # drop the many unnamed package plants / tiny features
            continue
        am, mm = t.get("amenity", ""), t.get("man_made", "")
        kind = ("prison" if am == "prison" else "hospital" if am == "hospital"
                else "treatment" if mm in ("wastewater_plant", "water_works") else "other")
        feats.append({"type": "Feature",
                      "properties": {"name": name, "kind": kind,
                                     "operator": t.get("operator", ""),
                                     "phone": t.get("phone", "") or t.get("contact:phone", ""),
                                     "website": t.get("website", "") or t.get("contact:website", "")},
                      "geometry": {"type": "Point", "coordinates": [lon, lat]}})
    return fc(feats)


def fetch_waterways():
    # Valley-floor box (drops the dense high-Sierra streams to the east).
    s, w, n, e = (35.3, -120.3, 36.9, -118.9)
    q = (f'[out:json][timeout:120];'
         f'(way["waterway"="river"]({s},{w},{n},{e});'
         f' way["waterway"="stream"]({s},{w},{n},{e}););'
         f'out geom;')
    print("Fetching rivers & streams…")
    els = overpass(q)["elements"]
    feats = []
    for el in els:
        coords = [[p["lon"], p["lat"]] for p in el.get("geometry", []) if p]
        if len(coords) < 2:
            continue
        t = el.get("tags", {})
        way = t.get("waterway", "")
        name = t.get("name", "")
        # Keep rivers and named streams; drop the thousands of unnamed streamlets.
        if way != "river" and not name:
            continue
        feats.append({"type": "Feature",
                      "properties": {"name": name, "waterway": way},
                      "geometry": {"type": "LineString", "coordinates": coords}})
    return fc(feats)


def fetch_hsr():
    s, w, n, e = BBOX
    # CA High-Speed Rail alignment (under construction), matched by operator.
    q = (f'[out:json][timeout:90];'
         f'(way["operator"~"High.Speed Rail",i]({s},{w},{n},{e}););'
         f'out geom;')
    print("Fetching high-speed rail alignment…")
    lines = ways_to_lines(overpass(q)["elements"])
    return fc([multiline_feature(lines, {"name": "California High-Speed Rail"})])


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    write("friant_kern_canal.geojson", fc([fetch_canal("Friant-Kern Canal")]))
    write("california_aqueduct.geojson", fc([fetch_canal("California Aqueduct")]))
    write("highways.geojson", fetch_highways())
    write("hsr_alignment.geojson", fetch_hsr())
    write("rivers_streams.geojson", fetch_waterways())
    write("railroads.geojson", fetch_railroads())
    write("major_canals.geojson", fetch_major_canals())
    write("facilities.geojson", fetch_facilities())
    print("Done.")
