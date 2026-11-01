#!/usr/bin/env python3
"""render-site-plan.py — site-plan-multi-ap reference renderer (stdlib only).

Survey fixture in, three artifacts out:
  site-plan.svg — stacked per-floor panels (room boxes, AP markers colored
                  by band, channel text, dashed sketch-coverage circles)
  site-plan.md  — AP table with model citations + computed channel warnings
  shot.html     — SVG inlined at exact board size for headless screenshot

Usage: render-site-plan.py --fixtures <dir> --out <dir>
Exit: 0 artifacts written; 2 schema violation.
"""
import argparse
import datetime
import html
import json
import os
import sys

BAND_COLORS = {"2.4": "#0969da", "5": "#1a7f37", "6": "#8250df"}
PANEL_W, PANEL_H, GAP = 1000, 420, 40
TOP = 150


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
    with open(os.path.join(args.fixtures, "site.json"), encoding="utf-8") as fh:
        fx = json.load(fh)
    for key in ("synthetic", "site", "floors", "aps", "adjacency"):
        if key not in fx:
            return fail(f"missing required key {key!r}")
    if not fx["floors"] or not fx["aps"]:
        return fail("floors and aps must be non-empty")
    for i, fl in enumerate(fx["floors"]):
        for key in ("name", "rooms"):
            if key not in fl:
                return fail(f"floors[{i}] missing {key!r}")
    for i, ap_ in enumerate(fx["aps"]):
        for key in ("device", "floor", "room", "x", "y", "band", "channel", "ssids", "model_cite"):
            if key not in ap_:
                return fail(f"aps[{i}] missing {key!r}")
        if ap_["band"] not in BAND_COLORS:
            return fail(f"aps[{i}] unknown band {ap_['band']!r}")
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    synth = "SYNTHETIC EXAMPLE" if fx.get("synthetic") is True else "REAL SURVEY"

    by_device = {a["device"]: a for a in fx["aps"]}
    warnings = []
    for pair in fx["adjacency"]:
        a, b = by_device.get(pair[0]), by_device.get(pair[1])
        if a is None or b is None:
            return fail(f"adjacency pair {pair} names unknown AP")
        if a["channel"] == b["channel"]:
            warnings.append(f"WARN: same-channel adjacent {a['device']} {b['device']} ch{a['channel']}")

    total_h = TOP + len(fx["floors"]) * (PANEL_H + GAP)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="{total_h}" viewBox="0 0 1080 {total_h}">',
        f'<rect width="1080" height="{total_h}" fill="#ffffff"/>',
        f'<text x="40" y="60" font-size="44" font-family="sans-serif">site plan — {esc(fx["site"])}</text>',
        f'<text x="40" y="105" font-size="24" font-family="sans-serif" fill="#555555">'
        f'{synth} · generated {stamp} · coverage: estimate (sketch, not a survey)</text>',
    ]
    for fi, fl in enumerate(fx["floors"]):
        oy = TOP + fi * (PANEL_H + GAP)
        parts.append(f'<text x="40" y="{oy - 12}" font-size="30" font-family="sans-serif">floor: {esc(fl["name"])}</text>')
        for room in fl["rooms"]:
            parts.append(
                f'<rect x="{40 + room["x"]}" y="{oy + room["y"]}" width="{room["w"]}" height="{room["h"]}" '
                'fill="none" stroke="#333333" stroke-width="2"/>'
                f'<text x="{40 + room["x"] + 10}" y="{oy + room["y"] + 30}" font-size="22" '
                f'font-family="sans-serif">{esc(room.get("label", room["id"]))}</text>'
            )
        for ap_ in fx["aps"]:
            if ap_["floor"] != fl["name"]:
                continue
            cx, cy = 40 + ap_["x"], oy + ap_["y"]
            color = BAND_COLORS[ap_["band"]]
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="95" fill="none" stroke="#999999" stroke-width="2" stroke-dasharray="8,6"/>')
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="16" fill="{color}"/>')
            parts.append(
                f'<text x="{cx + 24}" y="{cy - 8}" font-size="22" font-family="sans-serif">'
                f'{esc(ap_["device"])} ch{esc(ap_["channel"])} {esc(ap_["band"])}GHz</text>'
            )
            parts.append(
                f'<text x="{cx + 24}" y="{cy + 20}" font-size="20" font-family="sans-serif" fill="#555555">'
                f'{esc(",".join(ap_["ssids"]))} · tx {esc(ap_["tx"])}</text>'
            )
    svg = "".join(parts) + "</svg>"
    with open(os.path.join(args.out, "site-plan.svg"), "w", encoding="utf-8") as fh:
        fh.write(svg)
    shot = (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        f"<style>html,body{{margin:0;padding:0;width:1080px;height:{total_h}px}}</style>"
        "</head><body>" + svg + "</body></html>"
    )
    with open(os.path.join(args.out, "shot.html"), "w", encoding="utf-8") as fh:
        fh.write(shot)

    md = [f"# site plan for {fx['site']} ({synth}, generated {stamp})", "",
          "| device | room | channel | tx | ssids | model |",
          "|---|---|---|---|---|---|"]
    for ap_ in fx["aps"]:
        md.append(f"| {ap_['device']} | {ap_['floor']}/{ap_['room']} | {ap_['band']}GHz ch{ap_['channel']} "
                  f"| {ap_['tx']} | {','.join(ap_['ssids'])} | {ap_['model_cite']} |")
    md += ["", f"warnings: {len(warnings)}"] + warnings
    md += ["", "coverage: estimate (sketch, not a survey)."]
    with open(os.path.join(args.out, "site-plan.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")
    print(f"rendered site plan for {fx['site']} into {args.out} ({len(warnings)} warnings)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
