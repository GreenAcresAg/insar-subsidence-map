# InSAR Land Subsidence Map

Interactive web map of **land subsidence** (vertical ground-surface displacement) for the
**Tulare Lake** and **Tule** subbasins, built by Green Acres Consulting, Inc. Adapts the
GEARS Groundwater Extraction map (MapLibre GL JS, static site).

Displacement imagery is pulled **live** from California DWR's TRE ALTAMIRA InSAR image
services — no data is stored locally.

## What it shows
- **Two datasets** (switchable):
  - **Total displacement** — cumulative vertical change since the 2015-06-13 baseline
    (~132 monthly snapshots through April 2026).
  - **Annual rate** — displacement rate over rolling 12-month windows (~124 windows).
- **Date control** — slider + prev/next + play-through animation. For "Total", pick any
  end date; for "Annual rate", pick any 12-month window.
- **Legend** — DWR's official 9-class ramp, in feet (negative = subsidence, positive = uplift),
  fetched live from the service so it always matches the imagery.
- **Click any point** → reads the displacement value at that location for the selected date
  (via the ImageServer `identify` endpoint).
- **Click any infrastructure** → a popup with its description, the responsible **public
  authority / contact** (levee sponsors, water-system phone/email, known operators for the
  canals/highways/rail), and an **elevation & subsidence** readout: current ground elevation
  (USGS 3DEP), the **change in elevation since the 2015 InSAR base year** (from the Total
  displacement raster at that point), and the approximate 2015 ground elevation.
  For the **Corcoran levee** the popup instead uses the known **192 ft design crest** (raised
  during the 2023 Tulare Lake flooding) applied along the whole length, and shows the
  **effective crest today** = 192 ft − InSAR subsidence since the 2023 raise, at the clicked point.
  Where the clicked cell has no InSAR value (NoData — e.g. water, fallow ground), the
  calculation falls back to the **nearest available InSAR sample** (expanding-ring `getSamples`)
  and notes the distance it interpolated from.
- **Opacity slider**, overlay on/off, and the shared basemap switcher (Esri imagery / hybrid /
  USGS Topo / OpenStreetMap) and fullscreen control.
- **Infrastructure overlays** rendered on top of the subsidence layer, each toggleable:
  - **Friant-Kern Canal** and **California Aqueduct** centerlines, each with a **1-mile buffer**
    either side (2-mile corridor), buffered client-side with turf.js.
  - **Highways** (Interstate / US / CA state routes) and the **California High-Speed Rail**
    alignment.
  - **Rivers & streams** (optional; rivers + named streams), lazy-loaded when first toggled on.
  - **Railroads** (BNSF / UP mainlines) and **major canals & conveyance** (named canals such as
    the Cross Valley Canal; optional, lazy-loaded).
  - **Levees & leveed areas** — every USACE National Levee Database system in the study area
    (Cross Creek–Corcoran, Kings River units, Kern River, etc.), lines + protected areas.
- **Communities & drinking water** (critical-infrastructure context DWR / the State Water Board
  care about under SGMA):
  - **Critical facilities** — prisons, hospitals, water/wastewater treatment plants (OSM).
  - **Disadvantaged communities** — CalEPA SB 535 DAC census tracts (optional).
  - **Public water systems** — community water-system service areas, SWRCB SABL (optional).
- **Subsidence monitoring** (clickable points with a historical time-series chart in the popup):
  - **Continuous GPS stations** — 72 stations in-area from the Nevada Geodetic Lab / EarthScope,
    with their monthly vertical position series (e.g., CRCN at Corcoran shows ~−9 ft since 2010).
  - **GSA subsidence benchmarks** — the physical survey monuments GSAs report to DWR via the SGMA
    portal (GSP Monitoring / annual reports), with their `CUM_DISPLACE_ELEV` history.
- **Topography (2021 LiDAR)** — elevation **contours** (selectable 1/2/5/10/20 ft interval) and
  optional **elevation color banding**, live from DWR's `SanJoaquinValley_Zone4_2021_LIDAR`
  ImageServer (NAVD88 feet). **Major contours are labelled** (every 5× the interval) when zoomed
  in — generated client-side with d3-contour from a LERC-decoded DEM grid. Pairs with the InSAR
  subsidence for base-year elevation context.
