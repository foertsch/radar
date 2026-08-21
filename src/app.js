/**
 * Wiring: Leaflet map, animated radar loop, satellite overlay, forecast strip.
 *
 * Two radar sources share one timeline UI:
 *  - 'rv'  RainViewer tiles — global, ~10-min frames, the default everywhere.
 *  - 'ch'  MeteoSwiss open data — 1 km / 5-min frames rendered in the browser
 *          (h5wasm decode + precomputed LUT; see src/swiss.js and
 *          meteoswiss/VERDICT.md for the verification). Auto-enabled when the
 *          view is inside the Swiss composite, with fallback to RainViewer on
 *          any failure.
 *
 * Layer stack, bottom to top: basemap (no labels) → clouds (z 350) → RainViewer
 * radar tiles (z 400, tile pane) → Swiss radar overlays (overlay pane) →
 * place-name labels (own pane, 550) → location pin (marker pane, 600).
 *
 * All decision logic lives in radar.js / swiss.js so it can be tested without
 * a browser.
 */

import {
  RAINVIEWER_INDEX,
  INDEX_REFRESH_MS,
  RADAR_MAX_NATIVE_ZOOM,
  DWD_COVERAGE,
  buildRadarTileUrl,
  cloudSlotFor,
  dwdImageUrl,
  forecastTimes,
  frameLabel,
  haversineKm,
  nextIndex,
  parseWeatherMaps,
  summarizeNowcast,
} from './radar.js';

import {
  CH_FRAMES,
  frameWindow,
  inBounds,
  newestRzcTimes,
  renderRgba,
  rzcAssetUrl,
  rzcProbeCandidates,
  stacItemUrl,
} from './swiss.js';

import { CH_BORDER } from './ch-border.js';
import { FOREIGN_LABELS, WORLD_RING, focusActive, labelVisible } from './focus.js';

// Zürich, if geolocation is denied. Zoom 7 is the RainViewer radar's native
// ceiling, so the default view is exactly as sharp as that data gets.
const FALLBACK_VIEW = { lat: 47.3769, lon: 8.5417, zoom: 7 };
const FRAME_MS = 500; // animation speed
const PAST_MIN = 30; // observed history kept on the timeline; the rest is forecast
const RADAR_OPACITY = 0.75;
const CLOUD_OPACITY = 0.45; // enough to read cloud structure without burying the map
const MAX_CLOUD_LAYERS = 16; // 2 h of frames spans ~9 cloud slots; prune beyond this
const FORECAST_REFRESH_MS = 10 * 60 * 1000;
const REFETCH_AFTER_KM = 20; // pan further than this and the local forecast is re-fetched

const el = (id) => document.getElementById(id);
const ui = {
  play: el('play'),
  scrub: el('scrub'),
  stamp: el('stamp'),
  ch: el('ch'),
  sat: el('sat'),
  locate: el('locate'),
  nowcast: el('nowcast'),
  status: el('status'),
};

const state = {
  source: 'rv', // which radar drives the timeline: 'rv' | 'ch'
  // RainViewer
  host: '',
  frames: [],
  layers: new Map(), // frame index -> L.TileLayer, created lazily
  // MeteoSwiss (populated lazily on first enable)
  ch: {
    meta: null, // swiss/lut.json
    lut: null, // Uint32Array
    h5: null, // h5wasm module
    fs: null, // its filesystem
    frames: [], // [{time, kind}] ascending — the target list
    overlays: new Map(), // time -> L.ImageOverlay (only fully decoded frames)
    failed: false,
    loading: false,
    autoTried: false,
  },
  index: 0,
  playing: true,
  timer: null,
  forecastAt: null, // {lat, lon} the strip currently describes
  forecast: [], // [{time, kind: 'nowcast'}] appended after the observed frames
  forecastDead: new Set(), // step times the newest DWD run couldn't serve
};

const pastFrames = () => (state.source === 'ch' ? state.ch.frames : state.frames);
const activeFrames = () => pastFrames().concat(state.forecast);

function syncScrub() {
  const n = activeFrames().length;
  ui.scrub.max = String(Math.max(0, n - 1));
  ui.scrub.disabled = n === 0;
}

/* ------------------------------------------------------------------ map --- */

const map = L.map('map', {
  center: [FALLBACK_VIEW.lat, FALLBACK_VIEW.lon],
  zoom: FALLBACK_VIEW.zoom,
  zoomControl: true,
  attributionControl: true,
});

