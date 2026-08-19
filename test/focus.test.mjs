import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CH_BORDER } from '../src/ch-border.js';
import { FOCUS_BBOX, FOREIGN_LABELS, WORLD_RING, focusActive, labelVisible } from '../src/focus.js';

/* ---------------------------------------------------------------- border --- */

test('border ring is plausible for Switzerland', () => {
  assert.ok(CH_BORDER.length > 100, `only ${CH_BORDER.length} points`);
  const lats = CH_BORDER.map((p) => p[0]);
  const lngs = CH_BORDER.map((p) => p[1]);
  // National extremes: ~45.82..47.81 N, ~5.96..10.49 E (±coastal-free tolerance)
  assert.ok(Math.min(...lats) > 45.6 && Math.min(...lats) < 46.0);
  assert.ok(Math.max(...lats) > 47.6 && Math.max(...lats) < 48.0);
  assert.ok(Math.min(...lngs) > 5.8 && Math.min(...lngs) < 6.1);
  assert.ok(Math.max(...lngs) > 10.3 && Math.max(...lngs) < 10.7);
  // Unclosed ring (Leaflet closes it), no duplicated endpoint.
  assert.notDeepEqual(CH_BORDER[0], CH_BORDER.at(-1));
});

test('border contains Bern and excludes Milan (ray cast)', () => {
  const inside = (lat, lng) => {
    let hit = false;
    for (let i = 0, j = CH_BORDER.length - 1; i < CH_BORDER.length; j = i++) {
      const [yi, xi] = CH_BORDER[i];
      const [yj, xj] = CH_BORDER[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  assert.ok(inside(46.948, 7.447)); // Bern
  assert.ok(inside(47.377, 8.542)); // Zürich
  assert.ok(inside(46.005, 8.953)); // Lugano
  assert.ok(!inside(45.464, 9.19)); // Milan
  assert.ok(!inside(47.999, 7.842)); // Freiburg i. Br.
});

/* ---------------------------------------------------------------- labels --- */

test('foreign labels sit outside Switzerland and inside the focus bbox', () => {
  const [[s, w], [n, e]] = FOCUS_BBOX;
  for (const l of FOREIGN_LABELS) {
    assert.ok(l.lat >= s && l.lat <= n && l.lng >= w && l.lng <= e, l.name);
    assert.ok(['country', 'city'].includes(l.kind), l.name);
    assert.ok(l.minZoom < l.maxZoom, l.name);
  }
});

test('labelVisible gates by zoom range inclusively', () => {
  const country = FOREIGN_LABELS.find((l) => l.kind === 'country');
  assert.ok(labelVisible(country, country.minZoom));
  assert.ok(labelVisible(country, country.maxZoom));
  assert.ok(!labelVisible(country, country.maxZoom + 1));
  assert.ok(!labelVisible(country, country.minZoom - 1));
});

/* ------------------------------------------------------------------ gate --- */

test('focusActive covers Switzerland and nearby, not far Europe', () => {
  assert.ok(focusActive(47.38, 8.54)); // Zürich
  assert.ok(focusActive(45.46, 9.19)); // Milan — near enough to stay focused
  assert.ok(!focusActive(53.55, 9.99)); // Hamburg
  assert.ok(!focusActive(48.85, 2.35)); // Paris
});

test('world ring is a valid outer boundary', () => {
  assert.equal(WORLD_RING.length, 4);
  assert.ok(WORLD_RING.every(([lat, lng]) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180));
});
