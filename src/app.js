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
  buildRadarTileUrl,
  cloudSlotFor,
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

// Zürich, if geolocation is denied. Zoom 7 is the RainViewer radar's native
// ceiling, so the default view is exactly as sharp as that data gets.
const FALLBACK_VIEW = { lat: 47.3769, lon: 8.5417, zoom: 7 };
const FRAME_MS = 500; // animation speed
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
};

const activeFrames = () => (state.source === 'ch' ? state.ch.frames : state.frames);

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
    const { host, frames } = parseWeatherMaps(await res.json());

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
      ui.scrub.max = String(frames.length - 1);
      ui.scrub.disabled = false;
      showFrame(frames.length - 1); // newest frame, then loop from there
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
    if (state.source === 'ch') {
      ui.scrub.max = String(state.ch.frames.length - 1);
      ui.scrub.disabled = false;
    }

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
      if (state.source === 'ch' && state.ch.frames.length) {
        ui.scrub.max = String(state.ch.frames.length - 1);
      }
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
  showFrame(state.ch.frames.length - 1);
  setStatus('');
}

function disableSwiss({ message } = {}) {
  state.source = 'rv';
  ui.ch.checked = false;
  for (const overlay of state.ch.overlays.values()) overlay.setOpacity(0);
  ui.scrub.max = String(Math.max(0, state.frames.length - 1));
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

  if (state.source === 'ch') {
    for (const layer of state.layers.values()) layer.setOpacity(0);
    for (const [t, overlay] of state.ch.overlays) {
      overlay.setOpacity(t === frame.time ? RADAR_OPACITY : 0);
    }
  } else {
    for (const overlay of state.ch.overlays.values()) overlay.setOpacity(0);
    for (const [idx, layer] of state.layers) {
      if (idx !== state.index) layer.setOpacity(0);
    }
    const current = layerFor(state.index);
    if (current) current.setOpacity(RADAR_OPACITY);
    layerFor(nextIndex(state.index, frames.length)); // warm the next frame
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

// The loop pauses on the newest frame for a few beats, so a glance at the
// playing page usually lands on the current picture, not mid-history.
const NEWEST_DWELL_TICKS = 4;
let dwell = 0;

function tick() {
  const frames = activeFrames();
  // While the Swiss backfill runs, hold on the newest frame instead of
  // flashing blank slots for frames that aren't decoded yet.
  if (state.source === 'ch' && frames.some((f) => !state.ch.overlays.has(f.time))) {
    showFrame(frames.length - 1);
    return;
  }
  if (state.index === frames.length - 1 && dwell < NEWEST_DWELL_TICKS) {
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

map.on('moveend', refreshForecastForView);

// Animating a tab nobody is looking at just burns battery and quota.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(state.timer);
    state.timer = null;
  } else {
    if (state.playing) setPlaying(true);
    refreshAll();
  }
});

function refreshAll() {
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
