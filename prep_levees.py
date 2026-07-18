#!/usr/bin/env python3
"""Fetch levees + leveed areas in the study area from the USACE National Levee Database.

Source: USACE NLD Public MapServer
  https://geospatial.sec.usace.army.mil/dls/rest/services/NLD/Public/MapServer
    layer 7  = Alignment Lines (levee centerline)
    layer 16 = Leveed Areas (the area each levee protects)

Writes:
  data/levees.geojson        — levee alignments (lines) for every system in the box
  data/leveed_areas.geojson  — protected areas (polygons)
"""
import json, urllib.request, urllib.parse, os

BASE = "https://geospatial.sec.usace.army.mil/dls/rest/services/NLD/Public/MapServer"
DATA = os.path.join(os.path.dirname(__file__), "data")
# Study area (S, W, N, E) -> ArcGIS envelope xmin,ymin,xmax,ymax
BBOX = (35.3, -120.3, 36.9, -118.6)


def fetch(layer, out_fields):
    s, w, n, e = BBOX
    q = urllib.parse.urlencode({
        "geometry": f"{w},{s},{e},{n}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326", "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "where": "1=1", "outFields": out_fields,
        "returnGeometry": "true", "f": "geojson",
        "maxAllowableOffset": "0.0002",   # ~22 m generalization
    })
    url = f"{BASE}/{layer}/query?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": "GreenAcres-InSAR-map/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def write(name, gj):
    path = os.path.join(DATA, name)
    json.dump(gj, open(path, "w"))
    n = len(gj.get("features", []))
    print(f"wrote {name}  ({n} features, {os.path.getsize(path)//1024} KB)")
    return gj


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    write("levees.geojson",
          fetch(7, "SYSTEM_NAME,SEGMENT_NAME,SYSTEM_TYPE,SPONSORS,RESPONSIBLE_ORGANIZATION,COUNTIES"))
    write("leveed_areas.geojson",
          fetch(16, "SYSTEM_NAME,SPONSORS,RESPONSIBLE_ORGANIZATION,LEVEED_AREA_SQ_MI,FEMA_ACCREDITATION_RATING,COUNTIES"))
    print("Done.")
