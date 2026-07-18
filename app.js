/* ══════════════════════════════════════════════════════════════════
   InSAR Land Subsidence Map — Green Acres Consulting, Inc.
   Live DWR / TRE ALTAMIRA vertical-displacement imagery (ArcGIS REST).
   Adapted from the GEARS Groundwater Extraction map (MapLibre GL).
   ══════════════════════════════════════════════════════════════════ */

/* ── InSAR image services (DWR SAR ImageServer, live REST) ───────── */
const SAR_BASE = "https://gis.water.ca.gov/arcgisimg/rest/services/SAR";
const PRODUCTS = {
    total: {
        service: `${SAR_BASE}/Vertical_Displacement_TRE_ALTAMIRA_Total_Since_20150613_Mosaic/ImageServer`,
        dateTitle: "Cumulative through",
        useWindow: false,   // label by end date only
    },
    rate: {
        service: `${SAR_BASE}/Vertical_Displacement_TRE_ALTAMIRA_Annual_Rate_Mosaic/ImageServer`,
        dateTitle: "12-month window ending",
        useWindow: true,    // label by from → to
    },
};

/* ── State ───────────────────────────────────────────────────────── */
let map;
let product = "total";
let dates = [];        // [{oid, from(ms), to(ms)}]  sorted ascending by `to`
let dateIdx = 0;       // current slider index
let playing = false;   // playback active?
let playTimer = null;  // dwell timer between frames
let playDwell = 400;   // extra ms to pause after each frame loads

