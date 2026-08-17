"""Decode MeteoSwiss ODIM HDF5 radar composites and render web-map-ready PNGs.

The RZC (PRECIP) product is a 640x710 grid of instantaneous rain rate in mm/h
on a 1 km Swiss LV95 grid (somerc projection, Bessel ellipsoid). This module
turns one such file into an RGBA image on a regular EPSG:3857 grid, which
Leaflet can stretch between two lat/lon corners with L.imageOverlay — exact,
because Leaflet itself renders in EPSG:3857.

Pure logic lives here; network fetching lives in render.py so everything in
this file is testable offline.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

import h5py
import numpy as np
from PIL import Image
from pyproj import CRS, Transformer

# Official MeteoSwiss precipitation legend, taken verbatim from the config their
# own rain-radar app loads (product/output/precipitation/animation/.../animation.json).
# Pairs of (upper bound in mm/h, hex colour); the last band is open-ended.
LEGEND = [
    (1.0, "9A7E95"),
    (2.0, "0001FC"),
    (4.0, "058C2D"),
    (6.0, "05FF05"),
    (10.0, "FEFF01"),
    (20.0, "FFC703"),
    (40.0, "FF7D01"),
    (60.0, "FF1900"),
    (float("inf"), "AF00DD"),
]

# rzc + YY + DDD (day of year) + HHMM, e.g. rzc262290850vl.001.h5
_RZC_NAME = re.compile(r"^rzc(\d{2})(\d{3})(\d{2})(\d{2})")


def parse_rzc_name(name: str) -> dt.datetime:
    """Timestamp encoded in an RZC filename, as tz-aware UTC."""
    m = _RZC_NAME.match(name)
    if not m:
        raise ValueError(f"not an RZC filename: {name!r}")
    yy, doy, hh, mm = (int(g) for g in m.groups())
    base = dt.datetime(2000 + yy, 1, 1, tzinfo=dt.timezone.utc)
    return base + dt.timedelta(days=doy - 1, hours=hh, minutes=mm)


@dataclass(frozen=True)
class GridGeo:
    """Geometry of the source grid: projection plus pixel-edge origin.

    x0 is the west edge, y1 the north edge, in projected metres. Row 0 of the
    data array is the northernmost row (ODIM stores images top-down).
    """

    proj4: str
    nx: int
    ny: int
    xscale: float  # metres per pixel, east-west
    yscale: float  # metres per pixel, north-south
    x0: float
    y1: float

    @property
    def x1(self) -> float:
        return self.x0 + self.nx * self.xscale

    @property
    def y0(self) -> float:
        return self.y1 - self.ny * self.yscale


def read_odim(path) -> tuple[np.ndarray, GridGeo]:
    """Read an ODIM composite: (rain rate mm/h as float32 with NaN, geometry).

    The grid origin is derived from the file's own corner coordinates rather
    than hardcoded, with a consistency check against xsize/xscale. ODIM leaves
    it ambiguous whether LL/UR are pixel corners or centres, so both are tried
    and the one consistent with the stated grid size wins.
    """
    with h5py.File(path, "r") as f:
        data = f["/dataset1/data1/data"][:]
        where = {k: _scalar(v) for k, v in f["/where"].attrs.items()}

    nx, ny = int(where["xsize"]), int(where["ysize"])
    xscale, yscale = float(where["xscale"]), float(where["yscale"])
    proj4 = where["projdef"]

    if data.shape != (ny, nx):
        raise ValueError(f"data shape {data.shape} != (ysize, xsize) ({ny}, {nx})")

    to_proj = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_proj4(proj4), always_xy=True)
    x_ll, y_ll = to_proj.transform(where["LL_lon"], where["LL_lat"])
    x_ur, y_ur = to_proj.transform(where["UR_lon"], where["UR_lat"])

    span_x = x_ur - x_ll
    # Corners mode: span == nx * scale. Centres mode: span == (nx - 1) * scale.
    if abs(span_x - nx * xscale) <= abs(span_x - (nx - 1) * xscale):
        x0, y1 = x_ll, y_ur  # LL/UR are pixel corners
    else:
        x0, y1 = x_ll - xscale / 2, y_ur + yscale / 2  # LL/UR are pixel centres

    # Whichever mode won must reproduce the opposite corner to sub-pixel level.
    if abs((x0 + nx * xscale) - (x_ur if x0 == x_ll else x_ur + xscale / 2)) > xscale:
        raise ValueError("corner coordinates inconsistent with grid size")

    values = data.astype(np.float32)
    return values, GridGeo(proj4=proj4, nx=nx, ny=ny, xscale=xscale, yscale=yscale, x0=x0, y1=y1)


def _scalar(v):
    """h5py attribute -> plain python scalar/str."""
    if isinstance(v, bytes):
        return v.decode()
    if isinstance(v, np.ndarray):
        v = v.item() if v.size == 1 else v
    if isinstance(v, bytes):
        return v.decode()
    if isinstance(v, np.generic):
        return v.item()
    return v


def mercator_grid_indices(
    geo: GridGeo, width: int = 1420
) -> tuple[np.ndarray, np.ndarray, np.ndarray, tuple[float, float, float, float]]:
    """Nearest-neighbour source indices for a regular EPSG:3857 target grid.

    Returns (rows, cols, inside, bbox3857) with rows/cols of shape [H, W].
    This mapping depends only on the (fixed) grid geometry, never on the data —
    which is why it can be precomputed once and shipped to a browser as a
    lookup table (make_lut.py). reproject_to_mercator uses the same function,
    so the Python renderer and the browser renderer are index-identical by
    construction. The bbox is computed from densely sampled domain edges, not
    just the four corners — the LV95 rectangle maps to a slightly curved
    quadrilateral in Mercator.
    """
    src = CRS.from_proj4(geo.proj4)
    merc = CRS.from_epsg(3857)
    fwd = Transformer.from_crs(src, merc, always_xy=True)
    inv = Transformer.from_crs(merc, src, always_xy=True)

    t = np.linspace(0.0, 1.0, 200)
    ex = np.concatenate([
        geo.x0 + t * (geo.x1 - geo.x0),                      # south edge
        np.full_like(t, geo.x1),                             # east edge
        geo.x0 + t * (geo.x1 - geo.x0),                      # north edge
        np.full_like(t, geo.x0),                             # west edge
    ])
    ey = np.concatenate([
        np.full_like(t, geo.y0),
        geo.y0 + t * (geo.y1 - geo.y0),
        np.full_like(t, geo.y1),
        geo.y0 + t * (geo.y1 - geo.y0),
    ])
    bx, by = fwd.transform(ex, ey)
    bbox = (bx.min(), by.min(), bx.max(), by.max())

    px = (bbox[2] - bbox[0]) / width
    height = int(round((bbox[3] - bbox[1]) / px))

    # Pixel centres of the target grid, row 0 = north.
    xs = bbox[0] + (np.arange(width) + 0.5) * px
    ys = bbox[3] - (np.arange(height) + 0.5) * px
    gx, gy = np.meshgrid(xs, ys)

    sx, sy = inv.transform(gx, gy)
    cols = np.floor((sx - geo.x0) / geo.xscale).astype(np.int64)
    rows = np.floor((geo.y1 - sy) / geo.yscale).astype(np.int64)
    inside = (cols >= 0) & (cols < geo.nx) & (rows >= 0) & (rows < geo.ny)
    return rows, cols, inside, bbox


def reproject_to_mercator(
    values: np.ndarray, geo: GridGeo, width: int = 1420
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    """Resample the source grid onto a regular EPSG:3857 grid (nearest neighbour).

    Returns (array [H, W] float32, NaN outside the source domain) and the 3857
    bounding box (xmin, ymin, xmax, ymax).
    """
    rows, cols, inside, bbox = mercator_grid_indices(geo, width)
    out = np.full(rows.shape, np.nan, dtype=np.float32)
    out[inside] = values[rows[inside], cols[inside]]
    return out, bbox


def colorize(values: np.ndarray) -> np.ndarray:
    """mm/h -> RGBA uint8 using the official MeteoSwiss legend.

    NaN (outside radar domain) and 0 (undetect — the ODIM file declares
    undetect=0) are fully transparent; any detected rain gets a band colour.
    """
    bounds = np.array([b for b, _ in LEGEND[:-1]])
    lut = np.array(
        [[int(c[i : i + 2], 16) for i in (0, 2, 4)] for _, c in LEGEND], dtype=np.uint8
    )
    safe = np.nan_to_num(values, nan=0.0)
    idx = np.digitize(safe, bounds)  # value < bounds[i] -> band i; >= last -> len-1

    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    rgba[..., :3] = lut[idx]
    rgba[..., 3] = np.where(np.isfinite(values) & (values > 0), 255, 0)
    return rgba


def bounds_latlng(bbox: tuple[float, float, float, float]) -> list[list[float]]:
    """3857 bbox -> [[south, west], [north, east]] for L.imageOverlay."""
    to_wgs = Transformer.from_crs(CRS.from_epsg(3857), CRS.from_epsg(4326), always_xy=True)
    west, south = to_wgs.transform(bbox[0], bbox[1])
    east, north = to_wgs.transform(bbox[2], bbox[3])
    return [[south, west], [north, east]]


def render_png(values: np.ndarray, geo: GridGeo, out_path, width: int = 1420) -> list[list[float]]:
    """Full pipeline for one frame: reproject, colorize, write PNG. Returns bounds."""
    merc, bbox = reproject_to_mercator(values, geo, width=width)
    Image.fromarray(colorize(merc), mode="RGBA").save(out_path, optimize=True)
    return bounds_latlng(bbox)


def sample_at_lv95(values: np.ndarray, geo: GridGeo, e: float, n: float) -> float:
    """Rain rate at LV95 coordinates (metres). NaN if outside the grid."""
    col = int(np.floor((e - geo.x0) / geo.xscale))
    row = int(np.floor((geo.y1 - n) / geo.yscale))
    if not (0 <= col < geo.nx and 0 <= row < geo.ny):
        return float("nan")
    return float(values[row, col])
