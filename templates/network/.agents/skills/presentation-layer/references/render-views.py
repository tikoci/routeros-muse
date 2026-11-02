#!/usr/bin/env python3
"""render-views.py — presentation-layer reference renderer (stdlib only).

Findings fixture in, four harness-suited views out:
  views-local.html — self-contained status page (inline CSS, no refs, no script)
  views-board.svg — hand-built 1080x1350 status board
  shot.html       — SVG inlined at exact board size for headless screenshot
  views-links.md  — harness routing table + WebFig deep links (fixture host only)

Usage: render-views.py --fixtures <dir> --out <dir>
Exit: 0 views written; 2 schema violation.
"""
import argparse
import datetime
import html
import json
import os
import sys

REQUIRED_TOP = ["synthetic", "site", "matrix_date", "devices", "alerts", "webfig"]
STATUS_COLORS = {"up": "#1a7f37", "degraded": "#bf8700", "down": "#cf222e"}
W, H = 1080, 1350


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
    with open(os.path.join(args.fixtures, "findings.json"), encoding="utf-8") as fh:
        fx = json.load(fh)
    for key in REQUIRED_TOP:
        if key not in fx:
            return fail(f"missing required key {key!r}")
    if not isinstance(fx["devices"], list) or not fx["devices"]:
        return fail("devices must be a non-empty list")
    for i, dev in enumerate(fx["devices"]):
        for key in ("device", "role", "status"):
            if key not in dev:
                return fail(f"devices[{i}] missing {key!r}")
        if dev["status"] not in STATUS_COLORS:
            return fail(f"devices[{i}] unknown status {dev['status']!r}")
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    synth = "SYNTHETIC EXAMPLE" if fx.get("synthetic") is True else "REAL FINDINGS"

    rows = "\n".join(
        f'<tr><td><span class="dot" style="background:{STATUS_COLORS[d["status"]]}"></span>'
        f'{esc(d["device"])}</td><td>{esc(d["role"])}</td><td>{esc(d["status"])}</td>'
        f'<td>{esc(d.get("note", ""))}</td></tr>'
        for d in fx["devices"]
    )
    alerts = "\n".join(f'<li>[{esc(a.get("severity", "?"))}] {esc(a.get("text", ""))}</li>' for a in fx["alerts"])
    links = "\n".join(
        f'<li>{esc(p.get("label", "?"))} — {esc(fx["webfig"].get("router", "?"))}{esc(p.get("fragment", ""))}</li>'
        for p in fx["webfig"].get("pages", [])
    )
    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>status — {esc(fx["site"])}</title>
<style>body{{font-family:sans-serif;margin:2em;max-width:60em}}table{{border-collapse:collapse}}td,th{{border:1px solid #999;padding:.3em .8em}}.dot{{display:inline-block;width:.8em;height:.8em;border-radius:50%;margin-right:.5em}}footer{{margin-top:2em;color:#555;font-size:.9em}}</style>
</head>
<body>
<h1>status — {esc(fx["site"])}</h1>
<p>{synth}; generated from records fixture</p>
<table><tr><th>device</th><th>role</th><th>status</th><th>note</th></tr>
{rows}
</table>
<h2>alerts</h2>
<ul>
{alerts}
</ul>
<h2>check one thing</h2>
<ul>
{links}
</ul>
<footer>generated {stamp} · matrix {esc(fx["matrix_date"])} · {synth}</footer>
</body>
</html>
"""
    with open(os.path.join(args.out, "views-local.html"), "w", encoding="utf-8") as fh:
        fh.write(page)

    y = 200
    svg_rows = []
    for dev in fx["devices"]:
        color = STATUS_COLORS[dev["status"]]
        svg_rows.append(
            f'<rect x="90" y="{y}" width="40" height="40" fill="{color}"/>'
            f'<text x="150" y="{y + 32}" font-size="36" font-family="sans-serif">'
            f'{esc(dev["device"])} — {esc(dev["role"])} — {esc(dev["status"])}</text>'
        )
        y += 80
    for a in fx["alerts"]:
        svg_rows.append(
            f'<text x="90" y="{y + 20}" font-size="32" font-family="sans-serif" fill="#9a6700">'
            f'! [{esc(a.get("severity", "?"))}] {esc(a.get("text", ""))}</text>'
        )
        y += 60
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
        f'<rect width="{W}" height="{H}" fill="#ffffff"/>'
        f'<text x="90" y="110" font-size="52" font-family="sans-serif">status — {esc(fx["site"])}</text>'
        f'<text x="90" y="160" font-size="28" font-family="sans-serif" fill="#555555">'
        f'{synth} · generated {stamp} · matrix {esc(fx["matrix_date"])}</text>'
        + "".join(svg_rows) + "</svg>"
    )
    with open(os.path.join(args.out, "views-board.svg"), "w", encoding="utf-8") as fh:
        fh.write(svg)
    shot = (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        f"<style>html,body{{margin:0;padding:0;width:{W}px;height:{H}px}}</style>"
        "</head><body>" + svg + "</body></html>"
    )
    with open(os.path.join(args.out, "shot.html"), "w", encoding="utf-8") as fh:
        fh.write(shot)

    md = [
        f"# views for {fx['site']} ({synth}, matrix {fx['matrix_date']})",
        "",
        "Routing (keyed off harness-capability matrix v1):",
        "- local workstation agent: views-local.html (served loopback) or views-board.png (file)",
        "- sandboxed agent app: views-board.png attached + this list in a Drive .md (no loopback)",
        "- unprobed harnesses: PNG + short text; channel assumed, not observed",
        "",
        "Check one thing (WebFig deep links):",
    ]
    for p in fx["webfig"].get("pages", []):
        md.append(f"- {p.get('label', '?')}: https://{fx['webfig'].get('router', '?')}/webfig/{p.get('fragment', '')}")
    with open(os.path.join(args.out, "views-links.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")
    print(f"rendered 4 views for {fx['site']} into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