/**
 * Kept short so it fits one line on a phone. "Weather data by RainViewer" with
 * a link back is RainViewer's stated condition; "Source: MeteoSwiss" is
 * MeteoSwiss's required citation form.
 */
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &middot; ' +
  '<a href="https://carto.com/attributions">CARTO</a> | ' +
  'Weather data by <a href="https://www.rainviewer.com/">RainViewer</a> | ' +
  'Source: <a href="https://www.meteoswiss.admin.ch/">MeteoSwiss</a> | ' +
  'Forecast: <a href="https://www.dwd.de/">DWD</a> | ' +
  '<a href="https://www.eumetsat.int/">EUMETSAT</a> | ' +
  '<a href="https://open-meteo.com/">Open-Meteo</a>';

/**
 * Basemap split: geography below the data layers, place names above them in
 * their own pane, so labels stay readable through radar and clouds. CARTO
 * ships matching nolabels/only_labels variants of both themes.
 */
const BASEMAPS = {
  light: {
    base: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  },
  dark: {
    base: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
  },
};

map.createPane('labels');
map.getPane('labels').style.zIndex = 550; // data layers < labels < markers (600)
map.getPane('labels').style.pointerEvents = 'none';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function makeBasemap(dark) {
  const urls = BASEMAPS[dark ? 'dark' : 'light'];
  return {
    base: L.tileLayer(urls.base, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map),
    labels: L.tileLayer(urls.labels, { maxZoom: 19, pane: 'labels' }).addTo(map),
  };
}

let basemap = makeBasemap(darkQuery.matches);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

darkQuery.addEventListener('change', (e) => {
  map.removeLayer(basemap.base);
  map.removeLayer(basemap.labels);
  basemap = makeBasemap(e.matches);
  basemap.base.bringToBack();
  veil.setStyle(VEIL_STYLE[e.matches ? 'dark' : 'light']);
});

/* ------------------------------------------------------------ Swiss focus --- */

/**
 * De-emphasize everything outside Switzerland: a gentle veil over foreign
 * areas (with the border as its edge), the detailed CARTO label layer clipped
 * to the country, and a curated minimal set of foreign labels instead.
 * The treatment switches itself off when the view leaves the Swiss region —
 * a dimmed, label-less map would be useless over Hamburg.
 */
map.createPane('veil');
map.getPane('veil').style.zIndex = 250; // above the basemap, below clouds/radar
map.getPane('veil').style.pointerEvents = 'none';
map.createPane('liteLabels'); // minimal foreign labels; never clipped
map.getPane('liteLabels').style.zIndex = 545;
map.getPane('liteLabels').style.pointerEvents = 'none';

const VEIL_STYLE = {
  dark: { fillColor: '#04070b', fillOpacity: 0.42, color: '#8b98a5', opacity: 0.45 },
  light: { fillColor: '#f6f5f2', fillOpacity: 0.5, color: '#5c6b7a', opacity: 0.4 },
};

// World ring with Switzerland as a hole; the stroke doubles as the border line.
const veil = L.polygon([WORLD_RING, CH_BORDER], {
  pane: 'veil',
  weight: 1,
  interactive: false,
  ...VEIL_STYLE[darkQuery.matches ? 'dark' : 'light'],
});

const foreignMarkers = FOREIGN_LABELS.map((l) =>
  L.marker([l.lat, l.lng], {
    pane: 'liteLabels',
    interactive: false,
    keyboard: false,
    // Leaflet positions the icon element itself via transform, so the
    // centering translate lives on an inner span (see .geo-label css).
    icon: L.divIcon({
      className: `geo-label geo-label--${l.kind}`,
      html: `<span>${l.name}</span>`,
      iconSize: null,
    }),
  }),
);

let focusOn = false;

/** Clip the detailed label layer to the border, in layer-point coordinates. */
function updateLabelsClip() {
  if (!focusOn) return;
  const pts = CH_BORDER.map((ll) => {
    const p = map.latLngToLayerPoint(ll);
    return `${Math.round(p.x)}px ${Math.round(p.y)}px`;
  });
  map.getPane('labels').style.clipPath = `polygon(${pts.join(',')})`;
}

function updateForeignLabelZoom() {
  const z = map.getZoom();
  foreignMarkers.forEach((m, i) => {
    const el = m.getElement();
    if (el) el.style.display = focusOn && labelVisible(FOREIGN_LABELS[i], z) ? '' : 'none';
  });
}

