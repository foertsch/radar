/**
 * Pure logic for the radar page.
 *
 * Nothing in this file touches the DOM, Leaflet, or the network — that keeps it
 * runnable under `node --test` without a browser or a mock framework. All the
 * wiring lives in app.js.
 */

/** RainViewer's free index of available radar frames. No key, no registration. */
export const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';

/**
 * RainViewer tile knobs — see https://www.rainviewer.com/api/weather-maps-api.html
 *  size:   256 or 512. 512 is the same tile grid at retina density.
 *  color:  colour scheme id. The personal-use tier allows Universal Blue (2) only.
 *  smooth: blur the radar data.
 *  snow:   colour snow separately from rain.
 */
export const RADAR_OPTIONS = { size: 512, color: 2, smooth: 1, snow: 1 };

/**
 * The personal-use tier serves radar only up to zoom 7 ("Max zoom: Level 7,
 * 512px tiles"). Past that it returns a "Zoom Level Not Supported" placeholder
 * rather than an HTTP error, so nothing looks broken — the map just fills with
 * error tiles. Leaflet's maxNativeZoom stops at 7 and upscales instead.
 *
 * At 512px tiles this is roughly 400 m per pixel over Switzerland, so it stays
 * useful; it only softens when you zoom to street level.
 */
export const RADAR_MAX_NATIVE_ZOOM = 7;

/** Radar frames are 5-10 min apart; re-reading the index every 5 min is enough. */
export const INDEX_REFRESH_MS = 5 * 60 * 1000;

/** EUMETSAT publishes MSG imagery on a 15-minute cadence. */
export const SATELLITE_STEP_MIN = 15;

/** Open-Meteo reports precipitation per 15-minute slot. */
export const SLOT_SECONDS = 15 * 60;

/**
 * Below this, a slot is drizzle or model noise rather than rain worth warning about.
 * 0.1 mm per 15 min is Open-Meteo's own reporting resolution.
 */
export const WET_MM = 0.1;

/**
 * Normalise the weather-maps.json payload into a single ascending frame list.
 *
 * `nowcast` is included even though RainViewer's free tier currently returns it
 * empty (forecast frames are a paid feature). Reading it costs nothing and the
 * timeline picks them up automatically if that ever changes.
 *
 * @param {object} json parsed weather-maps.json
 * @returns {{host: string, frames: Array<{time: number, path: string, kind: string}>, generated: number|null}}
 */
export function parseWeatherMaps(json) {
  if (!json || typeof json.host !== 'string') {
    throw new Error('weather-maps.json: missing tile host');
  }
  const radar = json.radar || {};
  const tag = (list, kind) =>
    (Array.isArray(list) ? list : [])
      .filter((f) => f && typeof f.time === 'number' && typeof f.path === 'string')
      .map((f) => ({ time: f.time, path: f.path, kind }));

  const frames = [...tag(radar.past, 'past'), ...tag(radar.nowcast, 'nowcast')].sort(
    (a, b) => a.time - b.time,
  );

  return {
    host: json.host,
    frames,
    generated: typeof json.generated === 'number' ? json.generated : null,
  };
}

/**
 * Build a Leaflet tile template for one radar frame.
 * @returns {string} URL with {z}/{x}/{y} placeholders left intact
 */
export function buildRadarTileUrl(host, frame, options = {}) {
  const { size, color, smooth, snow } = { ...RADAR_OPTIONS, ...options };
  return `${host}${frame.path}/${size}/{z}/{x}/{y}/${color}/${smooth}_${snow}.png`;
}

/**
 * How far behind real time EUMETSAT publishes.
 *
 * The layer declares nearestValue="1", but that only snaps *backwards* — asking
 * for a slot newer than the newest one published returns HTTP 502, not the
 * closest match. Measured lag is around 33 minutes, so 45 leaves headroom
 * without showing a needlessly old image. `satelliteSlot` can walk further back
 * when even that turns out to be too optimistic.
 */
export const SATELLITE_LAG_MIN = 45;

/**
 * Floor a timestamp to the 15-minute grid EUMETSAT publishes on.
 * @returns {string} ISO-8601 UTC, e.g. "2026-08-17T08:15:00Z"
 */
