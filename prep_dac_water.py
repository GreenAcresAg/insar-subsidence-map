#!/usr/bin/env python3
"""Fetch community-protection layers for the study area:

  data/dac_tracts.geojson    — SB 535 Disadvantaged Communities (CalEPA / OEHHA, 2022)
  data/water_systems.geojson — community public water-system service areas (SWRCB SABL)

SB 535 DAC is used because DWR's income-based DAC service (gis.water.ca.gov) is
currently offline; swap that endpoint in here if it comes back.
"""
import json, urllib.request, urllib.parse, os

DATA = os.path.join(os.path.dirname(__file__), "data")
BBOX = (35.3, -120.3, 36.9, -118.6)   # S, W, N, E

DAC = ("https://services1.arcgis.com/PCHfdHz4GlDNAhBb/arcgis/rest/services/"
       "SB_535_Disadvantaged_Communities_2022/FeatureServer/0/query")
SABL = ("https://gispublic.waterboards.ca.gov/portalserver/rest/services/Drinking_Water/"
        "California_Drinking_Water_System_Area_Boundaries/FeatureServer/0/query")


def fetch(url, where, out_fields, offset="0.0003"):
    s, w, n, e = BBOX
    q = urllib.parse.urlencode({
        "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
        "inSR": "4326", "outSR": "4326", "spatialRel": "esriSpatialRelIntersects",
        "where": where, "outFields": out_fields,
        "returnGeometry": "true", "f": "geojson", "maxAllowableOffset": offset,
    })
    req = urllib.request.Request(url + "?" + q, headers={"User-Agent": "GreenAcres-InSAR-map/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def write(name, gj):
    path = os.path.join(DATA, name)
    json.dump(gj, open(path, "w"))
    print(f"wrote {name}  ({len(gj.get('features', []))} features, "
          f"{os.path.getsize(path)//1024} KB, truncated={gj.get('exceededTransferLimit')})")


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    write("dac_tracts.geojson", fetch(DAC, "1=1", "Tract,CIscoreP"))
    write("water_systems.geojson",
          fetch(SABL, "FEDERAL_CLASSIFICATION='COMMUNITY' AND ACTIVITY_STATUS_CD LIKE 'A%'",
                "WATER_SYSTEM_NAME,POPULATION,SERVICE_CONNECTIONS,AC_PHONE_NUMBER,AC_EMAIL,"
                "REGULATING_AGENCY,OWNER_TYPE_CODE,ADDR_LINE_ONE_TXT,ADDRESS_CITY_NAME"))
    print("Done.")