/* ── Small helpers ───────────────────────────────────────────────── */
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(ms){ const d = new Date(ms); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function service(){ return PRODUCTS[product].service; }

async function fetchJSON(url, tries = 3){
    for (let i = 0; i < tries; i++){
        try {
            const r = await fetch(url);
            if (r.ok){ const j = await r.json(); if (j && !j.error) return j; }
        } catch (e) { /* retry */ }
        await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
    throw new Error("REST request failed: " + url);
}

/* ── Raster tile URL: exportImage locked to one catalog raster ───── */
function tileUrl(oid){
    const mosaicRule = encodeURIComponent(JSON.stringify({
        mosaicMethod: "esriMosaicLockRaster", lockRasterIds: [oid],
    }));
    return `${service()}/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
        `&size=256,256&format=png&transparent=true&f=image&mosaicRule=${mosaicRule}`;
}

/* ── Map init (basemap style shared with the GEARS map) ──────────── */
map = new maplibregl.Map({
    container: "map",
    style: {
        version: 8,
        sources: {
            satellite: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, attribution: "Esri, Maxar, Earthstar Geographics · InSAR: CA DWR / TRE ALTAMIRA", maxzoom: 19 },
            labels: { type: "raster", tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19 },
            roads: { type: "raster", tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19 },
        },
        glyphs: "vendor/fonts/{fontstack}/{range}.pbf",
        layers: [
            { id: "satellite", type: "raster", source: "satellite" },
            { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.8 } },
            { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.7 } },
        ],
    },
    center: [-119.7, 36.0],
    zoom: 8,
    maxZoom: 16,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

map.on("load", async () => {
    loadInfrastructure();         // canals + buffers + highways + rail (independent of dates)
    loadRailroads();              // BNSF / UP mainlines
    loadFacilities();             // prisons, hospitals, treatment plants
    loadLevees();                 // levees + leveed areas (USACE NLD)
    loadLidar();                  // 2021 LiDAR contours + elevation bands (DWR)
    loadGSAs();                   // Tulare Lake Subbasin GSA boundaries
    loadTotalDates();             // cumulative-since-2015 catalog for click popups
    await loadProduct();          // fetch dates + legend, add overlay
    map.once("idle", hideBoot);   // dismiss the boot overlay once first tiles are in
});
/* Pointer cursor over anything clickable. */
map.on("mousemove", (e) => {
    const layers = INFO_LAYERS.filter(l => map.getLayer(l));
    const over = layers.length && map.queryRenderedFeatures(e.point, { layers }).length;
    map.getCanvas().style.cursor = over ? "pointer" : "";
});

/* Loading indicator tied to tile fetches */
map.on("dataloading", () => showLoading(true));
map.on("idle", () => showLoading(false));
function showLoading(on){ document.getElementById("loading").classList.toggle("hidden", !on); }

/* Boot overlay: elapsed-seconds timer, auto-hides once the map is ready. */
const bootStart = Date.now();
let bootHidden = false;
const bootTimer = setInterval(() => {
    const el = document.getElementById("boot-secs");
    if (el) el.textContent = Math.round((Date.now() - bootStart) / 1000);
}, 250);
function hideBoot(){
    if (bootHidden) return;
    bootHidden = true;
    clearInterval(bootTimer);
    const o = document.getElementById("boot-overlay");
    if (o) o.classList.add("hidden");
}
document.getElementById("boot-dismiss").addEventListener("click", hideBoot);
setTimeout(hideBoot, 90000);   // safety fallback

/* ── Load a product: dates, overlay, legend ──────────────────────── */
async function loadProduct(){
    stopPlay();
    setDateLabel("Loading…");
    try {
        await loadDates();
    } catch (e) {
        setDateLabel("Data unavailable");
        document.getElementById("legend").innerHTML =
            `<p class="disclaimer-text">Could not reach the DWR image service. Check your connection and reload.</p>`;
        return;
    }
    if (!dates.length) { setDateLabel("No dates available"); return; }
    dateIdx = dates.length - 1;   // default to most recent
    ensureOverlay();
    refreshOverlay();
    loadLegend();
    syncSlider();
}

async function loadDates(){
    const url = `${service()}/query?where=1%3D1&outFields=OBJECTID,DateFrom,DateTo` +
        `&returnGeometry=false&orderByFields=DateTo&resultRecordCount=1000&f=json`;
    const j = await fetchJSON(url);
    dates = (j.features || [])
        .map(f => ({ oid: f.attributes.OBJECTID, from: f.attributes.DateFrom, to: f.attributes.DateTo }))
        .filter(d => d.to != null)
        .sort((a, b) => a.to - b.to);
}

/* ── Overlay layer ───────────────────────────────────────────────── */
function ensureOverlay(){
    if (map.getSource("insar")) return;
    map.addSource("insar", { type: "raster", tiles: [tileUrl(dates[dateIdx].oid)], tileSize: 256 });
    map.addLayer({
        id: "insar",
        type: "raster",
        source: "insar",
        paint: { "raster-opacity": +document.getElementById("opacity").value / 100 },
    }, "labels");   // keep place labels above the overlay
}
function refreshOverlay(){
    const src = map.getSource("insar");
    if (src) src.setTiles([tileUrl(dates[dateIdx].oid)]);
    updateDateLabel();
}

/* ── Date UI ─────────────────────────────────────────────────────── */
function syncSlider(){
    const s = document.getElementById("date-slider");
    s.min = 0; s.max = dates.length - 1; s.value = dateIdx; s.disabled = dates.length === 0;
    document.getElementById("date-first").textContent = dates.length ? fmtDate(dates[0].to) : "";
    document.getElementById("date-last").textContent  = dates.length ? fmtDate(dates[dates.length - 1].to) : "";
    document.getElementById("date-section-title").textContent =
        product === "rate" ? "12-Month Window" : "Cumulative Date";
    updateDateLabel();
}
function updateDateLabel(){
    if (!dates.length) return setDateLabel("—");
    const d = dates[dateIdx], p = PRODUCTS[product];
    setDateLabel(p.useWindow ? `${fmtDate(d.from)} → ${fmtDate(d.to)}` : fmtDate(d.to));
}
function setDateLabel(txt){ document.getElementById("date-label").textContent = txt; }

function goTo(i){
    dateIdx = Math.max(0, Math.min(dates.length - 1, i));
    document.getElementById("date-slider").value = dateIdx;
    refreshOverlay();
}

/* ── Legend (from the service /legend endpoint) ──────────────────── */
async function loadLegend(){
    const box = document.getElementById("legend");
    box.innerHTML = "";
    try {
        const j = await fetchJSON(`${service()}/legend?f=json`);
        const items = (j.layers && j.layers[0] && j.layers[0].legend) || [];
        items.forEach(it => {
            const row = document.createElement("div");
            row.className = "insar-legend-row";
            row.innerHTML =
                `<img class="insar-swatch" src="data:${it.contentType};base64,${it.imageData}" alt="">` +
                `<span>${it.label}</span>`;
            box.appendChild(row);
        });
    } catch (e) {
        box.innerHTML = `<p class="disclaimer-text">Legend unavailable.</p>`;
    }
}

/* ── Click → infrastructure info popup, else point-value readout ──── */
map.on("click", (e) => {
    const layers = INFO_LAYERS.filter(l => map.getLayer(l));
    const hits = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    if (hits.length) { openInfoPopup(e.lngLat, hits[0]); return; }
    identifyToSidebar(e);
});
map.on("mouseenter", "insar", () => { map.getCanvas().style.cursor = "crosshair"; });

async function identifyToSidebar(e){
    if (!map.getLayer("insar") || map.getLayoutProperty("insar", "visibility") === "none") return;
    const out = document.getElementById("identify-readout");
    out.textContent = "Reading value…";
    const r = await insarValueNear(e.lngLat.lng, e.lngLat.lat, service(), dates[dateIdx].oid);
    if (!r) { out.textContent = "No InSAR data near this location."; return; }
    const dir = r.v < -0.01 ? "subsidence" : r.v > 0.01 ? "uplift" : "no change";
    const tag = r.interpolated ? ` · interpolated ~${Math.round(r.distM)} m` : "";
    out.innerHTML = `<strong>${r.v.toFixed(2)} ft</strong> (${dir})<br>` +
        `<span class="disclaimer-text">${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)} · ${PRODUCTS[product].useWindow ? fmtDate(dates[dateIdx].from) + "→" : ""}${fmtDate(dates[dateIdx].to)}${tag}</span>`;
}

/* Identify the InSAR displacement (feet) at a point for a given service + locked raster. */
async function insarValueAt(lng, lat, svc, oid){
    const geom = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
    const mr = encodeURIComponent(JSON.stringify({ mosaicMethod: "esriMosaicLockRaster", lockRasterIds: [oid] }));
    const url = `${svc}/identify?geometry=${geom}&geometryType=esriGeometryPoint&mosaicRule=${mr}` +
        `&returnGeometry=false&returnCatalogItems=false&f=json`;
    try { const j = await fetchJSON(url, 2); const v = parseFloat(j.value); return isNaN(v) ? null : v; }
    catch (e) { return null; }
}

/* Like insarValueAt, but if the exact cell is NoData, fall back to the nearest valid InSAR
   sample (expanding rings via getSamples). Returns { v, interpolated, distM } or null. */
async function insarValueNear(lng, lat, svc, oid){
    const exact = await insarValueAt(lng, lat, svc, oid);
    if (exact != null) return { v: exact, interpolated: false, distM: 0 };
    const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    const pts = [];
    for (const r of [150, 300, 600, 1000, 1600, 2500, 4000, 6000, 8000])
        for (let i = 0; i < 12; i++) {
            const a = 2 * Math.PI * i / 12;
            pts.push([lng + (r * Math.cos(a)) / mLon, lat + (r * Math.sin(a)) / mLat]);
        }
    const geom = encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }));
    const mr = encodeURIComponent(JSON.stringify({ mosaicMethod: "esriMosaicLockRaster", lockRasterIds: [oid] }));
    const url = `${svc}/getSamples?geometry=${geom}&geometryType=esriGeometryMultipoint&mosaicRule=${mr}&f=json`;
    try {
        const j = await fetchJSON(url, 2);
        let best = null;
        for (const s of (j.samples || [])) {
            const v = parseFloat(s.value);
            if (isNaN(v)) continue;
            const dM = Math.hypot((s.location.x - lng) * mLon, (s.location.y - lat) * mLat);
            if (!best || dM < best.distM) best = { v, distM: dM };
        }
        return best ? { v: best.v, interpolated: true, distM: best.distM } : null;
    } catch (e) { return null; }
}
function interpNote(...rs){
    const d = Math.max(...rs.filter(r => r && r.interpolated).map(r => r.distM), 0);
    return d > 0 ? ` Interpolated from nearest InSAR ~${Math.round(d)} m away.` : "";
}

/* Cumulative "Total" catalog (since 2015-06-13), fetched once, for elevation-change lookups. */
let totalDates = [];
async function loadTotalDates(){
    try {
        const url = `${PRODUCTS.total.service}/query?where=1%3D1&outFields=OBJECTID,DateTo` +
            `&returnGeometry=false&orderByFields=DateTo&resultRecordCount=1000&f=json`;
        const j = await fetchJSON(url);
        totalDates = (j.features || []).map(f => ({ oid: f.attributes.OBJECTID, to: f.attributes.DateTo }))
            .filter(d => d.to != null).sort((a, b) => a.to - b.to);
    } catch (e) { totalDates = []; }
}
function currentTotal(){
    if (product === "total" && dates.length) return dates[dateIdx];
    return totalDates.length ? totalDates[totalDates.length - 1] : null;
}

/* USGS 3DEP ground elevation (feet) at a point. */
async function elevationAt(lng, lat){
    try {
        const r = await fetch(`https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&units=Feet&wkid=4326&includeDate=true`);
        if (!r.ok) return null;
        const j = await r.json();
        const v = parseFloat(j.value);
        return isNaN(v) ? null : { v, date: (j.attributes || {}).AcquisitionDate || "" };
    } catch (e) { return null; }
}

/* ── Infrastructure click popups ─────────────────────────────────── */
const INFO_LAYERS = ["fac-circle", "levee-line", "fkc-line", "aqueduct-line", "mcanal-line",
    "hsr-line", "rail-line", "highways-line", "levee-area-fill", "water-fill"];
/* Known operating authorities for features whose source has no per-feature contact. */
const AUTHORITY = {
    "fkc-line":      { title: "Friant-Kern Canal", type: "Canal · federal Central Valley Project",
        authority: "Friant Water Authority (operations) · U.S. Bureau of Reclamation (owner)", url: "https://friantwater.org" },
    "aqueduct-line": { title: "California Aqueduct", type: "Aqueduct · State Water Project",
        authority: "California Dept. of Water Resources", url: "https://water.ca.gov" },
    "hsr-line":      { title: "California High-Speed Rail", type: "High-speed rail (under construction)",
        authority: "California High-Speed Rail Authority", url: "https://hsr.ca.gov" },
    "highways-line": { type: "State highway", authority: "California Dept. of Transportation (Caltrans)", url: "https://dot.ca.gov" },
};
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
const clean = v => (v == null ? "" : String(v).trim());

/* Known design crest elevations (ft) by NLD system name. The Corcoran levee was raised to
   192 ft during the 2023 Tulare Lake flooding; that crest applies along the whole length, and
   subsidence since the raise lowers the effective crest point-by-point. */
const LEVEE_CREST = {
    "Cross Creek - Corcoran": { crestFt: 192, raisedYear: 2023, sinceMs: Date.UTC(2023, 5, 1) },
};

function buildInfo(f){
    const id = f.layer.id, p = f.properties || {}, A = AUTHORITY[id] || {};
    let title = A.title || "", type = A.type || "", authority = A.authority || "", crest = null;
    const rows = [], contacts = [];
    if (A.url) contacts.push(`<a href="${A.url}" target="_blank">website</a>`);
    if (id === "fac-circle") {
        title = clean(p.name);
        type = { prison: "Correctional facility", hospital: "Hospital", treatment: "Water / wastewater treatment" }[p.kind] || "Critical facility";
        authority = clean(p.operator);
        if (clean(p.phone)) contacts.push(clean(p.phone));
        if (clean(p.website)) contacts.push(`<a href="${clean(p.website)}" target="_blank">website</a>`);
    } else if (id === "levee-line" || id === "levee-area-fill") {
        title = clean(p.SYSTEM_NAME);
        type = id === "levee-area-fill" ? "Leveed area · USACE NLD" : "Levee · USACE NLD";
        authority = clean(p.SPONSORS) || clean(p.RESPONSIBLE_ORGANIZATION);
        if (clean(p.COUNTIES)) rows.push(["Counties", clean(p.COUNTIES)]);
        if (p.LEVEED_AREA_SQ_MI) rows.push(["Leveed area", (+p.LEVEED_AREA_SQ_MI).toFixed(1) + " sq mi"]);
        if (clean(p.FEMA_ACCREDITATION_RATING)) rows.push(["FEMA rating", clean(p.FEMA_ACCREDITATION_RATING)]);
        if (id === "levee-line") crest = LEVEE_CREST[clean(p.SYSTEM_NAME)] || null;
    } else if (id === "mcanal-line") {
        title = clean(p.name) || "Canal"; type = "Canal / conveyance"; authority = clean(p.operator);
    } else if (id === "rail-line") {
        title = clean(p.name) || "Freight railroad"; type = "Freight railroad"; authority = clean(p.operator);
    } else if (id === "highways-line") {
        title = clean(p.ref) + (clean(p.name) ? " · " + clean(p.name) : "");
    } else if (id === "water-fill") {
        title = clean(p.WATER_SYSTEM_NAME); type = "Public water system (community)"; authority = clean(p.WATER_SYSTEM_NAME);
        if (p.POPULATION) rows.push(["Population served", (+p.POPULATION).toLocaleString()]);
        if (p.SERVICE_CONNECTIONS) rows.push(["Service connections", (+p.SERVICE_CONNECTIONS).toLocaleString()]);
        if (clean(p.REGULATING_AGENCY)) rows.push(["Regulated by", clean(p.REGULATING_AGENCY)]);
        const addr = [clean(p.ADDR_LINE_ONE_TXT), clean(p.ADDRESS_CITY_NAME)].filter(Boolean).join(", ");
        if (addr) contacts.push(esc(addr));
        if (clean(p.AC_PHONE_NUMBER)) contacts.push(esc(clean(p.AC_PHONE_NUMBER)));
        if (clean(p.AC_EMAIL)) contacts.push(`<a href="mailto:${clean(p.AC_EMAIL)}">${esc(clean(p.AC_EMAIL))}</a>`);
    }
    return { title: title || "(unnamed)", type, authority, rows, contacts, crest };
}

let infoPopup = null;
function openInfoPopup(lngLat, feature){
    const info = buildInfo(feature);
    const rowsHtml = info.rows.map(r => `<div class="pop-row"><span class="pop-k">${esc(r[0])}</span><span class="pop-v">${esc(r[1])}</span></div>`).join("");
    const authHtml = info.authority ? `<div class="pop-row"><span class="pop-k">Authority</span><span class="pop-v">${esc(info.authority)}</span></div>` : "";
    const contactHtml = info.contacts.length ? `<div class="pop-contact">${info.contacts.join(" · ")}</div>` : "";
    const elevHtml = info.crest
        ? `<div class="pop-sec">Levee crest &amp; subsidence</div>` +
          `<div class="pop-row"><span class="pop-k">Design crest (${info.crest.raisedYear} raise)</span><span class="pop-v">${info.crest.crestFt.toFixed(1)} ft</span></div>` +
          `<div class="pop-row"><span class="pop-k">Subsidence since ${info.crest.raisedYear}</span><span class="pop-v" id="pop-sub">…</span></div>` +
          `<div class="pop-row"><span class="pop-k">Effective crest now</span><span class="pop-v" id="pop-eff">…</span></div>` +
          `<div class="pop-note" id="pop-note"></div>`
        : `<div class="pop-sec">Elevation &amp; subsidence</div>` +
          `<div class="pop-row"><span class="pop-k">Ground elev.</span><span class="pop-v" id="pop-elev">…</span></div>` +
          `<div class="pop-row"><span class="pop-k">Change since 2015</span><span class="pop-v" id="pop-sub">…</span></div>` +
          `<div class="pop-row"><span class="pop-k">≈ 2015 elev.</span><span class="pop-v" id="pop-2015">…</span></div>` +
          `<div class="pop-note" id="pop-note"></div>`;
    const html = `<div class="pop-title">${esc(info.title)}</div>` +
        `<div class="pop-type">${esc(info.type)}</div>${authHtml}${rowsHtml}${contactHtml}${elevHtml}`;
    if (infoPopup) infoPopup.remove();
    infoPopup = new maplibregl.Popup({ maxWidth: "300px", className: "info-popup" }).setLngLat(lngLat).setHTML(html).addTo(map);
    fillElevSub(lngLat, info.crest);
}

/* Total-catalog raster whose date is closest to `ms`. */
function totalOidNear(ms){
    if (!totalDates.length) return null;
    return totalDates.reduce((best, d) => Math.abs(d.to - ms) < Math.abs(best.to - ms) ? d : best, totalDates[0]);
}

async function fillElevSub(lngLat, crest){
    const $ = id => document.getElementById(id);
    if (crest) {   // levee: effective crest = design crest − subsidence since the raise
        const cur = currentTotal(), ref = totalOidNear(crest.sinceMs);
        const svc = PRODUCTS.total.service;
        const [curR, refR] = await Promise.all([
            cur ? insarValueNear(lngLat.lng, lngLat.lat, svc, cur.oid) : null,
            ref ? insarValueNear(lngLat.lng, lngLat.lat, svc, ref.oid) : null,
        ]);
        if (!$("pop-sub")) return;
        if (curR && refR) {
            const sub = curR.v - refR.v;   // change since the raise (negative = subsidence)
            $("pop-sub").textContent = `${sub.toFixed(2)} ft`;
            $("pop-eff").textContent = `${(crest.crestFt + sub).toFixed(1)} ft`;
            $("pop-note").textContent = `${crest.crestFt} ft crest set at the ${crest.raisedYear} raise (applied along the full levee length); ` +
                `subsidence since ${fmtDate(ref.to)} from InSAR lowers the effective crest at this point.` + interpNote(curR, refR);
        } else {
            $("pop-sub").textContent = "no InSAR data nearby";
            $("pop-eff").textContent = "n/a";
        }
        return;
    }
    const [elev, tot] = await Promise.all([
        elevationAt(lngLat.lng, lngLat.lat),
        (async () => { const d = currentTotal(); if (!d) return null;
            const r = await insarValueNear(lngLat.lng, lngLat.lat, PRODUCTS.total.service, d.oid);
            return r ? { ...r, to: d.to } : null; })(),
    ]);
    if (!$("pop-elev")) return;   // popup already closed
    $("pop-elev").textContent = elev ? `${elev.v.toFixed(1)} ft${elev.date ? ` (${elev.date})` : ""}` : "n/a";
    if (tot) {
        const dir = tot.v < -0.01 ? "subsidence" : tot.v > 0.01 ? "uplift" : "~none";
        $("pop-sub").textContent = `${tot.v.toFixed(2)} ft (${dir})`;
        $("pop-2015").textContent = elev ? `${(elev.v - tot.v).toFixed(1)} ft` : "n/a";
        $("pop-note").textContent = `InSAR base year 2015-06-13 · through ${fmtDate(tot.to)}. 2015 elev. ≈ ground elev. − change.` + interpNote(tot);
    } else {
        $("pop-sub").textContent = "no InSAR data nearby";
        $("pop-2015").textContent = "n/a";
    }
}

/* ── Controls wiring ─────────────────────────────────────────────── */
document.getElementById("product").addEventListener("change", (e) => { product = e.target.value; loadProduct(); });
document.getElementById("date-slider").addEventListener("input", (e) => { stopPlay(); goTo(+e.target.value); });
document.getElementById("date-prev").addEventListener("click", () => { stopPlay(); goTo(dateIdx - 1); });
document.getElementById("date-next").addEventListener("click", () => { stopPlay(); goTo(dateIdx + 1); });
document.getElementById("date-play").addEventListener("click", togglePlay);
/* Speed slider: right = faster. playDwell is the pause added after each frame finishes loading. */
const speedEl = document.getElementById("play-speed");
playDwell = +speedEl.max - +speedEl.value;
speedEl.addEventListener("input", (e) => { playDwell = +e.target.max - +e.target.value; });
document.getElementById("opacity").addEventListener("input", (e) => {
    if (map.getLayer("insar")) map.setPaintProperty("insar", "raster-opacity", +e.target.value / 100);
});
document.getElementById("toggle-insar").addEventListener("change", (e) => {
    if (map.getLayer("insar")) map.setLayoutProperty("insar", "visibility", e.target.checked ? "visible" : "none");
});

function togglePlay(){ playing ? stopPlay() : startPlay(); }
function setPlayBtn(on){
    const btn = document.getElementById("date-play");
    btn.innerHTML = on ? "&#10073;&#10073; Pause" : "&#9654; Play";
    btn.classList.toggle("active", on);
}
function startPlay(){
    if (!dates.length || playing) return;
    playing = true; setPlayBtn(true);
    stepPlayback();
}
function stopPlay(){
    playing = false; setPlayBtn(false);
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
}
/* Advance one frame, wait for its imagery to finish loading, then dwell, then repeat. */
function stepPlayback(){
    if (!playing) return;
    goTo(dateIdx >= dates.length - 1 ? 0 : dateIdx + 1);
    whenTilesReady(() => {
        if (!playing) return;
        playTimer = setTimeout(stepPlayback, playDwell);
    });
}
/* Resolve once the map is idle (all tiles loaded), with a safety fallback so a
   failed/stalled tile can never hang playback forever. */
function whenTilesReady(cb){
    let done = false;
    const finish = () => { if (done) return; done = true; map.off("idle", finish); clearTimeout(fallback); cb(); };
    const fallback = setTimeout(finish, 8000);
    map.on("idle", finish);
}

/* ── Infrastructure overlays (canals + 1-mi buffers, highways, HSR) ── */
const BUFFER_MILES = 1;
/* Sidebar checkbox -> the map layers it controls. */
const INFRA_GROUPS = {
    "fkc":             ["fkc-line"],
    "fkc-buffer":      ["fkc-buffer-fill", "fkc-buffer-outline"],
    "aqueduct":        ["aqueduct-line"],
    "aqueduct-buffer": ["aqueduct-buffer-fill", "aqueduct-buffer-outline"],
    "highways":        ["highways-casing", "highways-line", "highways-label"],
    "hsr":             ["hsr-casing", "hsr-line"],
    "railroads":       ["rail-casing", "rail-line"],
    "facilities":      ["fac-circle", "fac-label"],
    "levees":          ["levee-area-fill", "levee-area-line", "levee-label", "levee-line-casing", "levee-line"],
};

async function fetchGeo(url){
    try { const r = await fetch(url); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
}

async function loadInfrastructure(){
    const [fkc, aq, hwy, hsr] = await Promise.all([
        fetchGeo("data/friant_kern_canal.geojson"),
        fetchGeo("data/california_aqueduct.geojson"),
        fetchGeo("data/highways.geojson"),
        fetchGeo("data/hsr_alignment.geojson"),
    ]);
    if (fkc) addCanal("fkc", fkc, "#ff2fd0");
    if (aq)  addCanal("aqueduct", aq, "#22d3ee");
    if (hwy) addHighways(hwy);
    if (hsr) addRail(hsr);
    applyInfraVisibility();   // honor the sidebar defaults (canals on, highways/HSR off)
}

/* Canal centerline + a 1-mile buffer either side (turf), all drawn above the InSAR raster. */
function addCanal(id, geo, color){
    let buf = null;
    try { buf = turf.buffer(geo, BUFFER_MILES, { units: "miles" }); } catch (e) { buf = null; }
    map.addSource(id, { type: "geojson", data: geo });
    if (buf) {
        map.addSource(id + "-buffer", { type: "geojson", data: buf });
        map.addLayer({ id: id + "-buffer-fill", type: "fill", source: id + "-buffer",
            paint: { "fill-color": color, "fill-opacity": 0.12 } });
        map.addLayer({ id: id + "-buffer-outline", type: "line", source: id + "-buffer",
            paint: { "line-color": color, "line-width": 1.4, "line-dasharray": [3, 2], "line-opacity": 0.9 } });
    }
    map.addLayer({ id: id + "-line", type: "line", source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": color, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.5, 12, 4], "line-opacity": 0.95 } });
}

function addHighways(geo){
    map.addSource("highways", { type: "geojson", data: geo });
    map.addLayer({ id: "highways-casing", type: "line", source: "highways",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1e293b", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.8, 12, 5.5], "line-opacity": 0.85 } });
    map.addLayer({ id: "highways-line", type: "line", source: "highways",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#f8fafc", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.7, 12, 2.6] } });
    map.addLayer({ id: "highways-label", type: "symbol", source: "highways",
        layout: { "symbol-placement": "line", "text-field": ["get", "ref"], "text-size": 11,
                  "text-font": ["Noto Sans Bold"], "symbol-spacing": 300 },
        paint: { "text-color": "#f1f5f9", "text-halo-color": "#0f172a", "text-halo-width": 1.6 } });
}

/* Levees + leveed areas (USACE NLD) — every system in the study area. */
async function loadLevees(){
    const [area, lines] = await Promise.all([
        fetchGeo("data/leveed_areas.geojson"),
        fetchGeo("data/levees.geojson"),
    ]);
    if (area) {
        map.addSource("levee-area", { type: "geojson", data: area });
        map.addLayer({ id: "levee-area-fill", type: "fill", source: "levee-area",
            paint: { "fill-color": "#f97316", "fill-opacity": 0.12 } });
        map.addLayer({ id: "levee-area-line", type: "line", source: "levee-area",
            paint: { "line-color": "#f97316", "line-width": 1.1, "line-dasharray": [3, 2], "line-opacity": 0.8 } });
        // One label per leveed area (system name), at closer zooms.
        const pts = { type: "FeatureCollection", features: area.features.map(f => {
            const c = turf.centroid(f); c.properties = { label: f.properties.SYSTEM_NAME || "Leveed area" }; return c;
        }) };
        map.addSource("levee-label", { type: "geojson", data: pts });
        map.addLayer({ id: "levee-label", type: "symbol", source: "levee-label", minzoom: 9.5,
            layout: { "text-field": ["get", "label"], "text-size": 10.5, "text-font": ["Noto Sans Bold"], "text-max-width": 9 },
            paint: { "text-color": "#fed7aa", "text-halo-color": "#0f172a", "text-halo-width": 1.6 } });
    }
    if (lines) {
        map.addSource("levee", { type: "geojson", data: lines });
        map.addLayer({ id: "levee-line-casing", type: "line", source: "levee",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#0f172a", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2.6, 12, 5], "line-opacity": 0.65 } });
        map.addLayer({ id: "levee-line", type: "line", source: "levee",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#fb923c", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.4, 12, 3] } });
    }
    applyInfraVisibility();
}

function addRail(geo){   // High-Speed Rail alignment
    map.addSource("hsr", { type: "geojson", data: geo });
    map.addLayer({ id: "hsr-casing", type: "line", source: "hsr",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#f8fafc", "line-width": 4, "line-opacity": 0.7 } });
    map.addLayer({ id: "hsr-line", type: "line", source: "hsr",
        paint: { "line-color": "#a855f7", "line-width": 2.4, "line-dasharray": [2, 1.5] } });
}

/* Freight railroads (BNSF / UP mainlines). */
async function loadRailroads(){
    const geo = await fetchGeo("data/railroads.geojson");
    if (!geo) return;
    map.addSource("rail", { type: "geojson", data: geo });
    map.addLayer({ id: "rail-casing", type: "line", source: "rail",
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": "#334155", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.6, 12, 4] } });
    map.addLayer({ id: "rail-line", type: "line", source: "rail",
        paint: { "line-color": "#e2e8f0", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.6, 12, 1.4], "line-dasharray": [2, 3] } });
    applyInfraVisibility();
}

/* Critical facilities (prisons, hospitals, treatment plants). */
const FAC_COLORS = { prison: "#ef4444", hospital: "#ec4899", treatment: "#0ea5e9", other: "#94a3b8" };
async function loadFacilities(){
    const geo = await fetchGeo("data/facilities.geojson");
    if (!geo) return;
    map.addSource("facilities", { type: "geojson", data: geo });
    map.addLayer({ id: "fac-circle", type: "circle", source: "facilities",
        paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 3, 12, 6],
            "circle-color": ["match", ["get", "kind"], "prison", FAC_COLORS.prison, "hospital", FAC_COLORS.hospital,
                             "treatment", FAC_COLORS.treatment, FAC_COLORS.other],
            "circle-stroke-color": "#0f172a", "circle-stroke-width": 1.2, "circle-opacity": 0.95,
        } });
    map.addLayer({ id: "fac-label", type: "symbol", source: "facilities", minzoom: 10,
        layout: { "text-field": ["get", "name"], "text-size": 10.5, "text-font": ["Noto Sans Bold"],
                  "text-offset": [0, 1], "text-anchor": "top", "text-max-width": 9 },
        paint: { "text-color": "#e2e8f0", "text-halo-color": "#0f172a", "text-halo-width": 1.5 } });
    applyInfraVisibility();
}

/* ── 2021 San Joaquin Valley LiDAR (DWR ImageServer) — contours + bands ── */
const LIDAR = "https://gis.water.ca.gov/arcgisimg/rest/services/Elevation/SanJoaquinValley_Zone4_2021_LIDAR/ImageServer";
let contourInterval = 5;   // feet
function lidarTileBase(rule){
    return `${LIDAR}/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
        `&size=512,512&format=png&transparent=true&f=image&renderingRule=${rule}`;
}
function contourTileUrl(){
    const rr = encodeURIComponent(JSON.stringify({ rasterFunction: "Contour",
        rasterFunctionArguments: { ContourInterval: contourInterval, ContourType: 0 } }));
    return lidarTileBase(rr);
}
function elevBandTileUrl(){
    // Elevation color ramp scoped to the valley range so bands are visible on flat ground.
    const rr = encodeURIComponent(JSON.stringify({ rasterFunction: "Colormap",
        rasterFunctionArguments: { ColorrampName: "Elevation #1", Raster: {
            rasterFunction: "Stretch",
            rasterFunctionArguments: { StretchType: 5, Min: 0, Max: 255, Statistics: [[150, 500, 320, 70]], DRA: false } } } }));
    return lidarTileBase(rr);
}
function loadLidar(){
    map.addSource("lidar-color", { type: "raster", tiles: [elevBandTileUrl()], tileSize: 512 });
    map.addLayer({ id: "lidar-color", type: "raster", source: "lidar-color",
        layout: { visibility: "none" }, paint: { "raster-opacity": 0.7 } }, map.getLayer("labels") ? "labels" : undefined);
    map.addSource("lidar-contour", { type: "raster", tiles: [contourTileUrl()], tileSize: 512 });
    map.addLayer({ id: "lidar-contour", type: "raster", source: "lidar-contour",
        layout: { visibility: "none" }, paint: { "raster-opacity": 0.85 } }, map.getLayer("labels") ? "labels" : undefined);
}
document.getElementById("toggle-contours").addEventListener("change", (e) => {
    if (map.getLayer("lidar-contour")) map.setLayoutProperty("lidar-contour", "visibility", e.target.checked ? "visible" : "none");
    e.target.checked ? updateContourLabels() : clearContourLabels();
});
document.getElementById("toggle-elev-bands").addEventListener("change", (e) => {
    if (map.getLayer("lidar-color")) map.setLayoutProperty("lidar-color", "visibility", e.target.checked ? "visible" : "none");
});
document.getElementById("contour-interval").addEventListener("change", (e) => {
    contourInterval = +e.target.value;
    const src = map.getSource("lidar-contour");
    if (src) src.setTiles([contourTileUrl()]);
    updateContourLabels();
});

/* Labeled MAJOR contours — generated client-side from the LiDAR DEM (d3-contour) so we have
   vector lines to place elevation labels on. Shown when the contour layer is on and zoomed in. */
const CONTOUR_LABEL_MINZOOM = 11;
function majorInterval(){ return contourInterval * 5; }
function contoursOn(){ const el = document.getElementById("toggle-contours"); return el && el.checked; }

function mercator(lng, lat){ const R = 6378137; return [R * lng * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))]; }

