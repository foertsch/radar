import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CH_FRAMES,
  frameWindow,
  inBounds,
  newestRzcTimes,
  renderRgba,
  rzcAssetUrl,
  rzcProbeCandidates,
  rzcTimeFromName,
  stacItemUrl,
} from '../src/swiss.js';

const T_0850 = Date.UTC(2026, 7, 17, 8, 50) / 1000; // a real frame from the archive

/* ---------------------------------------------------------- names & URLs --- */

test('rzcAssetUrl reproduces a real archive URL', () => {
  // Verified to exist during the MVP: day item 20260817-ch, DOY 229.
  assert.equal(
    rzcAssetUrl(T_0850),
    'https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip/20260817-ch/rzc262290850vl.001.h5',
  );
});

test('rzcTimeFromName inverts rzcAssetUrl across edge dates', () => {
  for (const t of [
    T_0850,
    Date.UTC(2025, 0, 1, 0, 0) / 1000, // DOY 001
    Date.UTC(2028, 11, 31, 23, 55) / 1000, // DOY 366, leap year
    Date.UTC(2027, 2, 1, 12, 5) / 1000, // after Feb in a non-leap year
  ]) {
    const name = rzcAssetUrl(t).split('/').pop();
    assert.equal(rzcTimeFromName(name), t, name);
  }
});

test('rzcTimeFromName rejects non-RZC assets', () => {
  assert.equal(rzcTimeFromName('cpc2622908459_00060.001.h5'), null);
  assert.equal(rzcTimeFromName('tzc262290850vl.801.h5'), null);
});

test('stacItemUrl uses the UTC day', () => {
  assert.match(stacItemUrl(T_0850), /\/items\/20260817-ch$/);
  // 23:55 UTC on Dec 31 must not roll into the next day/year.
  assert.match(stacItemUrl(Date.UTC(2028, 11, 31, 23, 55) / 1000), /20281231-ch$/);
});

test('rzcProbeCandidates floors to the 5-min grid and walks back newest-first', () => {
  const now = Date.UTC(2026, 7, 17, 12, 43, 40) / 1000; // 12:43:40Z
  const c = rzcProbeCandidates(now, 3);
  assert.deepEqual(
    c.map((t) => new Date(t * 1000).toISOString().slice(11, 16)),
    ['12:40', '12:35', '12:30', '12:25'],
  );
  // A timestamp already on the grid is its own first candidate.
  assert.equal(rzcProbeCandidates(T_0850, 0)[0], T_0850);
});

test('frameWindow ends at the newest frame with 5-min spacing', () => {
  const w = frameWindow(T_0850, 12);
  assert.equal(w.length, 12);
  assert.equal(w.at(-1), T_0850);
  assert.equal(w[0], T_0850 - 11 * 300);
  assert.ok(w.every((t, i) => i === 0 || t - w[i - 1] === 300));
  // Window times must round-trip through the URL scheme.
  assert.equal(rzcTimeFromName(rzcAssetUrl(w[0]).split('/').pop()), w[0]);
});

/* -------------------------------------------------------------- frame list --- */

test('newestRzcTimes merges day items, ignores other products, sorts ascending', () => {
  const day1 = {
    assets: {
      'rzc262290850vl.001.h5': {},
      'rzc262290855vl.001.h5': {},
      'cpc2622908459_00060.001.h5': {},
    },
  };
  const day0 = { assets: { 'rzc262280000vl.001.h5': {}, 'tzc262280000vl.801.h5': {} } };
  const times = newestRzcTimes([day1, day0], 3);
  assert.equal(times.length, 3);
  assert.deepEqual(
    times.map((t) => new Date(t * 1000).toISOString().slice(0, 16)),
    ['2026-08-16T00:00', '2026-08-17T08:50', '2026-08-17T08:55'],
  );
  assert.equal(newestRzcTimes([day1, day0], 2).length, 2);
  assert.deepEqual(newestRzcTimes([{}, { assets: {} }], 5), []);
  assert.ok(CH_FRAMES > 0);
});

/* ----------------------------------------------------------------- render --- */

const META = {
  width: 3,
  height: 2,
  sentinel: 0xffffffff,
  legend: {
    bounds: [1, 2, 4, 6, 10, 20, 40, 60],
    colors: [
      '9A7E95', '0001FC', '058C2D', '05FF05', 'FEFF01', 'FFC703', 'FF7D01', 'FF1900', 'AF00DD',
    ],
    alphas: [150, 200, 225, 255, 255, 255, 255, 255, 255],
  },
};

const px = (arr, i) => [...arr.slice(i * 4, i * 4 + 4)];

test('renderRgba mirrors the Python colorize semantics', () => {
  const vals = new Float64Array([0.5, 0, NaN, 1.0, 59.9, 100]);
  const lut = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const rgba = renderRgba(vals, lut, META);

  assert.deepEqual(px(rgba, 0), [0x9a, 0x7e, 0x95, 150]); // 0-1 band: translucent drizzle
  assert.deepEqual(px(rgba, 1), [0x9a, 0x7e, 0x95, 0]);   // undetect: colour written, alpha 0
  assert.deepEqual(px(rgba, 2), [0x9a, 0x7e, 0x95, 0]);   // NaN: same
  assert.deepEqual(px(rgba, 3), [0x00, 0x01, 0xfc, 200]); // band minimum is inclusive
  assert.deepEqual(px(rgba, 4), [0xff, 0x19, 0x00, 255]); // 40-60: heavy rain opaque
  assert.deepEqual(px(rgba, 5), [0xaf, 0x00, 0xdd, 255]); // open-ended top band
});

test('renderRgba defaults to opaque when the legend has no alpha table', () => {
  const meta = { ...META, legend: { bounds: META.legend.bounds, colors: META.legend.colors } };
  const rgba = renderRgba(new Float64Array([0.5]), new Uint32Array(Array(6).fill(0)), meta);
  assert.equal(px(rgba, 0)[3], 255);
});

test('renderRgba treats sentinel pixels as outside the domain', () => {
  const vals = new Float64Array([50]);
  const lut = new Uint32Array([0, META.sentinel, 0, META.sentinel, 0, META.sentinel]);
  const rgba = renderRgba(vals, lut, META);
  assert.deepEqual(px(rgba, 0), [0xff, 0x19, 0x00, 255]); // 50 mm/h -> 40-60 band
  assert.equal(px(rgba, 1)[3], 0);
  assert.equal(px(rgba, 3)[3], 0);
});

test('renderRgba validates lut length', () => {
  assert.throws(() => renderRgba(new Float64Array(1), new Uint32Array(2), META), /lut length/);
});

/* ----------------------------------------------------------------- bounds --- */

test('inBounds matches the composite footprint corners', () => {
  const bounds = [[43.619, 2.689], [49.468, 12.462]]; // shipped lut.json values
  assert.ok(inBounds(bounds, 47.37, 8.54)); // Zürich
  assert.ok(inBounds(bounds, 46.95, 7.44)); // Bern
  assert.ok(!inBounds(bounds, 53.55, 9.99)); // Hamburg
  assert.ok(!inBounds(bounds, 41.9, 12.5)); // Rome
});
