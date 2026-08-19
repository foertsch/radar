/**
 * Switzerland-focus logic: which minimal labels to show outside the border,
 * when they're visible, and when the focus treatment applies at all.
 *
 * Pure module — the veil polygon, clip-path and marker wiring live in app.js.
 */

/**
 * Curated replacement for CARTO's foreign labels: country names plus big
 * cities near Switzerland. Zoom ranges roughly mimic the basemap's own
 * behaviour (countries fade out when zoomed in, cities appear from z5/6).
 */
export const FOREIGN_LABELS = [
  { name: 'FRANCE', kind: 'country', lat: 46.3, lng: 5.15, minZoom: 4, maxZoom: 8 },
  { name: 'GERMANY', kind: 'country', lat: 48.35, lng: 9.5, minZoom: 4, maxZoom: 8 },
  { name: 'ITALY', kind: 'country', lat: 45.25, lng: 8.9, minZoom: 4, maxZoom: 8 },
  { name: 'AUSTRIA', kind: 'country', lat: 47.35, lng: 11.8, minZoom: 4, maxZoom: 8 },
  { name: 'Lyon', kind: 'city', lat: 45.764, lng: 4.836, minZoom: 5, maxZoom: 11 },
  { name: 'Grenoble', kind: 'city', lat: 45.188, lng: 5.724, minZoom: 6, maxZoom: 11 },
  { name: 'Besançon', kind: 'city', lat: 47.238, lng: 6.024, minZoom: 6, maxZoom: 11 },
  { name: 'Strasbourg', kind: 'city', lat: 48.573, lng: 7.752, minZoom: 5, maxZoom: 11 },
  { name: 'Freiburg i. Br.', kind: 'city', lat: 47.999, lng: 7.842, minZoom: 6, maxZoom: 11 },
  { name: 'Stuttgart', kind: 'city', lat: 48.776, lng: 9.183, minZoom: 5, maxZoom: 11 },
  { name: 'Munich', kind: 'city', lat: 48.135, lng: 11.582, minZoom: 5, maxZoom: 11 },
  { name: 'Innsbruck', kind: 'city', lat: 47.269, lng: 11.404, minZoom: 6, maxZoom: 11 },
  { name: 'Milan', kind: 'city', lat: 45.464, lng: 9.19, minZoom: 5, maxZoom: 11 },
  { name: 'Turin', kind: 'city', lat: 45.07, lng: 7.687, minZoom: 5, maxZoom: 11 },
];

export function labelVisible(label, zoom) {
  return zoom >= label.minZoom && zoom <= label.maxZoom;
}

/**
 * The focus treatment (veil + clipped labels) only applies while the view is
 * about Switzerland. Pan off to Hamburg and the map returns to full detail —
 * a dimmed, label-less Germany would be useless there. Margin of ~1.5° beyond
 * the border bbox keeps the treatment stable while nosing across the border.
 */
export const FOCUS_BBOX = [
  [44.3, 4.4],
  [49.3, 12.0],
];

export function focusActive(lat, lng) {
  const [[south, west], [north, east]] = FOCUS_BBOX;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

/**
 * Ring covering the whole Mercator world, for the veil's outer boundary —
 * the veil polygon is this ring with Switzerland as a hole.
 */
export const WORLD_RING = [
  [85, -180],
  [85, 180],
  [-85, 180],
  [-85, -180],
];