/* Pull the DEM for the current view as one LERC raster (fast) and decode to a float grid. */
async function sampleGrid(bounds, size){
    const west = bounds.getWest(), east = bounds.getEast(), north = bounds.getNorth(), south = bounds.getSouth();
    const [xmin, ymin] = mercator(west, south), [xmax, ymax] = mercator(east, north);
    const url = `${LIDAR}/exportImage?bbox=${xmin},${ymin},${xmax},${ymax}&bboxSR=3857&imageSR=3857` +
        `&size=${size},${size}&format=lerc&f=image`;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const dec = Lerc.decode(await r.arrayBuffer());
        const px = dec.pixels[0], mask = dec.mask, W = dec.width, H = dec.height;
        const nd = dec.statistics && dec.statistics[0] && dec.statistics[0].noDataValue;
        const grid = new Float64Array(W * H);
        for (let i = 0; i < W * H; i++) { const v = px[i]; grid[i] = ((mask && !mask[i]) || v === nd || v < -1e30) ? NaN : v; }
        return { grid, W, H, west, east, north, south };
    } catch (e) { return null; }
}

function fillHoles(grid, W, H){
    const idx = (i, j) => j * W + i;
    for (let pass = 0; pass < 12; pass++) {
        let holes = false;
        const copy = Float64Array.from(grid);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
            if (!isNaN(grid[idx(i, j)])) continue;
            let sum = 0, n = 0;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, jj = j + dj;
                if (ii >= 0 && ii < W && jj >= 0 && jj < H) { const v = grid[idx(ii, jj)]; if (!isNaN(v)) { sum += v; n++; } }
            }
            if (n) copy[idx(i, j)] = sum / n; else holes = true;
        }
        grid.set(copy);
        if (!holes) break;
    }
    let sum = 0, n = 0; for (const v of grid) if (!isNaN(v)) { sum += v; n++; }
    const mean = n ? sum / n : 0; for (let k = 0; k < grid.length; k++) if (isNaN(grid[k])) grid[k] = mean;
}

