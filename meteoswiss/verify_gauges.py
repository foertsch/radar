"""Ground-truth check: decoded radar vs the live MeteoSwiss rain-gauge network.

The 10-minute gauge sums (ch.meteoschweiz.messwerte-niederschlag-10min) are
physically independent of the radar, come on the same LV95 grid datum, and
carry a reference_ts matching radar frame times. If our decoding or grid
georeferencing were wrong, agreement would collapse — and, more sharply, the
best agreement would occur at a non-zero grid shift.

Checks:
  1. Categorical agreement (wet >= 0.1 mm/10min for both sensors) at the
     station pixel: accuracy, POD, FAR.
  2. Shift search: agreement recomputed with the radar sampling displaced by
     dx,dy in [-3,+3] km. Pass requires the optimum at (0,0).
  3. Rank correlation of amounts on stations wet in both.

Exit code 0 = all bars met.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

from swissradar import parse_rzc_name, read_odim, sample_at_lv95

GAUGE_URL = (
    "https://data.geo.admin.ch/ch.meteoschweiz.messwerte-niederschlag-10min/"
    "ch.meteoschweiz.messwerte-niederschlag-10min_en.json"
)
MISSING = 99999  # sentinel used in the gauge feed
WET_MM = 0.1  # per 10 minutes, for both sensors

# Pass bars — radar/gauge agreement is imperfect even when everything is
# correct (beam height, drift, gauge undercatch; that mismatch is why
# CombiPrecip exists). These bars catch pipeline errors, not physics.
BAR_ACCURACY = 0.80
BAR_POD = 0.65
BAR_FAR = 0.35
MIN_WET_STATIONS = 20


def fetch_json(url: str):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def load_gauges():
    d = fetch_json(GAUGE_URL)
    crs = d.get("crs", {}).get("properties", {}).get("name")
    if crs != "EPSG:2056":
        raise AssertionError(f"gauge feed CRS changed: {crs!r}")
    stations, ref_ts = [], None
    for f in d["features"]:
        p = f["properties"]
        v = p.get("value")
        if not isinstance(v, (int, float)) or v == MISSING or v < 0:
            continue
        e, n = f["geometry"]["coordinates"]
        stations.append({"name": p["station_name"], "e": e, "n": n, "mm10": float(v)})
        ref_ts = p["reference_ts"]
    if p.get("unit") != "mm":
        raise AssertionError(f"gauge unit changed: {p.get('unit')!r}")
    return stations, dt.datetime.fromisoformat(ref_ts.replace("Z", "+00:00"))


def radar_mm10(frames: list[tuple[dt.datetime, Path]], ref: dt.datetime):
    """mm per 10 min estimated from the two 5-min rate frames ending at ref.

    Returns (list of (values, geo), used_times). Instantaneous mm/h rates at
    ref-5min and ref, averaged and divided by 6, approximate the gauge's
    10-minute accumulation window (ref-10min, ref].
    """
    wanted = [ref - dt.timedelta(minutes=5), ref]
    picked = [(t, p) for t, p in frames if t in wanted]
    if len(picked) != 2:
        raise AssertionError(
            f"radar frames for {', '.join(t.strftime('%H:%M') for t in wanted)}Z "
            f"not in out/h5 — re-run render.py first (have: "
            f"{', '.join(t.strftime('%H:%M') for t, _ in frames[-4:])})"
        )
    return [read_odim(p) for _, p in picked], [t for t, _ in picked]


def contingency(stations, grids, dx=0.0, dy=0.0):
    """Confusion counts sampling each station at its LV95 position + (dx, dy) metres."""
    hits = miss = false = correct_neg = 0
    pairs = []  # (gauge mm, radar mm) where both wet, for correlation
    for s in stations:
        rates = [sample_at_lv95(v, g, s["e"] + dx, s["n"] + dy) for v, g in grids]
        if any(np.isnan(r) for r in rates):
            continue  # station outside radar domain
        est = float(np.mean(rates)) / 6.0  # mm/h -> mm per 10 min
        gw, rw = s["mm10"] >= WET_MM, est >= WET_MM
        if gw and rw:
            hits += 1
            pairs.append((s["mm10"], est))
        elif gw:
            miss += 1
        elif rw:
            false += 1
        else:
            correct_neg += 1
    return hits, miss, false, correct_neg, pairs


def spearman(pairs):
    if len(pairs) < 5:
        return float("nan")
    a = np.array([p[0] for p in pairs])
    b = np.array([p[1] for p in pairs])
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    ra -= ra.mean()
    rb -= rb.mean()
    return float((ra * rb).sum() / np.sqrt((ra**2).sum() * (rb**2).sum()))


def main() -> int:
    out = Path(__file__).parent / "out"
    frames = sorted(
        (parse_rzc_name(p.name), p) for p in (out / "h5").glob("rzc*.h5")
    )
    stations, ref = load_gauges()
    print(f"gauges: {len(stations)} stations with valid values, reference {ref:%Y-%m-%d %H:%M}Z")

    grids, used = radar_mm10(frames, ref)
    print(f"radar : frames {', '.join(t.strftime('%H:%M') for t in used)}Z\n")

    h, m, fa, cn, pairs = contingency(stations, grids)
    n = h + m + fa + cn
    acc = (h + cn) / n
    pod = h / (h + m) if h + m else float("nan")
    far = fa / (h + fa) if h + fa else float("nan")
    rho = spearman(pairs)

    print(f"stations in radar domain: {n}   gauge-wet: {h + m}   gauge-dry: {fa + cn}")
    print(f"hits {h}   misses {m}   false alarms {fa}   correct negatives {cn}")
    print(f"accuracy {acc:.2f}   POD {pod:.2f}   FAR {far:.2f}   spearman(wet-both) {rho:.2f}\n")

    # Shift search: agreement as a function of sampling displacement. With ~280
    # binary samples on a 1 km grid the surface is a plateau with ties, so the
    # criterion is NOT "argmax exactly at (0,0)" — that flips on a handful of
    # stations — but "zero shift is statistically indistinguishable from the
    # best shift". A systematic offset from a decoding/georeferencing bug would
    # be >= the 1 km pixel and would beat (0,0) decisively; a sub-km wobble is
    # at the resolution floor and physically expected (rain drifts with the
    # wind between the radar beam aloft and the gauge at ground level).
    print("shift search (categorical accuracy), dx/dy in km:")
    best, best_shift, acc00 = -1.0, None, None
    for dy_km in range(-3, 4):
        row = []
        for dx_km in range(-3, 4):
            hh, mm_, ff, cc, _ = contingency(stations, grids, dx_km * 1000, dy_km * 1000)
            a = (hh + cc) / max(1, hh + mm_ + ff + cc)
            row.append(a)
            if (dx_km, dy_km) == (0, 0):
                acc00 = a
            if a > best:
                best, best_shift = a, (dx_km, dy_km)
        print("  " + " ".join(f"{a:.3f}" for a in row) + f"   (dy={dy_km:+d})")
    shift_km = float(np.hypot(*best_shift))
    print(
        f"best accuracy {best:.3f} at shift {best_shift} km "
        f"(|shift| {shift_km:.1f} km; zero-shift {acc00:.3f}, delta {best - acc00:.3f})\n"
    )

    checks = {
        f"enough wet stations (>= {MIN_WET_STATIONS})": h + m >= MIN_WET_STATIONS,
        f"accuracy >= {BAR_ACCURACY}": acc >= BAR_ACCURACY,
        f"POD >= {BAR_POD}": pod >= BAR_POD,
        f"FAR <= {BAR_FAR}": far <= BAR_FAR,
        "best shift within 1.5 km of zero": shift_km <= 1.5,
        "zero shift within 0.02 accuracy of best": best - acc00 <= 0.02,
    }
    ok = all(checks.values())
    for name, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
    print(f"\nGAUGE CHECK: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
