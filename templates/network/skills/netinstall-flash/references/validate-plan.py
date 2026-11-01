#!/usr/bin/env python3
"""validate-plan.py — check a netinstall flash plan before anyone touches hardware.

Two plan kinds (see SKILL.md §0):
  kind=cli    — a netinstall-cli run from a Linux host (etherboot target).
  kind=server — a RouterOS /tool/netinstall package-flow server entry.

Rules are grounded in the routeros-netinstall domain skill (R1-R4, R6-R7)
and one observed hardware row shape (R5/R8: bigdude /tool/netinstall read,
2026-10-31, redacted to field names). Exit 0 = plan passes; non-zero prints
the failed rule id(s), one per line, as FAIL <id>: <reason>.
Stdlib only.
"""
import json
import re
import sys

SYS_RE = re.compile(r"^routeros-(\d+)\.(\d+)([a-z0-9.]*)?(?:-([a-z0-9]+))?\.npk$")
ARCHES = {"arm", "arm64", "mipsbe", "mmips", "smips", "ppc", "tile", "x86"}


def ver_tuple(pkg):
    m = SYS_RE.match(pkg)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), m.group(4))


def check_cli(p):
    fails = []
    pkgs = p.get("packages", [])
    if not pkgs:
        return ["FAIL R1: package list is empty (system package must be listed first)"]
    first = pkgs[0]
    vt = ver_tuple(first)
    if vt is None:
        fails.append(f"FAIL R1: first package is not a system package: {first}")
        vt = (0, 0, None)
    else:
        _maj, _minor, arch = vt
        if arch is None:
            # x86 naming exception: routeros-VERSION.npk carries no arch infix.
            if p.get("target", {}).get("arch") != "x86":
                fails.append(f"FAIL R1: arch-less system package only matches x86 target: {first}")
        elif arch not in ARCHES:
            fails.append(f"FAIL R1: unknown arch infix in system package: {first}")
    if p.get("config_mode") not in ("default", "empty", "keep"):
        fails.append("FAIL R2: config_mode must be one of default|empty|keep (-r|-e|neither)")
    if p.get("config_mode") == "keep" and not p.get("keep_acknowledged"):
        fails.append("FAIL R2: keep-old preserves the config DB only; "
                     "plan must set keep_acknowledged (files/UM/Dude are lost)")
    cfg = (p.get("configure_script") or "")
    mode = (p.get("modescript") or "")
    if "device-mode" in cfg:
        fails.append("FAIL R3: /system/device-mode changes belong in the modescript (-sm), "
                     "never the configure script (-s)")
    if mode and (vt[0], vt[1]) < (7, 22):
        fails.append("FAIL R3: modescript (-sm) requires RouterOS/netinstall-cli 7.22+")
    targ_arch = p.get("target", {}).get("arch")
    if targ_arch not in ARCHES:
        fails.append(f"FAIL R4: target.arch must be one of {sorted(ARCHES)}")
    elif targ_arch != "x86" and not any(f"-{targ_arch}.npk" in s for s in pkgs):
        fails.append(f"FAIL R4: no package in the set matches target arch {targ_arch} "
                     "(multi-arch sets allowed, target arch must be present)")
    host = p.get("host", {})
    if not host.get("root"):
        fails.append("FAIL R5: netinstall-cli needs root/sudo (privileged BOOTP/TFTP ports)")
    if not host.get("static_ip"):
        fails.append("FAIL R5: netinstall host needs a static IP on the flash segment")
    if host.get("os_arch") in ("arm", "aarch64") and host.get("emulator") != "qemu-i386":
        fails.append("FAIL R6: netinstall-cli is an i386 ELF; ARM hosts must plan qemu-i386")
    if host.get("os_arch") == "macos" and not host.get("vm_bridged"):
        fails.append("FAIL R6: macOS hosts must run Linux in a VM with bridged networking")
    if not p.get("target", {}).get("mac"):
        fails.append("FAIL R7: target MAC required (label photo at unbox; --mac pins the run)")
    if not p.get("target", {}).get("etherboot"):
        fails.append("FAIL R7: etherboot entry method required (button|serial|boot-device)")
    win = p.get("window", {})
    for field in ("segment_dhcp_free", "config_template", "first_pull_after"):
        if not win.get(field):
            fails.append(f"FAIL R7: window.{field} required "
                         "(DHCP-free segment, repo config template, first pull after)")
    return fails


def check_server(p):
    fails = []
    if not p.get("interface"):
        fails.append("FAIL R8: server interface required (the L2 segment facing the target)")
    if p.get("interface_slave"):
        fails.append("FAIL R8: netinstall server can not run on a slave interface "
                     "(observed .about error shape)")
    if not p.get("version"):
        fails.append("FAIL R8: server version must be pinned (image set served)")
    if p.get("keep_old_configuration") and p.get("apply_default_configuration"):
        fails.append("FAIL R8: keep-old-configuration and apply-default-configuration "
                     "contradict; pick one")
    if not p.get("mode_file") and p.get("device_mode_change"):
        fails.append("FAIL R8: device-mode changes need mode_file on the server entry")
    return fails


def main(path):
    try:
        plan = json.load(open(path))
    except (OSError, ValueError) as e:
        print(f"FAIL R0: cannot read plan JSON: {e}")
        return 2
    if plan.get("kind") == "cli":
        fails = check_cli(plan)
    elif plan.get("kind") == "server":
        fails = check_server(plan)
    else:
        print("FAIL R0: kind must be cli|server")
        return 2
    for f in fails:
        print(f)
    if fails:
        return 1
    print(f"ok: {plan.get('kind')} plan passes ({plan.get('name', 'unnamed')})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: validate-plan.py <plan.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