let contourLayersReady = false;
function ensureContourLayers(){
    if (contourLayersReady) return;
    map.addSource("contour-major", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "contour-major-line", type: "line", source: "contour-major",
        paint: { "line-color": "#fde68a", "line-width": 1.3, "line-opacity": 0.9 } });
    map.addLayer({ id: "contour-major-label", type: "symbol", source: "contour-major",
        layout: { "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "value"]], " ft"],
                  "text-size": 11, "text-font": ["Noto Sans Bold"], "symbol-spacing": 260 },
        paint: { "text-color": "#fef3c7", "text-halo-color": "#0f172a", "text-halo-width": 1.7 } });
    contourLayersReady = true;
}
function clearContourLabels(){
    const s = map.getSource("contour-major");
    if (s) s.setData({ type: "FeatureCollection", features: [] });
}

const updateContourLabels = debounce(async () => {
    if (!contoursOn() || map.getZoom() < CONTOUR_LABEL_MINZOOM) { clearContourLabels(); return; }
    const g = await sampleGrid(map.getBounds(), 256);
    if (!g) return;
    fillHoles(g.grid, g.W, g.H);
    let mn = Infinity, mx = -Infinity;
    for (const v of g.grid) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const mi = majorInterval(), levels = [];
    for (let t = Math.ceil(mn / mi) * mi; t <= mx; t += mi) { levels.push(t); if (levels.length > 14) break; }
    if (!levels.length) { clearContourLabels(); return; }
    const cs = d3.contours().size([g.W, g.H]).thresholds(levels)(Array.from(g.grid));
    const gx2lng = gx => g.west + (Math.min(Math.max(gx, 0), g.W - 1) / (g.W - 1)) * (g.east - g.west);
    const gy2lat = gy => g.north - (Math.min(Math.max(gy, 0), g.H - 1) / (g.H - 1)) * (g.north - g.south);
    const feats = [];
    for (const c of cs) for (const poly of c.coordinates) for (const ring of poly) {
        if (ring.length < 2) continue;
        feats.push({ type: "Feature", properties: { value: Math.round(c.value) },
            geometry: { type: "LineString", coordinates: ring.map(([gx, gy]) => [gx2lng(gx), gy2lat(gy)]) } });
    }
    ensureContourLayers();
    map.getSource("contour-major").setData({ type: "FeatureCollection", features: feats });
}, 350);
map.on("moveend", () => { if (contoursOn()) updateContourLabels(); });