function setFocus(on) {
  if (on === focusOn) return;
  focusOn = on;
  if (on) {
    veil.addTo(map);
    for (const m of foreignMarkers) m.addTo(map);
    updateLabelsClip();
  } else {
    map.removeLayer(veil);
    for (const m of foreignMarkers) map.removeLayer(m);
    map.getPane('labels').style.clipPath = '';
  }
  updateForeignLabelZoom();
}

function updateFocus() {
  const c = map.getCenter();
  setFocus(focusActive(c.lat, c.lng));
}

map.on('move zoom viewreset', updateLabelsClip);
map.on('zoomend', updateForeignLabelZoom);

// A page opened in a hidden tab boots with a 0x0 map; once the container gets
// real dimensions, build the forecast overlays that were skipped.
map.on('resize', () => {
  updateForecast();
  refreshForecastView();
});

/* ------------------------------------------------------------- location pin --- */

const locationPin = L.marker([0, 0], {
  icon: L.divIcon({ className: 'here-pin', iconSize: [16, 16], iconAnchor: [8, 8] }),
  interactive: false,
  keyboard: false,
});

function pinAt(lat, lon) {
  locationPin.setLatLng([lat, lon]);
  if (!map.hasLayer(locationPin)) locationPin.addTo(map);
}

/* ---------------------------------------------------------------- clouds --- */

/**
 * EUMETSAT Meteosat infrared, one WMS layer per 15-minute slot so the clouds
 * move with the radar timelapse. The layer only advertises EPSG:4326 in its
 * capabilities, but GeoServer serves EPSG:3857 fine — which is what Leaflet
 * asks for. Slots newer than the publication lag 502 rather than clamp, so
 * cloudSlotFor pins recent frames to the newest safe slot; satSteps walks
 * further back if even that proves optimistic.
 */
const cloudLayers = new Map(); // ISO slot -> L.TileLayer.WMS
let satSteps = 0;
let satStepping = false;

function cloudLayerFor(slot) {
  if (cloudLayers.has(slot)) return cloudLayers.get(slot);
  const layer = L.tileLayer.wms('https://view.eumetsat.int/geoserver/wms', {
    layers: 'msg_fes:ir108',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0,
    zIndex: 350, // above the basemap, below both radars
    time: slot,
    attribution: '',
  });
  layer.on('tileerror', () => {
    if (satStepping || satSteps >= 4) return;
    satStepping = true;
    satSteps += 1;
    setTimeout(() => (satStepping = false), 2000);
    showClouds(); // recompute the clamp with the new walk-back state
  });
  layer.addTo(map);
  cloudLayers.set(slot, layer);
  return layer;
}

/** Show the cloud slot matching the current radar frame (or hide everything). */
function showClouds() {
  const frames = activeFrames();
  const frame = frames[state.index];
  if (!ui.sat.checked || !frame) {
    for (const layer of cloudLayers.values()) layer.setOpacity(0);
    return;
  }
  const slot = cloudSlotFor(frame.time, Date.now(), satSteps);
  cloudLayerFor(slot);
  for (const [s, layer] of cloudLayers) layer.setOpacity(s === slot ? CLOUD_OPACITY : 0);

  // Old slots accumulate as the timeline window slides; drop the excess.
  if (cloudLayers.size > MAX_CLOUD_LAYERS) {
    for (const s of [...cloudLayers.keys()].sort().slice(0, cloudLayers.size - MAX_CLOUD_LAYERS)) {
      if (s !== slot) {
        map.removeLayer(cloudLayers.get(s));
        cloudLayers.delete(s);
      }
    }
  }
}

/* -------------------------------------------------------- forecast radar --- */

/**
 * DWD's WN composite (analysis + nowcast) extends the timeline past "now".
 * One single-image WMS overlay per 15-min step, opacity-switched like
 * everything else. DWD's GeoServer takes ~5 s per GetMap and serializes a
 * client's concurrent requests, so tiled loading could never finish — one
 * padded-viewport image per step keeps the whole forecast at 8 requests,
 * created nearest-first at boot and reused until the view outgrows the
 * padding. A step beyond the newest run's horizon answers with a WMS
 * exception (unloadable as an image), which drops that step after one retry.
 *
 * Honest caveats, also in the README: this is the German composite — it sees
 * Switzerland from outside, so the picture is coarser than the Swiss frames
 * before it, and Valais/Ticino sit at its range edge.
 */