export function latestSatelliteSlot(nowMs, stepMin = SATELLITE_STEP_MIN) {
  const stepMs = stepMin * 60 * 1000;
  const floored = Math.floor(nowMs / stepMs) * stepMs;
  return new Date(floored).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The satellite timestamp to actually request: the newest slot we can be
 * confident exists, optionally stepping further back after a failure.
 *
 * Requesting an explicit time also gives the tile a stable cache key. Omitting
 * TIME would work, but the server answers those with max-age=604800 — the
 * clouds would then be frozen at whatever they looked like a week ago.
 *
 * @param {number} nowMs
 * @param {number} stepsBack extra 15-minute steps to rewind
 */
export function satelliteSlot(nowMs, stepsBack = 0) {
  const lagMs = (SATELLITE_LAG_MIN + stepsBack * SATELLITE_STEP_MIN) * 60 * 1000;
  return latestSatelliteSlot(nowMs - lagMs);
}

/**
 * The satellite slot to show alongside a radar frame, so the clouds move with
 * the timelapse instead of freezing at "latest".
 *
 * Historical frames get the slot they fall into; frames newer than what
 * EUMETSAT has published yet (it runs ~SATELLITE_LAG_MIN behind) clamp to the
 * newest safe slot — requesting beyond it returns HTTP 502, not the nearest
 * image. `stepsBack` carries the same walk-back state used for "latest".
 *
 * @param {number} frameTimeS radar frame time, unix seconds
 * @param {number} nowMs
 */
export function cloudSlotFor(frameTimeS, nowMs, stepsBack = 0) {
  const lagMs = (SATELLITE_LAG_MIN + stepsBack * SATELLITE_STEP_MIN) * 60 * 1000;
  return latestSatelliteSlot(Math.min(frameTimeS * 1000, nowMs - lagMs));
}

/**
 * Turn Open-Meteo's 15-minute precipitation series into one line of plain English.
 *
 * This is the replacement for RainViewer's paid nowcast frames: it answers
 * "will it rain on me soon" for any coordinates, rather than drawing forecast
 * blobs on the map.
 *
 * Times must be unix seconds — the caller requests `timeformat=unixtime` so we
 * never have to guess whether a bare ISO string means local or UTC.
 *
 * @param {{time: number[], precipitation: number[]}} minutely
 * @param {number} nowMs
 */
export function summarizeNowcast(minutely, nowMs) {
  const times = minutely?.time ?? [];
  const mm = minutely?.precipitation ?? [];

  if (!times.length) {
    return { state: 'unknown', changeAt: null, minutes: null, horizonHours: 0, text: 'Forecast unavailable' };
  }

  const nowS = Math.floor(nowMs / 1000);
  // The slot starting at t covers [t, t+15min), so the current slot is the first
  // one that hasn't finished yet.
  const start = times.findIndex((t) => t + SLOT_SECONDS > nowS);
  if (start === -1) {
    return { state: 'unknown', changeAt: null, minutes: null, horizonHours: 0, text: 'Forecast out of date' };
  }

  const isWet = (i) => (mm[i] ?? 0) >= WET_MM;
  const wetNow = isWet(start);

  let change = -1;
  for (let i = start + 1; i < times.length; i++) {
    if (isWet(i) !== wetNow) {
      change = i;
      break;
    }
  }

  const horizonHours = Math.max(
    1,
    Math.round((times[times.length - 1] + SLOT_SECONDS - nowS) / 3600),
  );

  if (change === -1) {
    return {
      state: wetNow ? 'wet' : 'dry',
      changeAt: null,
      minutes: null,
      horizonHours,
      text: wetNow
        ? `Raining — no let-up in the next ${horizonHours} h`
        : `Dry — no rain in the next ${horizonHours} h`,
    };
  }

  const minutes = Math.max(0, Math.round((times[change] - nowS) / 60));
  const when = minutes < 5 ? 'within minutes' : `in ~${minutes} min`;

  return {
    state: wetNow ? 'wet' : 'dry',
    changeAt: times[change],
    minutes,
    horizonHours,
    text: wetNow ? `Raining — easing ${when}` : `Dry — rain likely ${when}`,
  };
}

/* ------------------------------------------------------------- forecast --- */

/**
 * DWD's WN product (analysis + nowcast, 5-min steps) is the only freely
 * embeddable gridded precipitation forecast; it reaches 2 hours ahead.
 * 15-minute display steps are plenty — extrapolation detail below that is
 * illusory at +1-2 h anyway.
 */
export const FORECAST_STEP_MIN = 15;
export const FORECAST_HORIZON_MIN = 120;

/**
 * Single-image WMS GetMap URL for one forecast step over a 3857 bbox.
 *
 * DWD's GeoServer takes ~5 s per GetMap and serializes concurrent requests
 * from one client, so tiled loading (dozens of tiles x 8 steps) can never
 * finish. One padded-viewport image per step keeps the whole forecast at
 * 8 requests, loaded nearest-first and reused until the view outgrows it.
 */
export function dwdImageUrl(iso, bbox, width, height) {
  return (
    'https://maps.dwd.de/geoserver/dwd/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
    '&LAYERS=dwd:Radar_wn-product_1x1km_ger&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE' +
    `&CRS=EPSG:3857&BBOX=${bbox.join(',')}&WIDTH=${width}&HEIGHT=${height}&TIME=${iso}`
  );
}

/**
 * DWD's default WN style, verbatim from a WMS GetStyles response
 * (SLD ColorMap, type "intervals"): [lower dBZ, upper dBZ, hex colour].
 * DWD forbids dynamic SLDs, so the page repaints these colours client-side
 * into the MeteoSwiss palette (buildDwdRemap) for a visually continuous
 * timeline. The style's "no data" grey (#7d7d7d at half opacity) and the
 * domain-border magenta are NOT listed — unknown colours remap to transparent,
 * which removes them.
 */
export const DWD_STYLE_DBZ = [
  [7, 9.5, '99ffff'],
  [9.5, 12, '33ffff'],
  [12, 14.5, '00caca'],
  [14.5, 19, '009934'],
  [19, 23.5, '4dbf1a'],
  [23.5, 28, '99cc00'],
  [28, 32.5, 'cce600'],
  [32.5, 37, 'ffff00'],
  [37, 41.5, 'ffc400'],
  [41.5, 46, 'ff8900'],
  [46, 50.5, 'ff0000'],
  [50.5, 55, 'b40000'],
  [55, 60, '4848ff'],
  [60, 65, '0000ca'],
  [65, 75, '990099'],
  [75, 85, 'ff33ff'],
  [85, 95, '000000'],
];

/** Rain rate in mm/h from reflectivity, Marshall-Palmer Z = 200 R^1.6. */
export function mmPerHourFromDbz(dbz) {
  return (10 ** (dbz / 10) / 200) ** (1 / 1.6);
}

/**
 * Colour translation table: DWD style colour -> MeteoSwiss band RGBA.
 * Each DWD dBZ interval is assigned the band its midpoint rain rate falls in;
 * the band's alpha comes from the shared legend, so forecast drizzle is as
 * translucent as observed drizzle.
 *
 * @param {{bounds: number[], colors: string[], alphas?: number[]}} legend swiss/lut.json legend
 * @returns {Map<string, number[]>} 'r,g,b' -> [r, g, b, a]
 */
export function buildDwdRemap(legend) {
  const hex = (c) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  const alphas = legend.alphas ?? legend.colors.map(() => 255);
  const remap = new Map();
  for (const [lo, hi, color] of DWD_STYLE_DBZ) {
    const rate = mmPerHourFromDbz((lo + hi) / 2);
    let band = 0;
    while (band < legend.bounds.length && rate >= legend.bounds[band]) band++;
    remap.set(hex(color).join(','), [...hex(legend.colors[band]), alphas[band]]);
  }
  return remap;
}

/**
 * Repaint a DWD GetMap image in place: known style colours become their
 * MeteoSwiss equivalents, everything else (no-data grey, domain borders,
 * antialiased blends) becomes transparent.
 *
 * @param {Uint8ClampedArray} data RGBA pixels (ImageData.data)
 * @param {Map<string, number[]>} remap from buildDwdRemap
 */
export function remapDwdImage(data, remap) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const mapped = remap.get(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    if (mapped) {
      data[i] = mapped[0];
      data[i + 1] = mapped[1];
      data[i + 2] = mapped[2];
      data[i + 3] = mapped[3];
    } else {
      data[i + 3] = 0;
    }
  }
  return data;
}