/* ── Optional, heavier layers: fetched only when first switched on ─── */
function addRivers(geo){
    map.addSource("rivers", { type: "geojson", data: geo });
    map.addLayer({ id: "rivers-line", type: "line", source: "rivers",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#38bdf8", "line-opacity": 0.85,
            "line-width": ["interpolate", ["linear"], ["zoom"],
                7,  ["match", ["get", "waterway"], "river", 0.9, 0.3],
                12, ["match", ["get", "waterway"], "river", 2.6, 1.0]] } });
}
function addMajorCanals(geo){
    map.addSource("mcanals", { type: "geojson", data: geo });
    map.addLayer({ id: "mcanal-line", type: "line", source: "mcanals",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2dd4bf", "line-opacity": 0.9,
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 13, 2.2] } });
    map.addLayer({ id: "mcanal-label", type: "symbol", source: "mcanals", minzoom: 11,
        layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 10,
                  "text-font": ["Noto Sans Bold"], "symbol-spacing": 400 },
        paint: { "text-color": "#99f6e4", "text-halo-color": "#0f172a", "text-halo-width": 1.4 } });
}
function addDAC(geo){
    map.addSource("dac", { type: "geojson", data: geo });
    map.addLayer({ id: "dac-fill", type: "fill", source: "dac",
        paint: { "fill-color": "#eab308", "fill-opacity": 0.18 } });
    map.addLayer({ id: "dac-line", type: "line", source: "dac",
        paint: { "line-color": "#eab308", "line-width": 0.8, "line-opacity": 0.6 } });
}
function addWaterSystems(geo){
    map.addSource("water", { type: "geojson", data: geo });
    map.addLayer({ id: "water-fill", type: "fill", source: "water",
        paint: { "fill-color": "#38bdf8", "fill-opacity": 0.16 } });
    map.addLayer({ id: "water-line", type: "line", source: "water",
        paint: { "line-color": "#38bdf8", "line-width": 0.9, "line-opacity": 0.7 } });
}

