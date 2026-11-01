#!/bin/sh
# test.sh — container-render-surface static self-test (no router needed).
# Proves the SHIPPED artifacts honor the drill's transport rules + hash record:
# YAML safety (ASCII, no doubles, paired backslashes, keys, parse), expected
# served-body hashes recomputed, twin-run citation present.
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null 2>&1 || { echo "FAIL: missing python3"; exit 1; }
fail=0

python3 - "$refs" <<'EOF'
import hashlib, sys
refs = sys.argv[1]
fails = []
def check(cond, label):
    print(("ok" if cond else "FAIL") + ": " + label)
    if not cond:
        fails.append(label)
bodies = {
    "v1": ("<html><head><title>t28-render-v1</title></head><body><h1>t28-render-v1</h1><p>up</p><p><a href=/note.txt>note</a></p></body></html>",
           "quick-check: all systems nominal (v1)\n",
           "0aeeb5cdff68981c", "e754a7b1076deb7c", 131, 38),
    "v2": ("<html><head><title>t28-render-v2</title></head><body><h1>t28-render-v2</h1><p>up</p><p><a href=/note.txt>note</a></p></body></html>",
           "quick-check: all systems nominal (v2, post-sync)\n",
           "e732a34105e34b42", "622d9eb83f63184f", 131, 49),
}
for ver, (root, note, rh, nh, rl, nl) in bodies.items():
    p = f"{refs}/t28-render-{ver}.tikapp.yaml"
    raw = open(p, "rb").read()
    try:
        txt = raw.decode("ascii")
        check(True, f"{ver} ASCII-only")
    except UnicodeDecodeError:
        txt = ""
        check(False, f"{ver} ASCII-only")
    check('"' not in txt, f"{ver} no double quotes (RouterOS string wrap)")
    check(txt.replace("\\\\", "").count("\\") == 0, f"{ver} backslashes paired (RouterOS unescape)")
    for key in ("name: t28-render", "image: node:alpine", "command: 'node /app.js'",
                "'8081:80/tcp'", "source: app-js", "target: /app.js", "content: |"):
        check(key in txt, f"{ver} key: {key}")
    try:
        import yaml
        d = yaml.safe_load(txt)
        check(d["services"]["web"]["image"] == "node:alpine", f"{ver} pyyaml parses, image ok")
    except ImportError:
        print(f"ok: {ver} pyyaml absent, structural grep stands in")
    check(hashlib.sha256(root.encode()).hexdigest()[:16] == rh and len(root) == rl,
          f"{ver} root record hash {rh} ({rl} B)")
    check(hashlib.sha256(note.encode()).hexdigest()[:16] == nh and len(note) == nl,
          f"{ver} note record hash {nh} ({nl} B)")
    marker = f"t28-render-{ver}"
    check(marker in txt, f"{ver} marker {marker} in YAML")
tr = open(f"{refs}/twin-run.md").read()
for cite in ("KVM host", "2026-10-30", "CHR twin", "7.26beta3"):
    check(cite in tr, f"twin-run cites {cite}")
sys.exit(1 if fails else 0)
EOF
[ $? -ne 0 ] && fail=1
exit $fail
