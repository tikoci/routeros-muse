#!/usr/bin/env python3
"""build-outdoor.py — maps-outdoor reference builder (stdlib only).

Synthetic outdoor fixture in, three artifacts out:
  outdoor.html — layered page (question header, 4 layer sections w/ source
                 footers, honesty labels; no external refs, no script)
  outdoor.kml  — one Placemark per device + spot, one LineString per link
  outdoor-layers.md — per-layer source/date/grade record

Usage: build-outdoor.py --fixtures <dir> --out <dir>
Exit: 0 artifacts written; 2 schema violation.
"""
import argparse
import datetime
import html
import json
import os
import sys

REQUIRED_TOP = ["synthetic", "site", "question", "layers", "devices", "link"]
REQUIRED_LAYERS = ["starlink", "lidar", "parcels", "solar"]
FORBIDDEN_FIELD = "owner_name"


def fail(msg):
    print(f"schema violation: {msg}", file=sys.stderr)
    return 2


def esc(text):
    return html.escape(str(text), quote=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    with open(os.path.join(args.fixtures, "outdoor.json"), encoding="utf-8") as fh:
        fx = json.load(fh)
    for key in REQUIRED_TOP:
        if key not in fx:
            return fail(f"missing required key {key!r}")
    for layer in REQUIRED_LAYERS:
        if layer not in fx["layers"]:
            return fail(f"missing required layer {layer!r}")
        for key in ("source", "date", "grade"):
            if key not in fx["layers"][layer]:
                return fail(f"layers.{layer} missing {key!r}")
    if FORBIDDEN_FIELD in json.dumps(fx):
        return fail(f"forbidden parcel field {FORBIDDEN_FIELD!r} present")
    for i, dev in enumerate(fx["devices"]):
        for key in ("device", "lat", "lon"):
            if key not in dev:
                return fail(f"devices[{i}] missing {key!r}")
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    synth = "SYNTHETIC EXAMPLE" if fx.get("synthetic") is True else "REAL RECORDS"

    sections = []
    for layer in REQUIRED_LAYERS:
        lay = fx["layers"][layer]
        detail = lay.get("terrain") or lay.get("sky_view") or f"crossings={lay.get('crossings')}" \
            or f"winter_sun_hours={lay.get('winter_sun_hours')}" or ""
        sections.append(
            f"<h2>{layer}</h2>\n<p>{esc(detail)}</p>\n"
            f"<p><em>source: {esc(lay['source'])} · {esc(lay['date'])} · grade: {esc(lay['grade'])}</em></p>"
        )
    page = (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        f"<title>outdoor — {esc(fx['site'])}</title>\n"
        "<style>body{font-family:sans-serif;margin:2em;max-width:60em}footer{margin-top:2em;color:#555}</style>\n"
        "</head>\n<body>\n"
        f"<h1>outdoor — {esc(fx['site'])}</h1>\n"
        f"<p>link question: {esc(fx['question'])}</p>\n"
        f"<p>{synth}; planning sketch, not a survey</p>\n"
        + "\n".join(sections) +
        f"\n<footer>generated {stamp} · {synth}</footer>\n</body>\n</html>\n"
    )
    with open(os.path.join(args.out, "outdoor.html"), "w", encoding="utf-8") as fh:
        fh.write(page)

    by_device = {d["device"]: d for d in fx["devices"]}
    marks = []
    for dev in fx["devices"]:
        marks.append(
            f"<Placemark><name>{esc(dev['device'])}</name>"
            f"<Point><coordinates>{dev['lon']},{dev['lat']},0</coordinates></Point></Placemark>"
        )
    for layer in REQUIRED_LAYERS:
        spot = fx["layers"][layer].get("dish_spot") or fx["layers"][layer].get("spot")
        if spot:
            marks.append(
                f"<Placemark><name>{layer}-spot</name>"
                f"<Point><coordinates>{spot['lon']},{spot['lat']},0</coordinates></Point></Placemark>"
            )
    link = fx["link"]
    a, b = by_device[link["from"]], by_device[link["to"]]
    marks.append(
        f"<Placemark><name>link-{esc(link['from'])}-{esc(link['to'])}</name>"
        f"<LineString><coordinates>{a['lon']},{a['lat']},0 {b['lon']},{b['lat']},0</coordinates>"
        "</LineString></Placemark>"
    )
    kml = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document>"
        f"<name>{esc(fx['site'])} ({synth})</name>"
        f"<description>planning sketch, not a survey</description>"
        + "".join(marks) + "</Document></kml>\n"
    )
    with open(os.path.join(args.out, "outdoor.kml"), "w", encoding="utf-8") as fh:
        fh.write(kml)

    md = [f"# outdoor layers for {fx['site']} ({synth})", ""]
    for layer in REQUIRED_LAYERS:
        lay = fx["layers"][layer]
        md.append(f"- {layer}: {lay['source']} · {lay['date']} · grade {lay['grade']}")
    with open(os.path.join(args.out, "outdoor-layers.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")
    print(f"built outdoor views for {fx['site']} into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