const forecastLayers = new Map(); // ISO time -> {overlay, builtBounds, builtZoom, retried}

const isoOf = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Padded view + image size for a forecast GetMap, or null while the map has
 * no real size — a page booted in a hidden tab has a 0x0 container, and specs
 * computed then are degenerate (point bbox, WIDTH=0). Building from them got
 * every forecast frame dead-dropped; the map's 'resize' event triggers the
 * rebuild once the container becomes visible.
 */
function forecastViewSpec() {
  const size = map.getSize();
  if (size.x < 50 || size.y < 50) return null;
  const bounds = map.getBounds().pad(0.3);
  const nw = L.CRS.EPSG3857.project(bounds.getNorthWest());
  const se = L.CRS.EPSG3857.project(bounds.getSouthEast());
  const bbox = [nw.x, se.y, se.x, nw.y].map(Math.round);
  const width = Math.min(1600, Math.round(size.x * 1.6));
  const height = Math.round((width * (bbox[3] - bbox[1])) / (bbox[2] - bbox[0]));
  return { bounds, bbox, width, height };
}

function dropForecastFrame(t) {
  const iso = isoOf(t);
  const info = forecastLayers.get(iso);
  if (info) {
    map.removeLayer(info.overlay);
    forecastLayers.delete(iso);
  }
  state.forecastDead.add(t);
  state.forecast = state.forecast.filter((f) => f.time !== t);
  syncScrub();
  if (state.index >= activeFrames().length) showFrame(activeFrames().length - 1);
}

function forecastLayerFor(t) {
  const iso = isoOf(t);
  if (forecastLayers.has(iso)) return forecastLayers.get(iso).overlay;
  const spec = forecastViewSpec();
  if (!spec) return null; // hidden/zero-size map — the 'resize' handler rebuilds
  const overlay = L.imageOverlay(
    dwdImageUrl(iso, spec.bbox, spec.width, spec.height),
    spec.bounds,
    { opacity: 0, zIndex: 400 },
  );
  const info = { overlay, builtBounds: spec.bounds, builtZoom: map.getZoom(), retried: false };
  overlay.on('error', () => {
    if (!info.retried) {
      // Transient failure gets one retry; a WMS exception (beyond the newest
      // run's horizon) fails identically twice and condemns the frame.
      info.retried = true;
      const s = forecastViewSpec();
      if (!s) return; // map lost its size mid-flight; resize will rebuild
      setTimeout(() => overlay.setUrl(dwdImageUrl(iso, s.bbox, s.width, s.height)), 2000);
      return;
    }
    dropForecastFrame(t);
  });
  overlay.addTo(map);
  forecastLayers.set(iso, info);
  return overlay;
}

/** Re-request forecast images when the view leaves what they were built for. */
function refreshForecastView() {
  const spec = forecastViewSpec();
  if (!spec) return;
  const current = map.getBounds();
  const zoom = map.getZoom();
  for (const [iso, info] of forecastLayers) {
    if (info.builtBounds.contains(current) && zoom - info.builtZoom < 2) continue;
    info.builtBounds = spec.bounds;
    info.builtZoom = zoom;
    info.retried = false;
    info.overlay.setBounds(spec.bounds);
    info.overlay.setUrl(dwdImageUrl(iso, spec.bbox, spec.width, spec.height));
  }
}

/** Rebuild the forecast tail whenever the newest observed frame or view changes. */
function updateForecast() {
  const newest = pastFrames().at(-1)?.time;
  const c = map.getCenter();
  const covered = newest && inBounds(DWD_COVERAGE, c.lat, c.lng);
  const times = covered ? forecastTimes(newest).filter((t) => !state.forecastDead.has(t)) : [];

  state.forecast = times.map((time) => ({ time, kind: 'nowcast' }));

  // Create every layer up front (opacity 0) so its tiles load while the loop
  // is still playing the observed frames — lazily creating them mid-forecast
  // meant every frame's first appearance was blank.
  for (const t of times) forecastLayerFor(t);

  // Prune layers and dead-marks that aged out of the window.
  const live = new Set(times.map(isoOf));
  for (const [iso, info] of forecastLayers) {
    if (!live.has(iso)) {
      map.removeLayer(info.overlay);
      forecastLayers.delete(iso);
    }
  }
  const window = new Set(newest ? forecastTimes(newest) : []);
  for (const t of state.forecastDead) if (!window.has(t)) state.forecastDead.delete(t);

  syncScrub();
  if (state.index >= activeFrames().length) state.index = Math.max(0, activeFrames().length - 1);
}