/* toggle id -> lazy layer config */
const LAZY = {
    "toggle-rivers": { url: "data/rivers_streams.geojson", layers: ["rivers-line"], build: addRivers },
    "toggle-canals": { url: "data/major_canals.geojson", layers: ["mcanal-line", "mcanal-label"], build: addMajorCanals },
    "toggle-dac":    { url: "data/dac_tracts.geojson", layers: ["dac-fill", "dac-line"], build: addDAC },
    "toggle-water":  { url: "data/water_systems.geojson", layers: ["water-fill", "water-line"], build: addWaterSystems },
};
Object.entries(LAZY).forEach(([id, cfg]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", async (e) => {
        if (e.target.checked && !cfg.loaded && !cfg.loading) {
            cfg.loading = true;
            const geo = await fetchGeo(cfg.url);
            cfg.loading = false;
            if (geo) { cfg.build(geo); cfg.loaded = true; }
        }
        const vis = e.target.checked ? "visible" : "none";
        cfg.layers.forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", vis); });
    });
});

function applyInfraVisibility(){
    document.querySelectorAll("[data-infra]").forEach(cb => {
        const vis = cb.checked ? "visible" : "none";
        (INFRA_GROUPS[cb.dataset.infra] || []).forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", vis); });
    });
}
document.querySelectorAll("[data-infra]").forEach(cb => cb.addEventListener("change", () => {
    const vis = cb.checked ? "visible" : "none";
    (INFRA_GROUPS[cb.dataset.infra] || []).forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", vis); });
}));

