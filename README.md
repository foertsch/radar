# radar

An ad-free weather radar page. Static files only — no build step, no tracking,
no server of its own.

- Animated timeline: 30 min of observed radar plus **2 h of forecast**
  (DWD's nowcast composite, 15-min steps), dwelling on "now" each cycle;
  forecast timestamps show in accent italics
- **Swiss radar**: official MeteoSwiss 1 km / 5-minute data, decoded and
  rendered *in the browser* — auto-enabled when the view is inside the Swiss
  composite, toggleable, with automatic fallback to RainViewer
- Centres on your location with a pin (falls back to Zürich if you decline);
  `?at=lat,lon` pins any spot instead
- Optional infrared cloud overlay that moves with the timelapse
- Place-name labels render above the weather layers, so the map stays readable
- A one-line "will it rain on me" forecast for wherever the map is pointed

## Running it

```bash
npm start
```

Then open <http://localhost:8000>. It must be served over `http://localhost` or
HTTPS — geolocation is refused on `file://`, so double-clicking `index.html`
gets you the Zürich fallback and nothing else.

```bash
npm test
```

Tests cover the pure logic in `src/radar.js` under `node --test`; no browser or
test framework needed.

## Deploying

Push to a GitHub repo and enable Pages on the default branch, root folder.
Everything is relative-path, so it also works from a subdirectory.

## Sources

All four are free, keyless, and used within their published terms.

| What | Source | Notes |
| --- | --- | --- |
| Swiss radar (toggle) | [MeteoSwiss open data](https://opendatadocs.meteoswiss.ch/) | 5 Swiss radars, 1 km, 5-min, CC-BY, ~5–11 min behind real time |
| Forecast radar (+2 h) | [DWD GeoServer](https://www.dwd.de/DE/leistungen/radarprodukte/radarprodukte.html) | WN composite (analysis+nowcast) via open WMS; German network — sees CH from outside, Valais/Ticino at its range edge. MeteoSwiss's own nowcast (INCA) is on-request only, not open data |
| Radar tiles | [RainViewer](https://www.rainviewer.com/api.html) | ~1200 radars, 150+ countries — the default outside Switzerland |
| Cloud imagery | [EUMETSAT View](https://view.eumetsat.int/) | Meteosat SEVIRI IR 10.8 µm, 15-min cadence |
| Rain forecast | [Open-Meteo](https://open-meteo.com/) | 15-min precipitation, any coordinates |
| Basemap | [CARTO](https://carto.com/attributions) / OpenStreetMap | Light and dark variants |

### How the Swiss layer works (no server)

MeteoSwiss publishes radar as **ODIM HDF5 files via a STAC API** — raw science
data, not map tiles. Instead of running a render server, the page does it
client-side, which works because `data.geo.admin.ch` sends
`access-control-allow-origin: *`:

1. The browser lists the newest frames via STAC and fetches each ~184 KB HDF5.
2. [h5wasm](swiss/h5wasm/) (vendored, NIST) decodes the 640×710 mm/h grid.
3. Reprojection LV95→EPSG:3857 is a flat array lookup: the mapping never
   changes, so it was computed once by the verified Python pipeline
   ([`meteoswiss/make_lut.py`](meteoswiss/make_lut.py)) and ships as
   [`swiss/lut.bin.gz`](swiss/) (0.86 MB).
4. The result is drawn to a canvas and displayed as one `L.imageOverlay` —
   a single ~500 m/px image needs no tile pyramid, since the data is 1 km.

The browser output is **bit-identical to the Python reference** (0 of 1.76 M
pixels differ, 12/12 frames) and the pipeline itself was verified against the
live rain-gauge network and RainViewer — numbers in
[`meteoswiss/VERDICT.md`](meteoswiss/VERDICT.md). Colours and class bounds are
MeteoSwiss's official legend.

If anything fails (CORS withdrawn, STAC down, old browser), the page says so
and falls back to RainViewer. To regenerate the LUT after a grid change:
`cd meteoswiss && ./.venv/bin/python render.py && ./.venv/bin/python make_lut.py && cp out/lut.* ../swiss/`.

DWD's GeoServer (`maps.dwd.de`) is the other official free option and does offer
real forecast frames, but its composite excludes Swiss radars and covers only
central Europe.

## Limitations worth knowing

These come from the free tiers, not from the code:

- **RainViewer radar stops at zoom 7.** The personal-use tier caps there. Past
  it the map upscales rather than requesting tiles the server would answer with
  a "Zoom Level Not Supported" placeholder. The Swiss layer has no such cap —
  zooming shows the data's native 1 km blocks at any level.
- **No forecast radar frames.** Nowcast tiles are a paid feature, which is why
  the forecast is a text line from Open-Meteo instead of blobs on the map.
- **Universal Blue only.** The personal-use tier permits that one colour scheme.
- **Clouds are Europe/Africa only.** Meteosat sees one hemisphere from 0°
  longitude, so the overlay is empty over the Americas and the Pacific.
- **Clouds run ~30-45 min behind.** EUMETSAT publishes with a lag, and asking for
  a slot newer than the newest published one returns HTTP 502 rather than the
  nearest match, so the page deliberately requests a slightly older frame and
  steps further back if that still fails.
- **The loop is bandwidth-hungry.** Thirteen frames times a screenful of tiles is
  a few hundred images on first load. They are cached for two days, so it is a
  once-per-session cost.
- **The Swiss layer costs ~2 MB once** (decoder + lookup table, then cached
  indefinitely) plus ~184 KB per frame (cached 2 h). It only activates inside
  its footprint, so visitors elsewhere never download it.

## Layout

```
index.html        markup and CDN pins (Leaflet 1.9.4, SRI-checked)
styles.css        light/dark tokens, panel, mobile safe-area handling
src/radar.js      pure logic: frame parsing, URL building, forecast wording
src/swiss.js      pure logic: MeteoSwiss STAC/asset URLs, LUT rendering
src/app.js        Leaflet wiring, animation, controls, source switching
swiss/            shipped assets: reprojection LUT + vendored h5wasm decoder
test/             node --test suites for radar.js and swiss.js
meteoswiss/       Python reference pipeline + verification harness (see VERDICT.md)
```

The split exists so the logic that is easy to get wrong — which frame is
current, which satellite timestamp is safe to request, when "rain in ~25 min"
becomes "within minutes" — is testable without a browser.
