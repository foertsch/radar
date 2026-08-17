"""Precompute the browser lookup table: EPSG:3857 pixel -> RZC grid index.

The mapping depends only on the (fixed) grid geometry, so it is computed once
with the verified pyproj pipeline and shipped as a static asset. At runtime a
browser does no projection math at all: out[i] = values[lut[i]].

Outputs (in out/):
  lut.bin.gz  gzipped little-endian uint32, length W*H; 0xFFFFFFFF = outside
  lut.json    dimensions, imageOverlay bounds, legend (single source: LEGEND)

Usage: python make_lut.py  (needs one downloaded frame in out/h5 for geometry)
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np

from swissradar import LEGEND, bounds_latlng, mercator_grid_indices, read_odim

SENTINEL = 0xFFFFFFFF
WIDTH = 1420  # must match render.py's default so reference PNGs are comparable


def main() -> int:
    out = Path(__file__).parent / "out"
    h5s = sorted((out / "h5").glob("rzc*.h5"))
    if not h5s:
        print("no RZC file in out/h5 — run render.py once first", file=sys.stderr)
        return 1

    _, geo = read_odim(h5s[-1])
    rows, cols, inside, bbox = mercator_grid_indices(geo, width=WIDTH)

    flat = (rows * geo.nx + cols).astype("<u4")
    flat[~inside] = SENTINEL

    lut_path = out / "lut.bin.gz"
    lut_path.write_bytes(gzip.compress(flat.tobytes(), 9))

    meta = {
        "width": int(flat.shape[1]),
        "height": int(flat.shape[0]),
        "nx": geo.nx,
        "ny": geo.ny,
        "sentinel": SENTINEL,
        "bounds": bounds_latlng(bbox),
        "legend": {
            "bounds": [b for b, _ in LEGEND[:-1]],
            "colors": [c for _, c in LEGEND],
        },
        "source_geometry_from": h5s[-1].name,
    }
    (out / "lut.json").write_text(json.dumps(meta, indent=1))

    raw = flat.nbytes
    gz = lut_path.stat().st_size
    print(f"lut: {flat.shape[1]}x{flat.shape[0]} px, raw {raw/1e6:.1f} MB, "
          f"gzipped {gz/1e6:.2f} MB, outside {(~inside).mean()*100:.0f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
