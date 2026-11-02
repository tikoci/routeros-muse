#!/bin/sh
# Proves the capture boundary: fixture + summaries committable, real
# pulls ignored. Builds a scratch repo from the template .gitignore and
# asserts per-path track/ignore behavior. Needs: sh, git.
set -eu
skill_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
root=$(CDPATH= cd -- "$skill_dir/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir -p "$work/observations/_sample/capture-0" "$work/observations/realdevice/pull-20261028"
cp "$root/.gitignore" "$work/"
touch "$work/observations/_sample/capture-0/manifest.json" \
  "$work/observations/realdevice/pull-20261028/manifest.json" \
  "$work/observations/realdevice/summary.md"
ln -s capture-0 "$work/observations/_sample/latest"
ln -s pull-20261028 "$work/observations/realdevice/latest"
cd "$work" && git init -q .
fail=0
check_tracked() {
  if git check-ignore -q "$1"; then echo "FAIL: $1 ignored, want tracked"; fail=1;
  else echo "ok tracked: $1"; fi
}
check_ignored() {
  if git check-ignore -q "$1"; then echo "ok ignored: $1";
  else echo "FAIL: $1 tracked, want ignored"; fail=1; fi
}
check_tracked observations/_sample/capture-0/manifest.json
check_tracked observations/_sample/latest
check_tracked observations/realdevice/summary.md
check_ignored observations/realdevice/pull-20261028/manifest.json
check_ignored observations/realdevice/latest
exit $fail
