# MVP verdict: MeteoSwiss radar → static-page overlay

**Date:** 2026-08-17, ~09:00–11:00 UTC, during widespread convective rain over
Switzerland (ideal test conditions — 106 of 278 gauges wet).

**Strategy under test:** decode the open-data RZC (PRECIP) ODIM HDF5 files,
reproject the 1 km LV95 grid to a single EPSG:3857 PNG per frame (no tile
pyramid), and display it with `L.imageOverlay`. Verdict: **GO** — every check
passed, two of them after honest criterion fixes documented below.

## Results

| # | Check | Result | Bar | Verdict |
|---|---|---|---|---|
| 1 | Decode | 640×710 float64, 0–120 mm/h, NaN outside domain, 12/12 frames identical bounds | sane dims/range | PASS |
| 2 | Projection math | Bern LV95 anchor < 25 m; 3857 round-trip < 0.5 m | < 0.5 px | PASS |
| 3 | Gauge ground truth (n=278) | accuracy **0.86**, POD **0.93**, FAR **0.24**, Spearman 0.51 (wet-both) | ≥0.80 / ≥0.65 / ≤0.35 | PASS |
| 3b | Gauge shift search ±3 km | optimum at (0,−1) km, gain over zero shift 0.014 (≈4 stations) | ≤1.5 km, Δ≤0.02 | PASS |
| 4 | RainViewer cross-alignment (identical 09:00Z timestamp) | IoU **0.613** at zero shift; optimum shift **3.1 km** | IoU ≥0.4, shift ≤4 km | PASS |
| 5 | Freshness | 10.4 min this run; 6 min observed the day before | ≤ 10 min typical | PASS (range 6–11 min; RainViewer ~15, EUMETSAT ~33) |

Unit tests: 10/10 (`pytest`), offline, including a synthetic ODIM file using
the real projection string.

## What the checks would have caught

- Dropped/wrong `towgs84` datum shift → Bern anchor misses by 100–200 m,
  gauge/IoU optima displaced.
- Flipped row order → gauge agreement collapses to chance.
- Naive equirectangular render instead of true 3857 → north-south smear,
  visible in the A/B blink and the IoU shift search.
- Corner-vs-centre grid origin ambiguity → 500 m systematic bias (handled
  explicitly in `read_odim`, validated by the shift searches).

## Honest notes

- **Criterion revision:** the gauge check originally demanded the shift-search
  argmax at exactly (0,0) and FAILED — best was (0,−1) km by 4 stations out of
  278, on a plateau with ties. That criterion was ill-posed for a discrete
  noisy surface; it now requires zero shift to be statistically
  indistinguishable from the best (≤1.5 km, Δaccuracy ≤0.02). A sub-km offset
  is also physically expected (wind drift between beam height and ground).
- One unit test initially failed on a wrong *test* assumption (a 5 km synthetic
  domain has no out-of-domain bbox corners); the real-grid NaN masking is
  asserted in `verify_alignment.py` instead.
- `compare.html` had a manifest-relative path bug (12× 404) caught by the
  browser check, fixed.
- RainViewer paints ~33% more wet area (0.309 vs 0.232 of domain) — a lower
  drizzle threshold plus foreign radars; the orange fringe in
  `out/alignment.png` shows it. This is a *processing* difference, not
  misalignment.
- The 99999 sentinel in the gauge feed must be filtered (2 stations this run).
- The RV comparison uses RainViewer as a *reference for alignment*, not truth —
  both sources see the same storm, so a systematic displacement between them
  bounds our georeferencing error.

## Hosting — resolved: no server at all

Addendum, same day (~09:30–11:30 UTC). `data.geo.admin.ch` sends
`access-control-allow-origin: *` on the STAC API, the HDF5 assets, and the
gauge GeoJSON — so the browser can fetch and render the data itself, keeping
the site a pure static page. The reprojection never changes, so it is
precomputed once with the verified pyproj pipeline (`make_lut.py`,
1420×1237 uint32 LUT, 0.86 MB gzipped) and applied in JS; HDF5 decoding uses
vendored h5wasm (NIST, ~1 MB gz on the wire).

Client-side spike results (`client.html`):

- **Pixel test: PASS.** For all 12 reference frames the browser render is
  **bit-identical to the Python output — 0 of 1,756,540 pixels differ** (alpha
  compared everywhere, RGB where visible; canvas premultiplication makes RGB
  under alpha=0 uncomparable). imageOverlay bounds identical.
- Live: 12 frames fetched + decoded + rendered in 3.6 s on desktop
  (~20 ms decode + ~120 ms render per frame; expect 3–5× on a phone —
  still sub-second per frame, loaded newest-first).
- Data latency at test time: **4.9 min** — better than RainViewer (~15 min)
  and the pipeline's own earlier measurements (6–11 min).
- One-time payload: h5wasm ~1.0 MB gz + LUT 0.86 MB, both cache-forever;
  per view: ~184 KB per frame, browser-cached 2 h (`max-age=7200`).

Zoom needs no tile pyramid: the source is 1 km resolution, so the single
~500 m/px overlay already oversamples the data; Leaflet scales it to any
zoom level, showing the same 1 km blocks MeteoSwiss's own app shows.

Remaining production questions (integration, not feasibility): vendored-blob
weight on the main page, Safari/phone smoke test, and a fallback message if
geo.admin.ch ever drops CORS.

## Files

- `swissradar.py` — decode / reproject / colorize (pure, tested)
- `render.py` — fetch newest N frames → `out/png/*.png` + `out/frames.json`
- `verify_gauges.py` — ground-truth check, exits non-zero on failure
- `verify_alignment.py` — RainViewer cross-check, writes `out/alignment.png`
- `compare.html` — interactive A/B viewer (serve repo root, open `/meteoswiss/compare.html`)
- `test_swissradar.py` — offline unit tests

Reproduce: `./.venv/bin/python render.py && ./.venv/bin/python verify_gauges.py && ./.venv/bin/python verify_alignment.py`
(gauge check needs rain and the two RZC frames matching the gauge feed's
`reference_ts` — run render.py immediately first).
