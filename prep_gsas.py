#!/usr/bin/env python3
"""Fetch GSA boundaries for the Tulare Lake Subbasin + every surrounding subbasin.

Source: DWR SGMA authoritative service
  boundaries/i03_Groundwater_Sustainability_Agencies (FeatureServer/0)
Writes two versions with a short `subbasin` property for styling:
  data/surrounding_gsas.geojson         — generalized ~33 m, loaded for the overview
  data/surrounding_gsas_detail.geojson  — full resolution, lazy-loaded when zoomed in
"""
import json, urllib.request, urllib.parse, os

SVC = ("https://gis.water.ca.gov/arcgis/rest/services/boundaries/"
       "i03_Groundwater_Sustainability_Agencies/FeatureServer/0/query")
DATA = os.path.join(os.path.dirname(__file__), "data")

# Tulare Lake and the subbasins that ring it.
SUBBASINS = [
    "SAN JOAQUIN VALLEY - TULARE LAKE",
    "SAN JOAQUIN VALLEY - KINGS",
    "SAN JOAQUIN VALLEY - KAWEAH",
    "SAN JOAQUIN VALLEY - TULE",
    "SAN JOAQUIN VALLEY - KERN COUNTY",
    "SAN JOAQUIN VALLEY - WESTSIDE",
    "SAN JOAQUIN VALLEY - PLEASANT VALLEY",
]


def short(name):
    return name.split(" - ", 1)[1].title() if " - " in name else name


def fetch(offset=None):
    where = "Basin_Subbasin_Name IN (" + ",".join("'" + s + "'" for s in SUBBASINS) + ")"
    q = {
        "where": where,
        "outFields": "GSA_Name,Basin_Subbasin_Name,POC_Name,POC_Phone,POC_Email,GSA_URL",
        "outSR": "4326",
        "f": "geojson",
        "returnGeometry": "true",
    }
    if offset:
        q["maxAllowableOffset"] = str(offset)   # degrees of server-side generalization
    url = SVC + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "GreenAcres-InSAR-map/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        gj = json.load(r)
    for ft in gj.get("features", []):
        p = ft.setdefault("properties", {})
        p["subbasin"] = short(p.get("Basin_Subbasin_Name", ""))
    return gj


def write(name, gj):
    path = os.path.join(DATA, name)
    json.dump(gj, open(path, "w"))
    print(f"wrote {name}  ({len(gj.get('features', []))} GSAs, {os.path.getsize(path)//1024} KB)")
    return gj


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    gj = write("surrounding_gsas.geojson", fetch(offset=0.0003))   # generalized overview
    write("surrounding_gsas_detail.geojson", fetch(offset=None))    # full resolution
    import collections
    by = collections.Counter(ft["properties"]["subbasin"] for ft in gj["features"])
    for sb, n in sorted(by.items()):
        print(f"  {sb}: {n}")