/* ---------------------------------------------------------------- status --- */

let statusTimer = null;
function setStatus(message, { sticky = false } = {}) {
  clearTimeout(statusTimer);
  if (!message) {
    ui.status.hidden = true;
    return;
  }
  ui.status.textContent = message;
  ui.status.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (ui.status.hidden = true), 6000);
}

/* ------------------------------------------------------- RainViewer radar --- */

/** Create a frame's tile layer on demand; already-built layers are reused. */
function layerFor(i) {
  if (state.layers.has(i)) return state.layers.get(i);
  const frame = state.frames[i];
  if (!frame) return null;

  const layer = L.tileLayer(buildRadarTileUrl(state.host, frame), {
    tileSize: 256, // 512-px images drawn into 256 CSS px = crisp on retina displays
    maxNativeZoom: RADAR_MAX_NATIVE_ZOOM, // upscale rather than request unsupported tiles
    opacity: 0,
    zIndex: 400,
  });

  // A dozen-odd frames requesting a screenful of tiles each is a burst of a few
  // hundred requests, and browsers drop some of them. The tiles themselves are
  // fine (RainViewer caches them for two days), so one retry is enough.
  layer.on('tileerror', (e) => {
    const img = e.tile;
    if (!img || img.dataset.retried) return;
    img.dataset.retried = '1';
    const src = img.src;
    img.src = '';
    setTimeout(() => (img.src = src), 800);
  });

  state.layers.set(i, layer);
  layer.addTo(map);
  return layer;
}