- **GSA boundaries** for the Tulare Lake Subbasin and every surrounding subbasin (Kings,
  Kaweah, Tule, Kern County, Westside, Pleasant Valley), coloured by subbasin with a legend,
  GSA-name labels, and an optional shaded-fill toggle.

## Data source
DWR **SAR Vertical Displacement** ImageServer (Sentinel-1, processed by TRE ALTAMIRA under
DWR's SGMA technical assistance). Values are averages over 100 m × 100 m cells.
- Image services: <https://gis.water.ca.gov/arcgisimg/rest/services/SAR>
- Dataset page: <https://data.ca.gov/dataset/tre-altamira-insar-subsidence-data>

The map uses two **mosaic** services and locks the display to one catalog raster per date
(`mosaicRule` → `esriMosaicLockRaster`). The date list is queried from each service catalog
at load time, so new DWR releases appear automatically.

## Run locally
```bash
python3 server.py 8001   # any port; :8000 may be taken by another map
open http://localhost:8001
```

## Rebuild the infrastructure overlays
```bash
python3 prep_infrastructure.py   # OSM (Overpass) -> data/*.geojson
python3 prep_cgps.py             # Nevada Geodetic Lab -> data/cgps_stations.geojson + cgps_series.json
python3 prep_benchmarks.py       # DWR GSP Monitoring -> data/benchmarks.geojson + benchmark_series.json
```
Fetches the Friant-Kern Canal, California Aqueduct, numbered highways, the CA High-Speed
Rail alignment, and rivers & streams (rivers + named streams). The two canals are buffered
1 mile at runtime by turf.js (vendored).

```bash
python3 prep_gsas.py             # DWR SGMA -> data/surrounding_gsas.geojson
```
```bash
python3 prep_levees.py           # USACE NLD -> data/levees.geojson, leveed_areas.geojson
python3 prep_dac_water.py        # SB 535 DAC + SWRCB SABL -> data/dac_tracts.geojson, water_systems.geojson
```
`prep_levees.py` pulls all NLD levee alignments + leveed areas in the study box.
`prep_dac_water.py` pulls SB 535 disadvantaged-community tracts (CalEPA) and community
public-water-system service areas (State Water Board SABL). Railroads, major canals, and
critical facilities come from `prep_infrastructure.py` (above).

> Note: DWR's income-based DAC service (`gis.water.ca.gov/.../DisadvantagedCommunities`) was
> offline (HTTP 500 "not started") when built, so SB 535 DAC is used instead. Swap the endpoint
> in `prep_dac_water.py` if the DWR service returns.

Fetches GSA boundaries for the Tulare Lake Subbasin and surrounding subbasins from DWR's
`i03_Groundwater_Sustainability_Agencies` service. Writes two versions: a generalized
overview (`surrounding_gsas.geojson`, ~33 m, 414 KB) and full resolution
(`surrounding_gsas_detail.geojson`, 2.8 MB) which is lazy-loaded once you zoom past ~z10 so
boundaries stay crisp up close.
The DWR services send permissive CORS headers, so the browser fetches imagery, legend, and
identify results directly — no proxy or API key needed.

## Stack
MapLibre GL JS (vendored). Basemaps: Esri World Imagery, USGS Topo, OpenStreetMap.
Subsidence imagery: CA DWR / TRE ALTAMIRA ArcGIS ImageServer (`exportImage`).

## Roadmap
- **Phase 2** — arbitrary A→B date range: subsidence between any two dates = Total(B) − Total(A),
  computed client-side from raw F32 rasters (`exportImage&format=tiff` + `geotiff.js`).
- **Phase 3** — clickable InSAR points with a full displacement-over-time chart, from DWR's
  point time-series CSVs trimmed to the study area.

## Disclaimer
For informational purposes only. InSAR displacement is a remote-sensing estimate measured in
satellite line-of-sight and converted to vertical; it is subject to processing uncertainty.
All source data is publicly available from CA DWR.
