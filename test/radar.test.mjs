import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RADAR_OPTIONS,
  RADAR_MAX_NATIVE_ZOOM,
  buildDwdRemap,
  buildRadarTileUrl,
  cloudSlotFor,
  dwdImageUrl,
  forecastTimes,
  mmPerHourFromDbz,
  remapDwdImage,
  frameLabel,
  haversineKm,
  latestSatelliteSlot,
  nextIndex,
  parseWeatherMaps,
  satelliteSlot,
  summarizeNowcast,
} from '../src/radar.js';

/** Fixed clock so nothing here depends on when the suite runs. */
const NOW_S = 1_787_000_000;
const NOW_MS = NOW_S * 1000;

/** Build a 15-minute series whose first slot started `startedAgoS` ago. */
function series(startedAgoS, mm) {
  const t0 = NOW_S - startedAgoS;
  return {
    time: mm.map((_, i) => t0 + i * 900),
    precipitation: mm,
  };
}

/* -------------------------------------------------- parseWeatherMaps ------ */

test('parseWeatherMaps merges past and nowcast into one ascending list', () => {
  const { host, frames } = parseWeatherMaps({
    host: 'https://tilecache.rainviewer.com',
    generated: 123,
    radar: {
      past: [
        { time: 200, path: '/b' },
        { time: 100, path: '/a' },
      ],
      nowcast: [{ time: 300, path: '/c' }],
    },
  });

  assert.equal(host, 'https://tilecache.rainviewer.com');
  assert.deepEqual(
    frames.map((f) => [f.time, f.path, f.kind]),
    [
      [100, '/a', 'past'],
      [200, '/b', 'past'],
      [300, '/c', 'nowcast'],
    ],
  );
});

