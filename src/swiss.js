/**
 * Swiss radar layer (MeteoSwiss open data) — pure logic.
 *
 * Everything here runs under `node --test`; the browser wiring (h5wasm,
 * canvas, Leaflet) lives in app.js. The expensive reprojection was computed
 * once, offline, by the verified Python pipeline (meteoswiss/make_lut.py) and
 * ships as swiss/lut.bin.gz — at runtime a frame render is a flat lookup.
 * The browser output was verified bit-identical to the Python reference
 * (meteoswiss/VERDICT.md).
 */

export const OGD_BASE = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip';
export const STAC_ITEMS =
  'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-radar-precip/items';

/** One hour of 5-minute frames — matches the RainViewer loop's feel. */
export const CH_FRAMES = 12;

// rzc + YY + DDD (day of year) + HHMM, e.g. rzc262290850vl.001.h5
const RZC_NAME = /^rzc(\d{2})(\d{3})(\d{2})(\d{2})/;

/** Unix seconds encoded in an RZC filename, or null for other assets. */
export function rzcTimeFromName(name) {
  const m = RZC_NAME.exec(name);
  if (!m) return null;
  return (
    Date.UTC(2000 + +m[1], 0, 1) / 1000 + ((+m[2] - 1) * 24 + +m[3]) * 3600 + +m[4] * 60
  );
}

/** "YYYYMMDD" of a unix timestamp, UTC — the STAC item id prefix. */
export function stacDay(t) {
  return new Date(t * 1000).toISOString().slice(0, 10).replaceAll('-', '');
}

/** STAC item URL for the UTC day containing t. */
export function stacItemUrl(t) {
  return `${STAC_ITEMS}/${stacDay(t)}-ch`;
}

/** Direct download URL of the RZC frame at unix time t (5-minute grid, UTC). */
export function rzcAssetUrl(t) {
  const d = new Date(t * 1000);
  const doy = Math.floor((t * 1000 - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  const p = (x, l) => String(x).padStart(l, '0');
  const name =
    `rzc${p(d.getUTCFullYear() % 100, 2)}${p(doy, 3)}` +
    `${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}vl.001.h5`;
  return `${OGD_BASE}/${stacDay(t)}-ch/${name}`;
}

/**
 * Newest n RZC frame times across one or more STAC day items, ascending.
 * Non-RZC assets (cpc, tzc) are ignored.
 */
export function newestRzcTimes(items, n) {
  const times = [];
  for (const item of items) {
    for (const name of Object.keys(item?.assets ?? {})) {
      const t = rzcTimeFromName(name);
      if (t !== null) times.push(t);
    }
  }
  return [...new Set(times)].sort((a, b) => a - b).slice(-n);
}

/**
 * Rain-rate values -> RGBA bytes, mirroring swissradar.colorize exactly:
 * the band colour is always written (bit-exact comparability with the Python
 * reference), alpha is 255 only for finite values > 0. Band minima are
 * inclusive, the top band is open-ended.
 *
 * @param {Float64Array} vals source grid, row 0 = north
 * @param {Uint32Array} lut   target pixel -> flat source index (sentinel = outside)
 * @param {object} meta       swiss/lut.json content
 * @returns {Uint8ClampedArray} width*height*4 bytes
 */
export function renderRgba(vals, lut, meta) {
  const { width, height, sentinel } = meta;
  const bounds = meta.legend.bounds;
  const rgb = meta.legend.colors.map((c) =>
    [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)),
  );
  const n = width * height;
  if (lut.length !== n) throw new Error(`lut length ${lut.length} != ${n}`);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const src = lut[i];
    const v = src === sentinel ? NaN : vals[src];
    const safe = Number.isFinite(v) ? v : 0;
    let b = 0;
    while (b < bounds.length && safe >= bounds[b]) b++;
    const o = i * 4;
    out[o] = rgb[b][0];
    out[o + 1] = rgb[b][1];
    out[o + 2] = rgb[b][2];
    out[o + 3] = Number.isFinite(v) && v > 0 ? 255 : 0;
  }
  return out;
}

/** Is (lat, lng) inside imageOverlay bounds [[south, west], [north, east]]? */
export function inBounds(bounds, lat, lng) {
  const [[south, west], [north, east]] = bounds;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}
