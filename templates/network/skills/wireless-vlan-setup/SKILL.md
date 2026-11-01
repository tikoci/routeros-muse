---
name: wireless-vlan-setup
description: "Set up guest/staff VLANs the provable way: pull first, propose subnets plus separation rows with placement, twin-build VLAN+DHCP, verify with forward counters and lease checks, tag and ledger. Use when: adding a guest or IoT VLAN, isolating wireless clients from office subnets, or proving VLAN separation before production."
topics: [wireless, vlan]
requires: [twin]
tested: twin-run
---

# `wireless-vlan-setup` skill (pull → propose → twin-build → counter-verify → tag) [template v1 draft]

Promoted from the executed guest-VLAN drill
(a 7.26beta3 twin): office VLAN 10 +
guest VLAN 20 on one CHR, address + pool + DHCP-server build,
guest→office log+drop rows with position-exact read-back, a
dstnat-diverted forward-counter proof (6 packets / 264 bytes,
dstnat and forward counts agreeing), a static-lease read-back
(`waiting`/`never` — no L2 client available), and teardown to
pristine in dependency order. Consumes the `routeros-firewall`
DOMAIN skill (forward/drop/log/dstnat semantics), plus
`routeros-scripting` (print/find/tag idioms) and
`routeros-fundamentals` (v7 facts) — cited, never vendored —
and adds OUR procedure (pull-first, proposal shape, drift
handling, verification, ledger). Follows the `firewall-apply`
counter-proof + placement precedent and the `hotspot-ops`
VLAN-build precedent (pool/address shapes agree). No
`routeros-wireless` domain skill exists yet: radio/AP behavior
is PRESCRIBED, not consumed. No
secrets below.

## Part 1 — The checklist (isolation is a claim until counters say so)

Run top to bottom. No VLAN/DHCP/firewall write touches a
non-twin box before step 3 passes on a twin AND the proposal
(step 1) has owner approval.

1. Pull and adopt: read the live VLAN/address/pool/DHCP/
   firewall state before proposing anything. Undocumented
   VLANs are findings, not gaps.
2. Write the proposal: VLAN IDs, subnets, DHCP shape,
   separation rows with placement, counter prediction,
   rollback read (tag cleanup + pre-change prints).
3. Twin-build the serving path: VLAN + address + pool +
   DHCP network + DHCP server; read back `invalid=false`
   and the connected route.
4. Twin-verify separation: placement-exact isolation rows,
   a live forward-counter proof for the method, a lease
   check for the serving path, and an honest zero-hit
   statement for what no test client exercised.
5. Apply tagged, ledger, clear: every owned row carries
   the change tag; rollback is one tag remove per menu +
   re-print against the pre-change prints.

### 0. Adopt the current L2/L3 state (reads — the mandatory opening)

```sh
centrs execute --quickchr <twin> '/interface/vlan/print'
centrs execute --quickchr <twin> '/ip/address/print'
centrs execute --quickchr <twin> '/ip/pool/print'
centrs execute --quickchr <twin> '/ip/dhcp-server/print'
centrs execute --quickchr <twin> '/ip/dhcp-server/network/print'
centrs execute --quickchr <twin> '/ip/dhcp-server/lease/print'
centrs execute --quickchr <twin> '/ip/firewall/filter/print'
```

- Grounded: the twin baseline read `{}` on
  vlan/pool/dhcp/network, DHCP-only ether1 address, factory
  `unused-hs-chain` placeholder — the clean floor the drill
  built on and returned to.
- Adopt per `import-existing-network`: facts AND absences. "No
  VLAN rows" is the plan input for this skill; "only the
  factory hotspot placeholder in filter" is the STOP rule for
  assuming any policy exists. A second VLAN already using
  your planned ID is a conflict found here, not at apply time.
- Drift handling: re-pull right before the proposal; a VLAN
  or DHCP row that appeared since the last capture belongs to
  someone — reconcile (ledger/work-flag-note) before staging
  beside it. Never reuse a VLAN ID or subnet already live.

### 1. Propose (the approval artifact)

```text
# Proposal shape (written, approved, then executed verbatim):
#  vlans:    <id + name + parent interface per VLAN>
#  subnets:  <gateway/prefix per VLAN; pool ranges inside guest nets>
#  dhcp:     <server name + interface + pool + network row (gateway, dns)>
#  separate: <forward drop guest->office + log shadow, with placement>
#  counters: <predicted hits from <traffic source>>
#  radio:    <SSID/AP attachment prescribed for hardware — twin can't prove it>
#  rollback: tag remove per menu (dependency order) + pre-change prints attached
```

- Grounded shape: VLAN 10 office /
  VLAN 20 guest on ether1, `10.10.10.1/24` + `10.20.20.1/24`
  gateways, pool `10.20.20.100-199`, server bound to the
  guest VLAN, g2o log-above-drop in forward.
- Position is part of the proposal (`firewall-apply` rule):
  the log shadow sits ABOVE its drop, and both sit above any
  accept that could match the same guest→office traffic. The
  approver approves the POSITION.