/**
 * Approximate footprint of the German radar composite, [[south, west],
 * [north, east]]. Forecast frames are only offered inside it — elsewhere an
 * empty forecast layer would read as "no rain coming", which is worse than
 * no forecast. Southwestern Switzerland (Valais/Ticino) sits at the range
 * edge and is only partially covered.
 */
export const DWD_COVERAGE = [
  [45.7, 3.1],
  [55.9, 17.0],
];

/**
 * Future frame times after the newest observed frame, ascending, aligned to
 * the absolute 15-minute grid (…:00, :15, :30, :45) rather than offset from
 * the anchor. Grid alignment means a 5-minute advance of the newest frame
 * usually produces the *same* time list, so the WMS layers built for the
 * previous cycle are reused instead of being pruned and re-requested — the
 * re-request flood was what left forecast frames blank. Steps beyond the
 * current run's horizon answer with a WMS exception and are dropped by the
 * caller's tileerror handling.
 */
export function forecastTimes(newestS, stepMin = FORECAST_STEP_MIN, horizonMin = FORECAST_HORIZON_MIN) {
  const step = stepMin * 60;
  const first = Math.floor(newestS / step) * step + step;
  const n = Math.floor(horizonMin / stepMin);
  return Array.from({ length: n }, (_, i) => first + i * step);
}

/**
 * Label one frame relative to now, for the timeline readout.
 * Frames within a couple of minutes of now read as "now" rather than "2 min ago",
 * since radar always lags reality slightly and false precision is misleading.
 */
export function frameLabel(frame, nowMs) {
  const deltaMin = Math.round((frame.time * 1000 - nowMs) / 60000);
  if (Math.abs(deltaMin) <= 2) return 'now';
  return deltaMin < 0 ? `${-deltaMin} min ago` : `+${deltaMin} min`;
}

/**
 * Great-circle distance in km. Used to decide whether panning the map has moved
 * far enough to be worth re-fetching the local forecast.
 */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Step forward through the frame list, wrapping at the end. */
export function nextIndex(current, length) {
  if (length <= 0) return 0;
  return (current + 1) % length;
}