test('parseWeatherMaps tolerates the free tier returning empty nowcast/satellite', () => {
  const { frames } = parseWeatherMaps({
    host: 'https://h',
    radar: { past: [{ time: 1, path: '/a' }], nowcast: [] },
    satellite: { infrared: [] },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'past');
});

test('parseWeatherMaps drops malformed frames and requires a host', () => {
  const { frames } = parseWeatherMaps({
    host: 'https://h',
    radar: { past: [{ time: 1, path: '/a' }, { time: 'x', path: '/b' }, null, { path: '/c' }] },
  });
  assert.deepEqual(frames.map((f) => f.path), ['/a']);

  assert.throws(() => parseWeatherMaps({ radar: {} }), /tile host/);
  assert.throws(() => parseWeatherMaps(null), /tile host/);
});

/* -------------------------------------------------- buildRadarTileUrl ----- */

test('buildRadarTileUrl leaves Leaflet placeholders intact', () => {
  const url = buildRadarTileUrl('https://tilecache.rainviewer.com', { path: '/v2/radar/abc' });
  assert.equal(url, 'https://tilecache.rainviewer.com/v2/radar/abc/512/{z}/{x}/{y}/2/1_1.png');
  assert.equal(RADAR_OPTIONS.size, 512);
});

test('radar defaults stay inside the personal-use tier', () => {
  // Personal use allows Universal Blue (2) only, 512px tiles, max zoom 7.
  // Drifting off these silently returns placeholder tiles instead of an error.
  assert.equal(RADAR_OPTIONS.color, 2);
  assert.equal(RADAR_MAX_NATIVE_ZOOM, 7);
});

test('buildRadarTileUrl honours overrides', () => {
  const url = buildRadarTileUrl('https://h', { path: '/p' }, { size: 256, color: 2, snow: 0 });
  assert.equal(url, 'https://h/p/256/{z}/{x}/{y}/2/1_0.png');
});

/* -------------------------------------------------- latestSatelliteSlot --- */

test('latestSatelliteSlot floors to the 15-minute grid EUMETSAT publishes on', () => {
  const t = Date.UTC(2026, 7, 17, 8, 22, 33, 456);
  assert.equal(latestSatelliteSlot(t), '2026-08-17T08:15:00Z');
});

test('latestSatelliteSlot is stable within a slot and steps at the boundary', () => {
  const a = latestSatelliteSlot(Date.UTC(2026, 7, 17, 8, 15, 0));
  const b = latestSatelliteSlot(Date.UTC(2026, 7, 17, 8, 29, 59));
  const c = latestSatelliteSlot(Date.UTC(2026, 7, 17, 8, 30, 0));
  assert.equal(a, b); // same URL all slot long, so the tile cache actually works
  assert.equal(c, '2026-08-17T08:30:00Z');
});

test('satelliteSlot never asks for a slot newer than the publication lag', () => {
  // Real case: at 08:48Z the newest published frame was 08:15Z. Asking for
  // 08:45Z returned HTTP 502 — the server does not clamp forward.
  const now = Date.UTC(2026, 7, 17, 8, 48, 28);
  assert.equal(satelliteSlot(now), '2026-08-17T08:00:00Z');
  assert.ok(satelliteSlot(now) < '2026-08-17T08:15:00Z');
});

test('satelliteSlot walks backwards one 15-minute step at a time', () => {
  const now = Date.UTC(2026, 7, 17, 8, 48, 28);
  assert.equal(satelliteSlot(now, 1), '2026-08-17T07:45:00Z');
  assert.equal(satelliteSlot(now, 2), '2026-08-17T07:30:00Z');
  assert.equal(satelliteSlot(now, 4), '2026-08-17T07:00:00Z');
});

test('cloudSlotFor gives historical frames their own slot', () => {
  const now = Date.UTC(2026, 7, 17, 8, 48, 28);
  // A frame from 90 min ago is well behind the publication lag: true slot.
  assert.equal(cloudSlotFor(Date.UTC(2026, 7, 17, 7, 20) / 1000, now), '2026-08-17T07:15:00Z');
  assert.equal(cloudSlotFor(Date.UTC(2026, 7, 17, 7, 0) / 1000, now), '2026-08-17T07:00:00Z');
});

test('cloudSlotFor clamps recent frames to the newest published slot', () => {
  const now = Date.UTC(2026, 7, 17, 8, 48, 28);
  const newest = satelliteSlot(now); // 08:00Z with the 45-min lag
  // Frames newer than the lag horizon must not request unpublished slots (502).
  assert.equal(cloudSlotFor(Date.UTC(2026, 7, 17, 8, 45) / 1000, now), newest);
  assert.equal(cloudSlotFor(now / 1000, now), newest);
  // Walk-back state lowers the clamp for recent frames too.
  assert.equal(cloudSlotFor(Date.UTC(2026, 7, 17, 8, 45) / 1000, now, 2), satelliteSlot(now, 2));
});

test('forecastTimes gives 8 grid-aligned steps after the newest frame', () => {
  const newest = Date.UTC(2026, 7, 19, 8, 45) / 1000; // already on the 15-min grid
  const times = forecastTimes(newest);
  assert.equal(times.length, 8);
  assert.equal(times[0], newest + 15 * 60);
  assert.equal(times.at(-1), newest + 120 * 60);
  assert.ok(times.every((t, i) => i === 0 || t - times[i - 1] === 900));
  assert.ok(times.every((t) => t % 900 === 0)); // absolute 15-min grid
});

test('forecastTimes is stable across a 5-min advance of the anchor', () => {
  // 08:45 and 08:50 floor to the same grid slot -> identical layer times,
  // so a refresh reuses the already-loaded WMS layers instead of re-requesting.
  const a = forecastTimes(Date.UTC(2026, 7, 19, 8, 45) / 1000);
  const b = forecastTimes(Date.UTC(2026, 7, 19, 8, 50) / 1000);
  assert.deepEqual(a, b);
  // Crossing the grid boundary shifts by exactly one step.
  const c = forecastTimes(Date.UTC(2026, 7, 19, 9, 0) / 1000);
  assert.equal(c[0], a[0] + 900);
  // The first step always lies strictly in the future of the anchor.
  for (const t of [a, c]) assert.ok(t[0] > Date.UTC(2026, 7, 19, 9, 0) / 1000 - 900);
});

test('mmPerHourFromDbz follows Marshall-Palmer', () => {
  // Z = 200 R^1.6: R=1 -> 10*log10(200) = 23.01 dBZ
  assert.ok(Math.abs(mmPerHourFromDbz(23.01) - 1.0) < 0.01);
  assert.ok(Math.abs(mmPerHourFromDbz(39.0) - 10.0) < 0.2);
  assert.ok(mmPerHourFromDbz(7) < 0.12); // detection floor ~0.1 mm/h
});

const LEGEND = {
  bounds: [1, 2, 4, 6, 10, 20, 40, 60],
  colors: ['9A7E95', '0001FC', '058C2D', '05FF05', 'FEFF01', 'FFC703', 'FF7D01', 'FF1900', 'AF00DD'],
  alphas: [150, 200, 225, 255, 255, 255, 255, 255, 255],
};

test('buildDwdRemap translates DWD style colours to MeteoSwiss bands', () => {
  const remap = buildDwdRemap(LEGEND);
  assert.equal(remap.size, 17); // one entry per DWD style interval
  // [7,9.5) dBZ ~ 0.12 mm/h -> drizzle band, translucent
  assert.deepEqual(remap.get('153,255,255'), [0x9a, 0x7e, 0x95, 150]);
  // [23.5,28) dBZ ~ 1.5 mm/h -> 1-2 band
  assert.deepEqual(remap.get('153,204,0'), [0x00, 0x01, 0xfc, 200]);
  // [32.5,37) dBZ ~ 5.4 mm/h -> 4-6 band, opaque
  assert.deepEqual(remap.get('255,255,0'), [0x05, 0xff, 0x05, 255]);
  // Extreme cores (hail-coded blues/purples) land in the open-ended top band
  assert.deepEqual(remap.get('72,72,255'), [0xaf, 0x00, 0xdd, 255]);
  // The no-data grey is NOT in the style table -> not in the remap
  assert.equal(remap.get('125,125,125'), undefined);
});

test('remapDwdImage repaints known colours and clears everything else', () => {
  const remap = buildDwdRemap(LEGEND);
  const data = new Uint8ClampedArray([
    153, 255, 255, 255, // DWD lightest -> MeteoSwiss drizzle
    125, 125, 125, 128, // no-data grey at half opacity -> transparent
    255, 0, 255, 255,   // magenta domain border -> transparent
    0, 0, 0, 0,         // already transparent -> untouched
  ]);
  remapDwdImage(data, remap);
  assert.deepEqual([...data.slice(0, 4)], [0x9a, 0x7e, 0x95, 150]);
  assert.equal(data[7], 0);
  assert.equal(data[11], 0);
  assert.deepEqual([...data.slice(12)], [0, 0, 0, 0]);
});

test('dwdImageUrl builds a single-image GetMap with all required params', () => {
  const url = dwdImageUrl('2026-08-21T09:15:00Z', [626172, 5948635, 1252344, 6574807], 1400, 900);
  assert.match(url, /^https:\/\/maps\.dwd\.de\/geoserver\/dwd\/wms\?/);
  assert.match(url, /LAYERS=dwd:Radar_wn-product_1x1km_ger/);
  assert.match(url, /CRS=EPSG:3857/);
  assert.match(url, /BBOX=626172,5948635,1252344,6574807/);
  assert.match(url, /WIDTH=1400&HEIGHT=900/);
  assert.match(url, /TIME=2026-08-21T09:15:00Z/);
  assert.match(url, /TRANSPARENT=TRUE/);
});

/* -------------------------------------------------- summarizeNowcast ------ */

test('summarizeNowcast reports dry with rain approaching', () => {
  const s = summarizeNowcast(series(300, [0, 0, 0.4, 0.6]), NOW_MS);
  assert.equal(s.state, 'dry');
  assert.equal(s.minutes, 25);
  assert.match(s.text, /rain likely in ~25 min/);
});

test('summarizeNowcast reports rain now with an end in sight', () => {
  const s = summarizeNowcast(series(300, [0.6, 0.6, 0, 0]), NOW_MS);
  assert.equal(s.state, 'wet');
  assert.equal(s.minutes, 25);
  assert.match(s.text, /Raining — easing in ~25 min/);
});

test('summarizeNowcast avoids false precision when change is imminent', () => {
  const s = summarizeNowcast(series(780, [0, 0.5, 0.5]), NOW_MS);
  assert.equal(s.minutes, 2);
  assert.match(s.text, /within minutes/);
});

test('summarizeNowcast falls back to the horizon when nothing changes', () => {
  const dry = summarizeNowcast(series(300, Array(8).fill(0)), NOW_MS);
  assert.equal(dry.state, 'dry');
  assert.equal(dry.changeAt, null);
  assert.match(dry.text, /no rain in the next \d+ h/);

  const wet = summarizeNowcast(series(300, Array(8).fill(1.2)), NOW_MS);
  assert.equal(wet.state, 'wet');
  assert.match(wet.text, /no let-up in the next \d+ h/);
});

test('summarizeNowcast treats sub-threshold drizzle as dry', () => {
  const below = summarizeNowcast(series(300, [0.05, 0.05, 0.05]), NOW_MS);
  assert.equal(below.state, 'dry');

  const atThreshold = summarizeNowcast(series(300, [0.1, 0.1, 0.1]), NOW_MS);
  assert.equal(atThreshold.state, 'wet');
});

test('summarizeNowcast starts from the current slot, not the first one', () => {
  // First two slots are already over; the live slot is index 2 and it is wet.
  const s = summarizeNowcast(series(2100, [0, 0, 0.8, 0.8, 0]), NOW_MS);
  assert.equal(s.state, 'wet');
});

test('summarizeNowcast degrades gracefully on missing or stale data', () => {
  assert.equal(summarizeNowcast(undefined, NOW_MS).state, 'unknown');
  assert.equal(summarizeNowcast({ time: [], precipitation: [] }, NOW_MS).state, 'unknown');

  const stale = summarizeNowcast(series(86400, [0, 0, 0]), NOW_MS);
  assert.equal(stale.state, 'unknown');
  assert.match(stale.text, /out of date/);
});

/* -------------------------------------------------- frameLabel ------------ */

test('frameLabel rounds near-current frames to "now"', () => {
  assert.equal(frameLabel({ time: NOW_S }, NOW_MS), 'now');
  assert.equal(frameLabel({ time: NOW_S - 60 }, NOW_MS), 'now');
  assert.equal(frameLabel({ time: NOW_S - 3600 }, NOW_MS), '60 min ago');
  assert.equal(frameLabel({ time: NOW_S + 600 }, NOW_MS), '+10 min');
});

/* -------------------------------------------------- helpers --------------- */

test('haversineKm matches a known distance', () => {
  const km = haversineKm({ lat: 47.3769, lon: 8.5417 }, { lat: 46.948, lon: 7.4474 }); // Zürich–Bern
  assert.ok(km > 90 && km < 100, `expected ~95 km, got ${km}`);
  assert.equal(haversineKm({ lat: 47, lon: 8 }, { lat: 47, lon: 8 }), 0);
});

test('nextIndex wraps and survives an empty frame list', () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(2, 3), 0);
  assert.equal(nextIndex(0, 0), 0);
});
