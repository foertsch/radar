"""Generate src/ch-border.js from Natural Earth 50m admin-0 boundaries.

Natural Earth data is public domain. The 50m Switzerland ring has ~187 points
(~1-2 km fidelity) — plenty for clipping the label layer and drawing the focus
veil, and small enough to embed. Re-run only if the source data ever changes:

    curl -sLo /tmp/ne50.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
    python3 tools/make_border.py /tmp/ne50.geojson
"""

import json
import sys
from pathlib import Path


def main(src: str) -> None:
    data = json.load(open(src))
    ring = None
    for f in data["features"]:
        if f["properties"].get("ADM0_A3") == "CHE":
            geom = f["geometry"]
            assert geom["type"] == "Polygon", geom["type"]
            ring = geom["coordinates"][0]
            break
    assert ring, "Switzerland not found"

    # GeoJSON is [lon, lat]; Leaflet wants [lat, lng]. Drop the closing
    # duplicate point — Leaflet closes rings itself.
    latlng = [[round(lat, 4), round(lon, 4)] for lon, lat in ring[:-1]]

    out = Path(__file__).parent.parent / "src" / "ch-border.js"
    body = json.dumps(latlng, separators=(",", ":"))
    out.write_text(
        "/**\n"
        " * Switzerland's national border as [lat, lng] pairs (unclosed ring).\n"
        " * Source: Natural Earth 50m admin-0 (public domain), extracted by\n"
        " * tools/make_border.py. Used to clip the detailed label layer and to\n"
        " * draw the focus veil around Switzerland.\n"
        " */\n"
        f"export const CH_BORDER = {body};\n"
    )
    print(f"wrote {out} ({len(latlng)} points, {out.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv[1])
