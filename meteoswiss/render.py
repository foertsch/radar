"""Fetch the newest RZC frames from the MeteoSwiss STAC and render PNGs.

Usage:
    python render.py [--frames N] [--out DIR]

Writes out/png/rzc_<UTC>.png per frame plus out/frames.json with the shared
imageOverlay bounds — every frame lives on the same grid, so the bounds are
computed once and asserted identical across frames.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

from swissradar import parse_rzc_name, read_odim, render_png

STAC_ITEM = (
    "https://data.geo.admin.ch/api/stac/v1/collections/"
    "ch.meteoschweiz.ogd-radar-precip/items/{day}-ch"
)


def fetch_json(url: str):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def list_rzc_assets(now: dt.datetime, want: int) -> list[tuple[dt.datetime, str, str]]:
    """Newest RZC assets as (timestamp, name, href), oldest first.

    Reads today's STAC item and, when that holds too few frames (early UTC
    morning), yesterday's as well.
    """
    out: list[tuple[dt.datetime, str, str]] = []
    for back in (0, 1):
        day = (now - dt.timedelta(days=back)).strftime("%Y%m%d")
        try:
            item = fetch_json(STAC_ITEM.format(day=day))
        except Exception as e:  # noqa: BLE001 - a missing day item is expected at 00:0x UTC
            print(f"  (no item for {day}: {e})", file=sys.stderr)
            continue
        for name, asset in item.get("assets", {}).items():
            if name.startswith("rzc"):
                out.append((parse_rzc_name(name), name, asset["href"]))
        if len(out) >= want:
            break
    out.sort()
    return out[-want:]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=12, help="number of newest frames (12 = 1 h)")
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "out")
    ap.add_argument("--width", type=int, default=1420)
    args = ap.parse_args()

    h5_dir = args.out / "h5"
    png_dir = args.out / "png"
    h5_dir.mkdir(parents=True, exist_ok=True)
    png_dir.mkdir(parents=True, exist_ok=True)

    now = dt.datetime.now(dt.timezone.utc)
    assets = list_rzc_assets(now, args.frames)
    if not assets:
        print("no RZC assets found", file=sys.stderr)
        return 1

    latency = (now - assets[-1][0]).total_seconds()
    print(f"newest frame {assets[-1][0]:%Y-%m-%d %H:%M}Z — latency {latency/60:.1f} min")

    frames = []
    bounds = None
    for ts, name, href in assets:
        h5_path = h5_dir / name
        if not h5_path.exists():
            urllib.request.urlretrieve(href, h5_path)

        values, geo = read_odim(h5_path)
        png_name = f"rzc_{ts:%Y%m%d_%H%M}.png"
        b = render_png(values, geo, png_dir / png_name, width=args.width)

        if bounds is None:
            bounds = b
        elif b != bounds:
            raise AssertionError(f"frame {name} bounds differ: {b} != {bounds}")

        wet = np.isfinite(values) & (values > 0)
        print(
            f"  {ts:%H:%M}Z  wet {wet.mean()*100:5.1f}% of grid   "
            f"max {np.nanmax(values):6.1f} mm/h  -> {png_name}"
        )
        frames.append({"time": int(ts.timestamp()), "png": f"png/{png_name}"})

    manifest = {
        "bounds": bounds,
        "frames": frames,
        "generated": int(now.timestamp()),
        "latency_seconds": int(latency),
        "attribution": "Source: MeteoSwiss",
    }
    (args.out / "frames.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {len(frames)} frames + frames.json (bounds {bounds})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