/* ── GSA boundaries (Tulare Lake Subbasin + surrounding subbasins) ── */
const GSA_GROUPS = {
    "boundaries": ["gsas-casing", "gsas-line", "gsas-label"],
    "fill":       ["gsas-fill"],
};
/* GSA outlines are coloured by the subbasin they belong to. */
const SUBBASIN_COLORS = {
    "Tulare Lake":     "#f43f5e",
    "Kings":           "#3b82f6",
    "Kaweah":          "#a855f7",
    "Tule":            "#f59e0b",
    "Kern County":     "#22c55e",
    "Westside":        "#14b8a6",
    "Pleasant Valley": "#eab308",
};
function subbasinMatch(){
    const m = ["match", ["get", "subbasin"]];
    for (const [k, v] of Object.entries(SUBBASIN_COLORS)) m.push(k, v);
    m.push("#94a3b8");   // fallback
    return m;
}
async function loadGSAs(){
    const geo = await fetchGeo("data/surrounding_gsas.geojson");
    if (!geo) return;
    map.addSource("gsas", { type: "geojson", data: geo });
    map.addLayer({ id: "gsas-fill", type: "fill", source: "gsas",
        paint: { "fill-color": subbasinMatch(), "fill-opacity": 0.15 } });
    map.addLayer({ id: "gsas-casing", type: "line", source: "gsas",
        layout: { "line-join": "round" },
        paint: { "line-color": "#0f172a", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.1, 12, 2.4], "line-opacity": 0.5 } });
    map.addLayer({ id: "gsas-line", type: "line", source: "gsas",
        layout: { "line-join": "round" },
        paint: { "line-color": subbasinMatch(), "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 12, 1.4] } });
    // One label per GSA (centroid) so multipart agencies aren't labelled twice.
    const pts = { type: "FeatureCollection", features: geo.features.map(f => {
        const c = turf.centroid(f); c.properties = { GSA_Name: f.properties.GSA_Name }; return c;
    }) };
    map.addSource("gsa-labels", { type: "geojson", data: pts });
    map.addLayer({ id: "gsas-label", type: "symbol", source: "gsa-labels", minzoom: 8.5,
        layout: { "text-field": ["get", "GSA_Name"], "text-size": 11, "text-font": ["Noto Sans Bold"],
                  "text-max-width": 8, "text-anchor": "center" },
        paint: { "text-color": "#ffffff", "text-halo-color": "#0f172a", "text-halo-width": 1.8 } });
    buildGSALegend();
    applyGSAVisibility();
    maybeLoadGSADetail();   // in case we already start zoomed in
}

/* Swap the generalized overview geometry for full resolution once zoomed in — the ~33 m
   generalization looks jagged up close. Loaded once, then kept. */
let gsaDetailLoaded = false, gsaDetailLoading = false;
const GSA_DETAIL_ZOOM = 10;
async function maybeLoadGSADetail(){
    if (gsaDetailLoaded || gsaDetailLoading || map.getZoom() < GSA_DETAIL_ZOOM) return;
    gsaDetailLoading = true;
    const geo = await fetchGeo("data/surrounding_gsas_detail.geojson");
    gsaDetailLoading = false;
    if (!geo) return;
    const src = map.getSource("gsas");
    if (src) { src.setData(geo); gsaDetailLoaded = true; }
}
map.on("zoomend", maybeLoadGSADetail);
function buildGSALegend(){
    const box = document.getElementById("gsa-legend");
    if (!box) return;
    box.innerHTML = "";
    for (const [name, color] of Object.entries(SUBBASIN_COLORS)) {
        const row = document.createElement("div");
        row.className = "insar-legend-row";
        row.innerHTML = `<span class="toggle-swatch swatch-outline" style="border-color:${color}"></span><span>${name}</span>`;
        box.appendChild(row);
    }
}
function applyGSAVisibility(){
    document.querySelectorAll("[data-gsa]").forEach(cb => {
        const vis = cb.checked ? "visible" : "none";
        (GSA_GROUPS[cb.dataset.gsa] || []).forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", vis); });
    });
}
document.querySelectorAll("[data-gsa]").forEach(cb => cb.addEventListener("change", () => {
    const vis = cb.checked ? "visible" : "none";
    (GSA_GROUPS[cb.dataset.gsa] || []).forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", vis); });
}));

/* ── Basemap / fullscreen / sidebar (from the GEARS map) ─────────── */
const BASEMAPS = {
    satellite: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], labels: false },
    hybrid:    { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], labels: true },
    usgs:      { tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"], labels: false },
    streets:   { tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], labels: false },
};
let currentBasemap = "hybrid";
document.getElementById("basemap-btn").addEventListener("click", () => document.getElementById("basemap-menu").classList.toggle("hidden"));
document.addEventListener("click", (e) => { if (!e.target.closest(".basemap-selector")) document.getElementById("basemap-menu").classList.add("hidden"); });
document.querySelectorAll(".basemap-option").forEach(opt => opt.addEventListener("click", () => {
    const id = opt.dataset.basemap; if (id === currentBasemap) return;
    currentBasemap = id; const bm = BASEMAPS[id];
    const src = map.getSource("satellite"); if (src) src.setTiles(bm.tiles);
    ["labels","roads"].forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", bm.labels ? "visible" : "none"); });
    document.querySelectorAll(".basemap-option").forEach(o => o.classList.remove("active"));
    opt.classList.add("active"); document.getElementById("basemap-menu").classList.add("hidden");
}));

const fsBtn = document.getElementById("fullscreen-btn");
fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    document.documentElement.requestFullscreen().catch(() => window.open(location.href, "_blank"));
});
document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    document.getElementById("fs-expand").style.display = isFs ? "none" : "block";
    document.getElementById("fs-collapse").style.display = isFs ? "block" : "none";
    setTimeout(() => map.resize(), 100);
});

function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const sidebar = document.getElementById("sidebar"), sidebarToggle = document.getElementById("sidebar-toggle");
sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("sidebar-closed"); sidebar.classList.toggle("sidebar-open");
    setTimeout(() => map.resize(), 300);
});
function checkSidebarFit() {
    if (window.innerWidth < 900) {
        sidebarToggle.classList.add("visible");
        if (sidebar.classList.contains("sidebar-open")) { sidebar.classList.remove("sidebar-open"); sidebar.classList.add("sidebar-closed"); setTimeout(() => map.resize(), 300); }
    } else {
        sidebarToggle.classList.remove("visible"); sidebar.classList.remove("sidebar-closed"); sidebar.classList.add("sidebar-open"); setTimeout(() => map.resize(), 300);
    }
}
checkSidebarFit();
window.addEventListener("resize", debounce(checkSidebarFit, 200));