- Counter prediction forces a verification plan: "3 diverted
  hits → ~6 packets on the forward probe" is falsifiable; "it
  should work" is not. The twin run (step 3) checks it.
- The radio line is always present and always prescribed:
  SSID→VLAN datapath, per-person VLAN via RADIUS,
  and AP hardware behavior need hardware or an L2-capable
  bench — a CHR twin never proves them (twin-ops CHR limits).

### 2. Twin-build the serving path (writes — the build step)

```sh
centrs execute --quickchr <twin> '/interface/vlan/add name=<office> vlan-id=10 interface=ether1 comment="<tag>"' --yes
centrs execute --quickchr <twin> '/interface/vlan/add name=<guest> vlan-id=20 interface=ether1 comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/address/add address=10.10.10.1/24 interface=<office> comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/address/add address=10.20.20.1/24 interface=<guest> comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/pool/add name=<tag>-pool ranges=10.20.20.100-10.20.20.199 comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/network/add address=10.20.20.0/24 gateway=10.20.20.1 dns-server=10.20.20.1 comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/add name=<tag>-dhcp interface=<guest> address-pool=<tag>-pool disabled=no comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/print'   # invalid=false, disabled=false
centrs execute --quickchr <twin> '/ip/route/print where dst-address in 10.10.10.0/24'  # DAc connected
```

- Grounded end to end: every add
  returned its `.id`; server read back `invalid=false`;
  the office connected route showed `DAc ... main 0`.
