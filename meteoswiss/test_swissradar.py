"""Offline tests for the ODIM -> web-mercator pipeline.

The synthetic ODIM file uses the *real* RZC projection string, so every
projection code path is exercised without network access.
"""

import datetime as dt
import math

import h5py
import numpy as np
import pytest
from pyproj import CRS, Transformer

from swissradar import (
    GridGeo,
    bounds_latlng,
    colorize,
    mercator_grid_indices,
    parse_rzc_name,
    read_odim,
    render_png,
    reproject_to_mercator,
    sample_at_lv95,
)

# Verbatim from a live RZC file's /where/projdef.
RZC_PROJ = (
    "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 "
    "+x_0=2600000 +y_0=1200000 +ellps=bessel "
    "+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs"
)


# --------------------------------------------------------------- filenames ---

def test_parse_rzc_name_decodes_year_doy_time():
    # 26 -> 2026, day 229 -> 17 Aug, 08:50 UTC (a real filename from the archive)
    assert parse_rzc_name("rzc262290850vl.001.h5") == dt.datetime(
        2026, 8, 17, 8, 50, tzinfo=dt.timezone.utc
    )


def test_parse_rzc_name_handles_jan1_and_rejects_junk():
    assert parse_rzc_name("rzc250010000vl.001.h5") == dt.datetime(
        2025, 1, 1, 0, 0, tzinfo=dt.timezone.utc
    )
    with pytest.raises(ValueError):
        parse_rzc_name("cpc262290845_00060.001.h5")


# -------------------------------------------------------------- projection ---

def test_lv95_anchor_bern():
    """swisstopo's documented WGS84 position of the LV95 origin E2600000/N1200000.

    If the towgs84 datum shift were dropped or wrong, this misses by ~100-200 m
    — exactly the silent misalignment the whole strategy would die of.
    """
    t = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_proj4(RZC_PROJ), always_xy=True)
    e, n = t.transform(7.43864, 46.95108)
    assert math.dist((e, n), (2600000, 1200000)) < 25


def test_mercator_roundtrip_subpixel():
    fwd = Transformer.from_crs(CRS.from_epsg(3857), CRS.from_proj4(RZC_PROJ), always_xy=True)
    inv = Transformer.from_crs(CRS.from_proj4(RZC_PROJ), CRS.from_epsg(3857), always_xy=True)
    for x, y in [(830000, 5950000), (950000, 6020000), (700000, 5900000)]:
        e, n = fwd.transform(x, y)
        x2, y2 = inv.transform(e, n)
        assert math.dist((x, y), (x2, y2)) < 0.5  # metres, far below the 1 km pixel


# ------------------------------------------------------------ synthetic ODIM ---

@pytest.fixture
def odim_file(tmp_path):
    """A 4x5 composite on LV95 edges E 2600000-2605000, N 1200000-1204000."""
    inv = Transformer.from_crs(CRS.from_proj4(RZC_PROJ), CRS.from_epsg(4326), always_xy=True)
    ll_lon, ll_lat = inv.transform(2600000, 1200000)
    ur_lon, ur_lat = inv.transform(2605000, 1204000)

    path = tmp_path / "synthetic.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("/dataset1/data1/data", data=np.arange(20, dtype="f8").reshape(4, 5))
        w = f.create_group("where")
        w.attrs["projdef"] = np.bytes_(RZC_PROJ)
        w.attrs["xsize"], w.attrs["ysize"] = np.int64(5), np.int64(4)
        w.attrs["xscale"], w.attrs["yscale"] = np.float64(1000), np.float64(1000)
        w.attrs["LL_lon"], w.attrs["LL_lat"] = np.float64(ll_lon), np.float64(ll_lat)
        w.attrs["UR_lon"], w.attrs["UR_lat"] = np.float64(ur_lon), np.float64(ur_lat)
    return path


def test_read_odim_recovers_grid_origin(odim_file):
    values, geo = read_odim(odim_file)
    assert values.shape == (4, 5)
    assert geo.x0 == pytest.approx(2600000, abs=1.0)
    assert geo.y1 == pytest.approx(1204000, abs=1.0)
    assert geo.x1 == pytest.approx(2605000, abs=1.0)


def test_row_zero_is_north(odim_file):
    values, geo = read_odim(odim_file)
    # Pixel centre of the NW corner cell.
    assert sample_at_lv95(values, geo, 2600500, 1203500) == 0.0
    # SE corner cell holds the last value.
    assert sample_at_lv95(values, geo, 2604500, 1200500) == 19.0
    # Outside the grid -> NaN.
    assert math.isnan(sample_at_lv95(values, geo, 2599000, 1200500))


def test_reproject_masks_outside_and_keeps_values(odim_file):
    values, geo = read_odim(odim_file)
    merc, bbox = reproject_to_mercator(values, geo, width=60)
    assert bbox[0] < bbox[2] and bbox[1] < bbox[3]
    inside = np.isfinite(merc)
    # At 5 km scale the projection curvature is sub-pixel, so the whole bbox is
    # in-domain; out-of-domain NaN masking is asserted on the real 710 km grid
    # in verify_alignment.py, where the curved corners actually appear.
    assert inside.sum() > 0.9 * merc.size
    assert set(np.unique(merc[inside])) <= set(np.arange(20.0))


def test_render_png_writes_file_and_bounds(odim_file, tmp_path):
    values, geo = read_odim(odim_file)
    out = tmp_path / "frame.png"
    bounds = render_png(values, geo, out, width=60)
    assert out.stat().st_size > 0
    (south, west), (north, east) = bounds
    assert south < north and west < east
    assert 46.9 < south < north < 47.1 and 7.3 < west < east < 7.6  # around Bern


def test_lut_reconstruction_equals_reproject(odim_file):
    """The browser path (flat LUT lookup) must be index-identical to the Python
    renderer — this equality is what makes the pixel-for-pixel browser
    verification meaningful."""
    values, geo = read_odim(odim_file)
    merc, _ = reproject_to_mercator(values, geo, width=60)

    rows, cols, inside, _ = mercator_grid_indices(geo, width=60)
    flat = (rows * geo.nx + cols).ravel()
    via_lut = values.ravel()[np.where(inside.ravel(), flat, 0)].astype(np.float32)
    via_lut[~inside.ravel()] = np.nan

    assert np.array_equal(via_lut, merc.ravel(), equal_nan=True)


# ---------------------------------------------------------------- colours ---

def test_colorize_official_bands():
    v = np.array([[np.nan, 0.0, 0.5, 1.0, 2.0, 5.0, 15.0, 100.0]])
    rgba = colorize(v)
    alpha = rgba[0, :, 3]
    assert list(alpha[:2]) == [0, 0]  # nodata and undetect transparent
    assert all(alpha[2:] == 255)

    def hex_at(i):
        return "".join(f"{c:02X}" for c in rgba[0, i, :3])

    assert hex_at(2) == "9A7E95"  # 0-1
    assert hex_at(3) == "0001FC"  # band minimum is inclusive
    assert hex_at(4) == "058C2D"  # 2-4
    assert hex_at(5) == "05FF05"  # 4-6
    assert hex_at(6) == "FFC703"  # 10-20
    assert hex_at(7) == "AF00DD"  # open-ended top band


def test_bounds_latlng_orientation():
    b = bounds_latlng((900000, 5900000, 1000000, 6000000))
    (south, west), (north, east) = b
    assert south < north and west < east
