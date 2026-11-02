#!/usr/bin/env python3
"""render-sheet.py — field sheets from records (offline, stdlib only).

Reads a sheets spec (JSON: revision + locations with devices/aiming/steps)
and emits one phone-portrait HTML page per location. Every step MUST carry
an expected result and a stop condition — a step without either rejects the
whole spec (exit non-zero naming the gap), because a sheet that cannot say
"how to tell it worked" or "when to stop" must not reach hands.

Usage: render-sheet.py --spec <sheets.json> --out <dir>
"""
import argparse
import html
import json
import sys
from pathlib import Path

CSS = """body{font-family:sans-serif;margin:0;background:#fff;color:#111}
.page{width:1080px;min-height:1350px;margin:0 auto;padding:48px 56px;box-sizing:border-box}
h1{font-size:52px;margin:0 0 4px} .device{font-size:28px;color:#444;margin-bottom:8px}
.rev{font-size:22px;color:#666;margin-bottom:28px}
h2{font-size:34px;border-bottom:3px solid #111;padding-bottom:6px;margin:34px 0 12px}
.dev{font-size:28px;margin:10px 0} .dev b{font-size:32px}
.ports{font-size:26px;color:#222;margin:4px 0 4px 28px}
.aim{font-size:30px;background:#f2f6ff;border:2px solid #3355aa;border-radius:12px;padding:16px 20px}
.step{font-size:28px;margin:18px 0} .step b.task{font-size:32px}
.see{margin:8px 0 0 28px} .stop{margin:8px 0 0 28px;color:#8a0000;font-weight:bold}
.footer{margin-top:36px;font-size:22px;color:#555;border-top:2px dashed #888;padding-top:12px}
@media print{.page{min-height:auto}}"""


def esc(s):
    return html.escape(str(s))


def check(spec):
    errs = []
    if not spec.get("revision"):
        errs.append("spec needs a revision id")
    locs = spec.get("locations", [])
    if not locs:
        errs.append("spec needs at least one location")
    for loc in locs:
        device = loc.get("device", "?")
        for f in ("title", "devices", "steps"):
            if not loc.get(f):
                errs.append(f"{device}: missing {f}")
        for i, d in enumerate(loc.get("devices", [])):
            if not d.get("label"):
                errs.append(f"{device}: device {i} needs a label")
        for i, s in enumerate(loc.get("steps", []), 1):
            if not s.get("task"):
                errs.append(f"{device}: step {i} needs a task")
            if not s.get("expected"):
                errs.append(f"{device}: step {i} needs an expected result")
            if not s.get("stop"):
                errs.append(f"{device}: step {i} needs a stop condition")
    return errs


def page(loc, rev):
    devs = []
    for d in loc["devices"]:
        ports = "".join(f'<div class="ports">{esc(p)}</div>' for p in d.get("ports", []))
        devs.append(f'<div class="dev"><b>{esc(d["label"])}</b>{ports}</div>')
    steps = []
    for i, s in enumerate(loc["steps"], 1):
        steps.append(
            f'<div class="step"><b class="task">{i}. {esc(s["task"])}</b>'
            f'<div class="see">You should see: {esc(s["expected"])}</div>'
            f'<div class="stop">If not, STOP: {esc(s["stop"])}</div></div>')
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>{esc(loc["device"])} field sheet</title><style>{CSS}</style></head><body>
<div class="page"><h1>{esc(loc["title"])}</h1>
<div class="device">Location: {esc(loc["device"])}</div>
<div class="rev">Revision {esc(rev)} — generated from records, never hand-edited</div>
<h2>Gear at this location</h2>{"".join(devs)}
<h2>Where things point</h2><div class="aim">{esc(loc.get("aiming", ""))}</div>
<h2>Steps</h2>{"".join(steps)}
<div class="footer">Done means every step's "You should see" held. Anything else:
stop, photograph what you see, and send the photo plus this revision id to the agent.</div>
</div></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    errs = check(spec)
    if errs:
        for e in errs:
            print(f"FAIL sheet: {e}")
        return 1
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for loc in spec["locations"]:
        (out / f'sheet-{loc["device"]}.html').write_text(page(loc, spec["revision"]))
    print(f"rendered {len(spec['locations'])} field sheets into {a.out} "
          f"(rev {spec['revision']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