- The DHCP server needs the FULL triple — pool + network
  row + server — before `invalid=false` means anything.
  A server without its network row is the classic silent
  misbuild; the read-back (not the add's `ret`) is the proof.
- Build the office side too even when the ask is "guest
  only": isolation needs a FROM and a TO, and the office
  subnet is the TO the drop rows name. One box, both ends.

### 3. Twin-verify separation (writes + traffic — the proof step)

```sh
# Isolation rows: log shadow ABOVE its drop (append in order, or place-before)
centrs execute --quickchr <twin> '/ip/firewall/filter/add chain=forward src-address=10.20.20.0/24 dst-address=10.10.10.0/24 action=log log-prefix="<tag>-g2o" comment="<tag>-g2o-log"' --yes
centrs execute --quickchr <twin> '/ip/firewall/filter/add chain=forward src-address=10.20.20.0/24 dst-address=10.10.10.0/24 action=drop comment="<tag>-g2o-drop"' --yes
# Method proof: dstnat diverter on an UNUSED port -> dark guest address + forward log probe
centrs execute --quickchr <twin> '/ip/firewall/filter/add chain=forward dst-address=10.20.20.50 protocol=tcp action=log log-prefix="<tag>-fwd" comment="<tag>-fwd-log"' --yes
centrs execute --quickchr <twin> '/ip/firewall/nat/add chain=dstnat protocol=tcp dst-port=443 action=dst-nat to-addresses=10.20.20.50 comment="<tag>-divert"' --yes
curl -sk -m4 -o /dev/null https://127.0.0.1:<twin-https>/   # x3; SYNs die at the dark address
centrs execute --quickchr <twin> '/ip/firewall/filter/print stats'  # fwd-log nonzero; g2o rows read too
centrs execute --quickchr <twin> '/ip/dhcp-server/lease/add mac-address=AA:BB:CC:DD:EE:01 address=10.20.20.150 server=<tag>-dhcp comment="<tag>"' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/lease/print'      # static path: waiting / never
```

- Grounded: 3 diverted hits → 6
  packets / 264 bytes on BOTH the dstnat diverter and the
  forward probe (same packets, dstnat→forward path), with
  `in:ether1 out:<guest-vlan>` in the log lines. The
  diverter used port 443 so the port-80 REST session
  survived — never divert the port you are driving through.
- Zero-hit honesty (`firewall-apply` rule): the g2o rows
  sat at 0/0 because one box holds no guest client.
  Zero-hit = match-unproven. The drill states this and
  rests isolation on placement + read-back; the client-half
  check (real lease, blocked office ping, drop counter
  increments) is PRESCRIBED for hardware, not claimed here.
- Static-lease read-back (`waiting`/`never`) proves the
  lease-table path, not client service. A dynamic lease
  needs a real L2 client — same honesty rule applies.

### 4. Tag, apply, ledger, clear (production shape + teardown)

```sh
# Teardown (dependency order — reverse of build; each remove verified):
#   nat divert -> filter rows -> lease -> dhcp server -> dhcp network
#   -> pool -> addresses -> vlans, then re-print every menu vs baseline
centrs execute --quickchr <twin> '/ip/firewall/nat/remove [find comment="<tag>-divert"]' --yes
centrs execute --quickchr <twin> '/ip/firewall/filter/remove [find comment~"<tag>"]' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/lease/remove [find comment="<tag>"]' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/remove [find comment="<tag>"]' --yes
centrs execute --quickchr <twin> '/ip/dhcp-server/network/remove [find comment="<tag>"]' --yes
centrs execute --quickchr <twin> '/ip/pool/remove [find comment="<tag>"]' --yes
centrs execute --quickchr <twin> '/ip/address/remove [find comment="<tag>"]' --yes
centrs execute --quickchr <twin> '/interface/vlan/remove [find comment="<tag>"]' --yes
```

- Grounded: 8 removes, each
  `{"ret":""}`; vlan/pool/dhcp/network/lease back to `{}`,
  address back to DHCP-only ether1, filter+nat back to the
  factory placeholder. Pristine proof is the re-print set,
  not the removes returning ok.
- Tag scope covers EVERY owned row (`firewall-apply` rule):
  VLANs, addresses, pool, network, server, leases, filter
  and NAT rows. A rollback that leaves the DHCP server
  behind is half a rollback.
- Ledger per `evidence-ledger`: proposal + twin commands
  with counter/lease numbers + pre/post prints, labeled
  observed (ran it) / collected (source path) / inferred /
  pending (radio half). Production applies run under
  `change-apply` with owner approval (production rule).

## Part 2 — Skill doc

### Trigger

Load when: adding a guest, staff, or IoT VLAN; isolating
wireless clients from office subnets; attaching an SSID to a
VLAN; proving VLAN separation on a twin; rolling back a VLAN
or guest-network change. (Collected from earlier field runs: guest-WiFi setup,
WiFi-logins-to-VLAN, guest-isolation repair, and the guest
operating loop.)

### Prereqs

- centrs on PATH; target reachable (`first-contact` first on
  any box not yet in the device registry).
- The `routeros-firewall` domain skill for forward/drop/log/
  dstnat semantics; `routeros-scripting` for print/find/tag
  idioms. This skill is the procedure wrapper, not the
  reference. No `routeros-wireless` domain skill exists —
  radio behavior is prescribed, never cited as consumed.
- A twin at matching firmware for the build + verify runs;
  a traffic source that reaches the twin (host→guest port
  forward proven here).
- The proposal written (vlans/subnets/dhcp/separate/
  counters/radio/rollback). No proposal = no run on non-twins.

### Access

- Twins: anything goes — but divert an UNUSED port, never
  the one your session drives through; no radio claims ever.
- Production: reads free; ANY write asks the
  developer first — including log-rule probes and DHCP
  rows, not just drops.
- Operator Unknown → ask before any write.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s is ample for VLAN/DHCP/filter ops |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |
| `CENTRS_SSH_KEY` | Batch SSH key path (key-only, never password) |

### Outputs

- Pre-change prints: vlan, address, pool, dhcp-server,
  dhcp-network, lease, filter (both families audited —
  record the v6 posture even for v4-only intent).
- Proposal: vlans/subnets/dhcp/separate/counters/radio/
  rollback with placement.
- Twin evidence: build commands + `.id` returns +
  `invalid=false` + connected route + counter read-backs
  + lease read-back + honest zero-hit statement.
- Final record: applied commands + post-apply prints, or
  rollback record with pristine proof.

### Verification

- DHCP server reads `invalid=false`, `disabled=false`,
  bound to the guest VLAN with its pool; connected routes
  live for every built subnet.
- Re-print shows isolation rows at the proposed positions,
  log shadow above its drop.
- Diverted traffic produces nonzero, agreeing counters on
  the dstnat diverter and the forward probe.
- Lease-table path reads back (static `waiting` at
  minimum); dynamic-lease and blocked-ping checks either
  ran on hardware or stand named as pending.
- Rollback case: tag removes + re-prints match the
  pre-change prints exactly, every menu.

### Recovery

- Server reads `invalid=true` → the pool/network/interface
  triple is incomplete: check which leg is missing before
  re-adding (never duplicate-add blindly).
- Counters stay 0 on the forward probe → the diverter
  missed (port? forward reachability?) — fix on the twin;
  never "it'll hit in production".
- `validation/syntax` on a VLAN/DHCP path → check the
  menu exists on the box before re-quoting
  (`routeros-centrs`: missing menus reject this way).
- Diverter breaks your own session → you diverted your
  driving port: console in via quickchr and tag-remove;
  on production → escalate with proposal + twin evidence.
- Redaction: scrub secrets from stored prints;
  DHCP prints can carry client MACs/hostnames worth
  treating as sensitive off-box.

### Limits

- The twin proves L3 + VLAN + DHCP + firewall only. CHR
  has no radios and no wireless menus: SSID→VLAN datapath,
  WPA-Enterprise/RADIUS per-person VLAN, AP
  roaming, and real-client DHCP/DNS behavior are
  PRESCRIBED for hardware — the first hardware run must
  update this skill with its evidence.
- Guest→office drop matches are placement-verified, never
  traffic-verified here (zero-hit = unproven). Claiming a
  block that never saw a packet is the failure mode; the
  zero-hit statement is the guardrail.
- v6 separation needs its own rows (`/ipv6/firewall` is
  separate — `routeros-firewall`): this drill is v4-only
  and the record must say so.
- One-box drills share one parent interface: bridge-VLAN,
  trunk/tagged-port, and multi-AP shapes follow the same
  procedure but have no executed drill yet.