async function loadFrames() {
  try {
    const res = await fetch(RAINVIEWER_INDEX, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseWeatherMaps(await res.json());
    const host = parsed.host;
    // Observed frames only, trimmed to the shared 30-min history window —
    // the timeline's future half comes from the DWD forecast, not RainViewer.
    let frames = parsed.frames.filter((f) => f.kind === 'past');
    if (frames.length) {
      const newest = frames[frames.length - 1].time;
      frames = frames.filter((f) => f.time >= newest - PAST_MIN * 60);
    }

    if (!frames.length) {
      setStatus('No radar frames available right now.', { sticky: true });
      return;
    }

    // Frames roll forward every few minutes. Drop the layers we built for frames
    // that have aged out, otherwise the map accumulates dead tile layers.
    const live = new Set(frames.map((f) => f.time));
    for (const [idx, layer] of state.layers) {
      if (!state.frames[idx] || !live.has(state.frames[idx].time)) {
        map.removeLayer(layer);
        state.layers.delete(idx);
      }
    }
    // Indices shift when the window slides, so rebuild the cache keyed by the new list.
    const byTime = new Map();
    for (const [idx, layer] of state.layers) byTime.set(state.frames[idx].time, layer);
    state.layers = new Map();
    frames.forEach((f, i) => {
      if (byTime.has(f.time)) state.layers.set(i, byTime.get(f.time));
    });

    state.host = host;
    state.frames = frames;

    if (state.source === 'rv') {
      updateForecast();
      showFrame(frames.length - 1); // newest observed frame, then loop from there
      setStatus('');
    }
  } catch (err) {
    setStatus(`Could not load radar: ${err.message}`, { sticky: true });
  }
}

/* -------------------------------------------------------- MeteoSwiss radar --- */

// Reusable canvas for turning decoded grids into PNG blobs; sized after lut.json loads.
const chCanvas = document.createElement('canvas');

/** One-time setup: LUT, metadata, and the h5wasm decoder (~2 MB, lazy). */
async function swissInit() {
  if (state.ch.meta) return;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('browser too old (no DecompressionStream)');
  }
  const okJson = async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url}`);
    return r;
  };
  // fetch() resolves against the page (repo root); import() against this module.
  const [metaRes, lutRes, h5mod] = await Promise.all([
    fetch('swiss/lut.json').then(okJson),
    fetch('swiss/lut.bin.gz').then(okJson),
    import('../swiss/h5wasm/hdf5_hl.js'),
  ]);
  const meta = await metaRes.json();
  const lutBuf = await new Response(
    lutRes.body.pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer();
  const lut = new Uint32Array(lutBuf);
  if (lut.length !== meta.width * meta.height) throw new Error('LUT size mismatch');

  const h5wasm = h5mod.default;
  const module = await h5wasm.ready;
  chCanvas.width = meta.width;
  chCanvas.height = meta.height;
  Object.assign(state.ch, { meta, lut, h5: h5wasm, fs: module?.FS ?? h5wasm.FS });
}

function chDecode(buf) {
  const { fs, h5, meta } = state.ch;
  fs.writeFile('cur.h5', new Uint8Array(buf));
  const f = new h5.File('cur.h5', 'r');
  const ds = f.get('dataset1/data1/data');
  const shape = ds.shape;
  const vals = ds.value; // Float64Array, row 0 = north
  f.close();
  fs.unlink('cur.h5');
  if (shape[0] !== meta.ny || shape[1] !== meta.nx) throw new Error(`grid shape ${shape}`);
  return vals;
}

async function chBlobUrl(vals) {
  const { meta, lut } = state.ch;
  const img = new ImageData(renderRgba(vals, lut, meta), meta.width, meta.height);
  chCanvas.getContext('2d').putImageData(img, 0, 0);
  const blob = await new Promise((r) => chCanvas.toBlob(r, 'image/png'));
  return URL.createObjectURL(blob);
}

/**
 * Find the newest published frame by probing its deterministic URL directly.
 * The STAC index is CDN-cached for up to 10 minutes, so trusting it can leave
 * the timeline ~20 minutes behind; a HEAD on the expected newest URLs is
 * always fresh (each frame time has its own immutable URL).
 */
async function newestSwissTime() {
  for (const t of rzcProbeCandidates(Date.now() / 1000)) {
    try {
      const r = await fetch(rzcAssetUrl(t), { method: 'HEAD', cache: 'no-store' });
      if (r.ok) return t;
    } catch {
      /* transient network error — try the next slot */
    }
  }
  return null;
}

/** STAC listing as fallback discovery, if the probe scheme ever breaks. */
async function swissTimesFromStac() {
  const now = Date.now() / 1000;
  const items = [];
  for (const back of [0, 86400]) {
    try {
      const r = await fetch(stacItemUrl(now - back), { cache: 'no-store' });
      if (r.ok) items.push(await r.json());
    } catch {
      /* a day item can be missing just after midnight UTC */
    }
    if (newestRzcTimes(items, CH_FRAMES).length >= CH_FRAMES) break;
  }
  return newestRzcTimes(items, CH_FRAMES);
}

/**
 * Fetch the newest hour of Swiss frames, decoding only what's new.
 * Newest-first, so the current picture appears immediately; the loop
 * (see tick) holds on the newest frame until the backfill completes.
 */
async function swissLoadFrames() {
  if (state.ch.loading) return;
  state.ch.loading = true;
  try {
    const newest = await newestSwissTime();
    const times = newest !== null ? frameWindow(newest, CH_FRAMES) : await swissTimesFromStac();
    if (!times.length) throw new Error('no frames found');

    // Prune aged-out frames and their blob URLs.
    const live = new Set(times);
    for (const [t, overlay] of state.ch.overlays) {
      if (!live.has(t)) {
        map.removeLayer(overlay);
        URL.revokeObjectURL(overlay._blobUrl);
        state.ch.overlays.delete(t);
      }
    }

    state.ch.frames = times.map((time) => ({ time, kind: 'past' }));
    if (state.source === 'ch') updateForecast();

    const failed = new Set();
    for (const t of [...times].reverse()) {
      if (state.ch.overlays.has(t)) continue;
      try {
        const res = await fetch(rzcAssetUrl(t));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const url = await chBlobUrl(chDecode(await res.arrayBuffer()));
        const overlay = L.imageOverlay(url, state.ch.meta.bounds, { opacity: 0, zIndex: 400 });
        overlay._blobUrl = url;
        overlay.addTo(map);
        state.ch.overlays.set(t, overlay);
        // Show the newest frame as soon as it exists.
        if (state.source === 'ch' && t === times[times.length - 1]) {
          showFrame(state.ch.frames.length - 1);
        }
      } catch {
        failed.add(t); // a single 5-min slot can be missing — skip, don't abort
      }
    }
    if (failed.size) {
      state.ch.frames = state.ch.frames.filter((f) => !failed.has(f.time));
      if (state.source === 'ch') updateForecast();
    }
    if (!state.ch.overlays.size) throw new Error('no frames available');
  } finally {
    state.ch.loading = false;
  }
}

async function enableSwiss() {
  setStatus('Loading Swiss radar…');
  await swissInit();
  state.source = 'ch';
  await swissLoadFrames();
  updateForecast();
  showFrame(state.ch.frames.length - 1);
  setStatus('');
}

function disableSwiss({ message } = {}) {
  state.source = 'rv';
  ui.ch.checked = false;
  for (const overlay of state.ch.overlays.values()) overlay.setOpacity(0);
  updateForecast();
  if (state.frames.length) showFrame(state.frames.length - 1);
  if (message) setStatus(message);
}

/* ------------------------------------------------------- shared timeline --- */

/**
 * Show frame `i` of the active source. Layers of the inactive source are held
 * at opacity 0 rather than removed, so switching sources doesn't reload.
 */
function showFrame(i) {
  const frames = activeFrames();
  if (!frames.length) return;
  state.index = ((i % frames.length) + frames.length) % frames.length;
  const frame = frames[state.index];

  if (frame.kind === 'nowcast') {
    // Future: the DWD forecast layer takes over from both observed sources.
    for (const layer of state.layers.values()) layer.setOpacity(0);
    for (const overlay of state.ch.overlays.values()) overlay.setOpacity(0);
    const iso = isoOf(frame.time);
    forecastLayerFor(frame.time);
    for (const [s, info] of forecastLayers) info.overlay.setOpacity(s === iso ? RADAR_OPACITY : 0);
  } else if (state.source === 'ch') {
    for (const info of forecastLayers.values()) info.overlay.setOpacity(0);
    for (const layer of state.layers.values()) layer.setOpacity(0);
    for (const [t, overlay] of state.ch.overlays) {
      overlay.setOpacity(t === frame.time ? RADAR_OPACITY : 0);
    }
  } else {
    for (const info of forecastLayers.values()) info.overlay.setOpacity(0);
    for (const overlay of state.ch.overlays.values()) overlay.setOpacity(0);
    for (const [idx, layer] of state.layers) {
      if (idx !== state.index) layer.setOpacity(0);
    }
    const current = layerFor(state.index);
    if (current) current.setOpacity(RADAR_OPACITY);
    if (state.index + 1 < state.frames.length) {
      layerFor(state.index + 1); // warm the next observed frame
    }
  }

  showClouds();

  ui.scrub.value = String(state.index);
  const clock = new Date(frame.time * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  ui.stamp.textContent = `${clock} · ${frameLabel(frame, Date.now())}`;
  ui.stamp.classList.toggle('is-forecast', frame.kind === 'nowcast');
}

// The loop pauses on the "now" frame (newest observed) for a few beats, so a
// glance at the playing page usually lands on the current picture rather than
// mid-history or mid-forecast.
const NEWEST_DWELL_TICKS = 4;
let dwell = 0;

function tick() {
  const frames = activeFrames();
  const past = pastFrames();
  // While the Swiss backfill runs, hold on the newest observed frame instead
  // of flashing blank slots for frames that aren't decoded yet.
  if (state.source === 'ch' && past.some((f) => !state.ch.overlays.has(f.time))) {
    showFrame(past.length - 1);
    return;
  }
  if (state.index === past.length - 1 && dwell < NEWEST_DWELL_TICKS) {
    dwell += 1;
    return;
  }
  dwell = 0;
  showFrame(nextIndex(state.index, frames.length));
}

function setPlaying(on) {
  state.playing = on;
  clearInterval(state.timer);
  state.timer = on ? setInterval(tick, FRAME_MS) : null;
  ui.play.textContent = on ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  ui.play.setAttribute('aria-pressed', String(on));
}

/* -------------------------------------------------------------- forecast --- */

async function loadForecast(lat, lon) {
  // unixtime removes any doubt about whether a timestamp is local or UTC.
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&minutely_15=precipitation&forecast_minutely_15=12&timeformat=unixtime&timezone=UTC';

  try {
    const res = await fetch(url, { cache: 'no-store' }); // same URL, fresh forecast
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const summary = summarizeNowcast(data.minutely_15, Date.now());

    ui.nowcast.textContent = summary.text;
    ui.nowcast.dataset.state = summary.state;
    state.forecastAt = { lat, lon };
  } catch {
    ui.nowcast.textContent = 'Forecast unavailable';
    ui.nowcast.dataset.state = 'unknown';
  }
}

/** Re-fetch only when the map has actually moved somewhere else. */
function refreshForecastForView() {
  const c = map.getCenter();
  const here = { lat: c.lat, lon: c.lng };
  if (state.forecastAt && haversineKm(state.forecastAt, here) < REFETCH_AFTER_KM) return;
  loadForecast(here.lat, here.lon);
}

/* -------------------------------------------------------------- controls --- */

ui.play.addEventListener('click', () => setPlaying(!state.playing));

ui.scrub.addEventListener('input', () => {
  setPlaying(false);
  showFrame(Number(ui.scrub.value));
});

ui.ch.addEventListener('change', async () => {
  if (ui.ch.checked) {
    try {
      await enableSwiss();
    } catch (err) {
      state.ch.failed = true;
      disableSwiss({ message: `Swiss radar unavailable (${err.message}) — using RainViewer.` });
    }
  } else {
    disableSwiss();
  }
});

ui.sat.addEventListener('change', showClouds);

ui.locate.addEventListener('click', () => locate({ announce: true }));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, button')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.code === 'ArrowLeft') {
    setPlaying(false);
    showFrame(state.index - 1);
  } else if (e.code === 'ArrowRight') {
    setPlaying(false);
    showFrame(state.index + 1);
  }
});

map.on('moveend', () => {
  refreshForecastForView();
  updateForecast(); // panning across the DWD coverage edge adds/removes the tail
  refreshForecastView(); // re-request images the view has outgrown
  updateFocus(); // leaving the Swiss region restores the full-detail map
});

// Animating a tab nobody is looking at just burns battery and quota.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(state.timer);
    state.timer = null;
  } else {
    // A page opened in a hidden tab boots with a 0x0 map and Leaflet only
    // re-measures on window resize — force it, so the forecast overlays that
    // were skipped at boot (see forecastViewSpec) get built now.
    map.invalidateSize();
    if (state.playing) setPlaying(true);
    refreshAll();
  }
});

function refreshAll() {
  // Give condemned forecast steps another chance each cycle — a burst of
  // transient failures (hidden tab, flaky network) must not kill the forecast
  // for the rest of the session. Genuine beyond-horizon steps just fail their
  // two attempts again, which is cheap.
  state.forecastDead.clear();
  loadFrames();
  if (ui.ch.checked) {
    swissLoadFrames().catch((err) => {
      disableSwiss({ message: `Swiss radar update failed (${err.message}) — using RainViewer.` });
    });
  }
}

/* ------------------------------------------------------------------ boot --- */

/**
 * Turn the Swiss layer on automatically the first time the settled view is
 * inside the composite. Once only — after that the toggle is the user's.
 */
function maybeAutoSwiss() {
  if (state.ch.autoTried || state.ch.failed || ui.ch.checked) return;
  const c = map.getCenter();
  // Footprint of the shipped LUT; swissInit re-reads the authoritative value.
  const bounds = state.ch.meta?.bounds ?? [[43.619, 2.689], [49.468, 12.462]];
  if (!inBounds(bounds, c.lat, c.lng)) return;
  state.ch.autoTried = true;
  ui.ch.checked = true;
  ui.ch.dispatchEvent(new Event('change'));
}

function locate({ announce = false } = {}) {
  if (!navigator.geolocation) {
    if (announce) setStatus('This browser has no geolocation support.');
    maybeAutoSwiss();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], Math.max(map.getZoom(), RADAR_MAX_NATIVE_ZOOM));
      pinAt(latitude, longitude);
      loadForecast(latitude, longitude);
      maybeAutoSwiss();
    },
    (err) => {
      // Denied or unavailable: the Zürich fallback view is already on screen.
      if (announce) setStatus(`Location unavailable (${err.message}).`);
      refreshForecastForView();
      maybeAutoSwiss();
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
  );
}

setPlaying(true);
loadFrames();
updateFocus();

// ?at=lat,lon pins an arbitrary spot instead of asking for geolocation —
// bookmarkable places, and the only way to exercise the pin in tests.
const atParam = new URLSearchParams(location.search).get('at');
const at = atParam?.split(',').map(Number);
if (at?.length === 2 && at.every(Number.isFinite)) {
  map.setView([at[0], at[1]], Math.max(map.getZoom(), RADAR_MAX_NATIVE_ZOOM));
  pinAt(at[0], at[1]);
  loadForecast(at[0], at[1]);
  maybeAutoSwiss();
} else {
  locate();
}

setInterval(refreshAll, INDEX_REFRESH_MS);
setInterval(() => {
  state.forecastAt = null; // force a refresh even if the map hasn't moved
  refreshForecastForView();
}, FORECAST_REFRESH_MS);
