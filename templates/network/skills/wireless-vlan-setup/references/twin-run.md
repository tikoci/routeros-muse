# twin-run — wireless-vlan-setup guest-VLAN drill

Date: 2026-10-30. Machine: a KVM host. Target: a CHR twin,
7.26beta3 x86, user NIC, ports 9100-9105. Driver: centrs
via `--quickchr`. Commands + trimmed outputs follow.
Other twins untouched; the drill twin left pristine and
stopped (its prior state).

## Commands (each ran; returns observed)

Build (7 writes): `/interface/vlan/add` x2 (office vlan-id 10,
guest vlan-id 20, `*3`/`*4`), `/ip/address/add` x2 (`*2`/`*3`),
`/ip/pool/add` (`*1`, 10.20.20.100-199), `/ip/dhcp-server/
network/add` (`*1`), `/ip/dhcp-server/add` (`*1`,
`invalid=false`). Read-back: connected route `DAc
10.10.10.0/24 via t28-wv-office`.

Isolation + probe (4 writes): forward log g2o (`*2`), forward
drop g2o (`*3`), forward log to dark 10.20.20.50 (`*4`),
dstnat diverter tcp/443 -> 10.20.20.50 (`*2`). Re-print:
`*1` factory, `*2` log, `*3` drop, `*4` log — position-exact.

Verify: 3x `curl -sk -m4 https://127.0.0.1:9101/` (exit 28
each, SYNs die at the dark address) -> forward probe 6
packets / 264 bytes AND dstnat diverter 6 packets / 264
bytes (same packets; log confirms `in:ether1
out:t28-wv-guest`). g2o rows 0/0 — zero-hit = match-unproven,
stated honestly. Static lease `AA:BB:CC:DD:EE:01` ->
10.20.20.150 reads `waiting`/`never` (no L2 client attached).

Teardown (8 writes, dependency order): nat divert -> filter
rows -> lease -> dhcp server -> dhcp network -> pool ->
addresses -> vlans, each `{"ret":""}`. Re-prints: vlan, pool,
dhcp-server, dhcp-network, lease all `{}`; address back to
DHCP-only ether1; filter + nat back to the factory
`unused-hs-chain` placeholder. `quickchr stop <twin>`.

## What this run does NOT cover (pending)

Radio/AP behavior (SSID→VLAN datapath, WPA-Enterprise/RADIUS
per-person VLAN, roaming), real-client DHCP/DNS, guest→office
drop under live traffic, v6 separation, bridge-VLAN/trunk
shapes. CHR has no wireless menus; these need hardware.
