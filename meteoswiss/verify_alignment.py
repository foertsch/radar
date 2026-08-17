"""Alignment check: our reprojected raster vs RainViewer, same instant.

The gauge check validates the LV95 source grid; this validates the EPSG:3857
raster that Leaflet actually displays — the reprojection step in between.
RainViewer is an independent processing chain, so systematic misalignment here
(wrong datum shift, flipped rows, mercator math) shows up as a rain field
displaced from RainViewer's; shared weather shows up as overlap.

Method: pick the newest frame whose timestamp RainViewer also has (both are on
10-min boundaries every second frame), rasterize both to the same 3857 grid,
build wet masks, and brute-force the (dx, dy) pixel shift that maximises IoU.
Pass requires the optimum within 4 km ground distance of zero.

Writes out/alignment.png (ours | RainViewer | overlay) for eyeballing.
"""

from __future__ import annotations

import io
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from swissradar import parse_rzc_name, read_odim, reproject_to_mercator

RV_INDEX = "https://api.rainviewer.com/public/weather-maps.json"
Z = 7  # RainViewer free-tier maximum zoom
TILE = 512
HALF = 20037508.342789244  # EPSG:3857 half-world extent, metres
WIDTH = 1024  # comparison grid width
MAX_SHIFT_PX = 15
BAR_GROUND_KM = 4.0
BAR_IOU = 0.4  # modest: the two composites use different radar networks


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def rv_tile_mask(host: str, path: str, bbox) -> np.ndarray:
    """RainViewer wet mask resampled onto our comparison grid (nearest)."""
    span = 2 * HALF / (2**Z)
    tx0 = int((bbox[0] + HALF) // span)
    tx1 = int((bbox[2] + HALF) // span)
    ty0 = int((HALF - bbox[3]) // span)
    ty1 = int((HALF - bbox[1]) // span)

    cols = tx1 - tx0 + 1
    rows = ty1 - ty0 + 1
    mosaic = np.zeros((rows * TILE, cols * TILE), dtype=bool)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            # options 0_0: no smoothing, no snow split — an honest binary mask
            url = f"{host}{path}/{TILE}/{Z}/{tx}/{ty}/2/0_0.png"
            img = Image.open(io.BytesIO(fetch(url))).convert("RGBA")
            a = np.asarray(img)[..., 3] > 0
            mosaic[(ty - ty0) * TILE : (ty - ty0 + 1) * TILE,
                   (tx - tx0) * TILE : (tx - tx0 + 1) * TILE] = a

    # Mosaic geometry in 3857.
    mx0 = tx0 * span - HALF
    my1 = HALF - ty0 * span
    px_mosaic = span / TILE

    # Our comparison grid pixel centres -> mosaic indices.
    px = (bbox[2] - bbox[0]) / WIDTH
    height = int(round((bbox[3] - bbox[1]) / px))
    xs = bbox[0] + (np.arange(WIDTH) + 0.5) * px
    ys = bbox[3] - (np.arange(height) + 0.5) * px
    ci = np.clip(((xs - mx0) / px_mosaic).astype(int), 0, mosaic.shape[1] - 1)
    ri = np.clip(((my1 - ys) / px_mosaic).astype(int), 0, mosaic.shape[0] - 1)
    return mosaic[np.ix_(ri, ci)]


def iou(a: np.ndarray, b: np.ndarray) -> float:
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return inter / union if union else float("nan")


def main() -> int:
    out = Path(__file__).parent / "out"
    frames = sorted((parse_rzc_name(p.name), p) for p in (out / "h5").glob("rzc*.h5"))

    rv = json.loads(fetch(RV_INDEX))
    rv_times = {f["time"]: f["path"] for f in rv["radar"]["past"]}
    match = [(t, p) for t, p in frames if int(t.timestamp()) in rv_times]
    if not match:
        print("no timestamp shared with RainViewer — re-run render.py", file=sys.stderr)
        return 1
    ts, h5_path = match[-1]
    print(f"comparing frame {ts:%Y-%m-%d %H:%M}Z (identical timestamp in both sources)")

    values, geo = read_odim(h5_path)
    merc, bbox = reproject_to_mercator(values, geo, width=WIDTH)
    domain = np.isfinite(merc)
    assert 0 < domain.sum() < domain.size, "expected NaN outside the Swiss composite domain"
    ours = domain & (merc > 0)

    theirs = rv_tile_mask(rv["host"], rv_times[int(ts.timestamp())], bbox) & domain

    print(f"wet fraction of domain — ours {ours.sum()/domain.sum():.3f}, "
          f"RainViewer {theirs.sum()/domain.sum():.3f}")

    base = iou(ours, theirs)
    best, best_shift = base, (0, 0)
    for dy in range(-MAX_SHIFT_PX, MAX_SHIFT_PX + 1):
        for dx in range(-MAX_SHIFT_PX, MAX_SHIFT_PX + 1):
            v = iou(np.roll(ours, (dy, dx), axis=(0, 1)), theirs)
            if v > best:
                best, best_shift = v, (dx, dy)

    px = (bbox[2] - bbox[0]) / WIDTH
    mid_lat = math.degrees(2 * math.atan(math.exp((bbox[1] + bbox[3]) / 2 / 6378137)) - math.pi / 2)
    ground_per_px = px * math.cos(math.radians(mid_lat)) / 1000  # km on the ground
    shift_km = math.hypot(*best_shift) * ground_per_px

    print(f"IoU at zero shift: {base:.3f}")
    print(f"best IoU {best:.3f} at shift ({best_shift[0]}, {best_shift[1]}) px "
          f"= {shift_km:.1f} km ground ({ground_per_px:.2f} km/px, mid-lat {mid_lat:.1f})")

    # Tri-panel image for the verdict: ours | theirs | overlay.
    h, w = ours.shape
    panel = np.zeros((h, 3 * w, 3), dtype=np.uint8)
    panel[:, :w][ours] = (0, 120, 255)
    panel[:, w : 2 * w][theirs] = (255, 140, 0)
    both = np.zeros((h, w, 3), dtype=np.uint8)
    both[ours] = (0, 120, 255)
    both[theirs] = (255, 140, 0)
    both[ours & theirs] = (255, 255, 255)
    panel[:, 2 * w :] = both
    for pnl in range(3):  # faint domain outline
        panel[:, pnl * w : (pnl + 1) * w][~domain] = (30, 30, 30)
    Image.fromarray(panel).save(out / "alignment.png")
    print(f"wrote {out / 'alignment.png'} (blue=ours, orange=RainViewer, white=both)")

    checks = {
        f"IoU at zero shift >= {BAR_IOU}": base >= BAR_IOU,
        f"optimal shift <= {BAR_GROUND_KM} km ground": shift_km <= BAR_GROUND_KM,
    }
    ok = all(checks.values())
    for name, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
    print(f"\nALIGNMENT CHECK: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
