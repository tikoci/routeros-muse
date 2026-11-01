---
name: hotspot-ops
description: "Run a captive portal safely: build on an isolated interface, verify live state, tag walled-garden rows, tear down in dependency order. Use when: setting up or changing a hotspot, debugging portal login, walled-garden work, hotspot + firewall interaction questions, or DHCP/pool wiring for guest access."
topics: [hotspot]
requires: [twin]
tested: none
---

# `hotspot-ops` skill (isolate → build → verify live → tag → tear down) [template v1 draft]

Promoted from the executed hotspot-on-VLAN drill
(t28-hsmon-proof.md, twin1/7.26beta3): VLAN + address + pool
+ profile + instance built on an isolated VLAN, live state
verified (`proxy-status: running`, 28 auto NAT rules),
walled-garden tag row added, full teardown to pristine with
auto-rules gone. Consumes the `routeros-hotspot` DOMAIN skill
(chain semantics, option 114, templates, RADIUS) and adds OUR
procedure. The CLIENT FLOW (DHCP → intercept → login → auth)
is PRESCRIBED, not executed — no L2 client exists on the
CHR lab VLAN; router-local fetch 404s (documented below).
Build-tracker references (T/K IDs, notes paths) are pointers
pending staging scrub. No secrets below.

## Part 1 — The checklist (never intercept the management path)

Run top to bottom. No hotspot instance is enabled on a
non-twin box before step 3 passes on a twin AND the client
flow (step 5) has a proof plan with a real client.

1. Isolate the interface: hotspot binds a dedicated
   interface/VLAN — never the management uplink. No L2
   path, no drill; build the VLAN first (step 0).
2. Build in dependency order: interface → address → pool →
   profile → instance. Each layer prints before the next
   (step 1).
3. Verify live state: `proxy-status: running`, DNS name
   resolved, auto NAT rules present, default templates on
   disk. A silent instance is an unproven instance (step 2).
4. Tag the support rows: walled-garden entries, pool, and
   address rows carry the change tag; teardown removes by
   tag in reverse order (steps 3–4).
5. Prove the client flow with a real client (prescribed):
   DHCP lease → HTTP intercept → login → auth →
   walled-garden reachability. No client, no completion.

### 0. Isolate first (the rule the domain skill implies)

- Hotspot intercept runs BEFORE firewall chains
  (routeros-hotspot): binding a hotspot to the management
  interface intercepts the agent's own HTTP path. The drill
  used `vlan99` on `ether1` with `10.99.9.1/24` — the
  uplink stayed clean throughout (t28-hsmon-proof.md).
- Build the L2 isolation, then address it, then bind the
  hotspot to it. Order: `/interface/vlan/add` →
  `/ip/address/add` → pool → profile → instance. Each
  step returns an ID and re-prints before the next begins.
- IPv4-only: the hotspot subsystem does not serve IPv6
  clients (domain skill). The procedure covers v4; v6 on
  the guest segment is a separate design decision, stated
  in the proposal, never assumed blocked.

### 1. Build in dependency order (writes — twin first)

```sh
centrs execute --quickchr <twin> '/interface/vlan/add name=vlan99 vlan-id=99 interface=ether1 comment="t28-hs"' --yes
# -> {"ret": "*3"}
centrs execute --quickchr <twin> '/ip/address/add address=10.99.9.1/24 interface=vlan99 comment="t28-hs"' --yes
# -> {"ret": "*2"}
centrs execute --quickchr <twin> '/ip/pool/add name=t28-hs-pool ranges=10.99.9.10-10.99.9.20 comment="t28-hs"' --yes
# -> {"ret": "*1"}
centrs execute --quickchr <twin> '/ip/hotspot/profile/add name=t28-hs-prof hotspot-address=10.99.9.1 login-by=http-pap dns-name=hs.t28.test' --yes
# -> {"ret": "*1"}
centrs execute --quickchr <twin> '/ip/hotspot/add name=t28-hs interface=vlan99 profile=t28-hs-prof address-pool=t28-hs-pool idle-timeout=5m disabled=no' --yes
# -> {"ret": "*1"}
```

- Grounded verbatim (t28-hsmon-proof.md): all five layers
  built on twin1, every ID returned, instance enabled.
- Minimal profile first: `hotspot-address` + one
  `login-by` method + `dns-name`. HTTPS login, RADIUS,
  and html overrides are follow-on changes with their own
  proofs (domain skill patterns), not day-one flags.
- DHCP server wiring (pool → server → interface, option
  114 with `force=yes` per the domain skill) is part of
  the client flow (step 5, prescribed): the drill proves
  the hotspot layers, the DHCP half needs the L2 client
  to be meaningful. Don't half-verify DHCP without one.

### 2. Verify live state (reads — the proof step)

```sh
centrs execute --quickchr <twin> '/ip/hotspot/print'
# -> {"name":"t28-hs",...,"ip-of-dns-name":"10.99.9.1","proxy-status":"running","invalid":"false","disabled":"false"}
centrs execute --quickchr <twin> '/ip/firewall/nat/print' | grep -c hotspot-ish
# -> 28 auto-injected hs NAT lines while the instance lives
centrs execute --quickchr <twin> '/file/print' | grep -i hotspot
# -> hotspot/ dir + rlogin.html + img/ : default templates ship on CHR
```

- Grounded (t28-hsmon-proof.md): `proxy-status: running`
  with `invalid: false`; `ip-of-dns-name` resolved to the
  hotspot address; 28 auto NAT rules present; default
  `hotspot/` templates on disk with `$(...)` substitution
  vars visible inline — no override needed for a basic portal.
- Never touch the auto-injected `hs-*` rules (domain
  skill): they are hotspot-managed. Their presence is a
  READ signal (instance alive); their absence after
  teardown is the cleanup proof (step 4).
- Router-local fetch does NOT prove the portal:
  `/tool/fetch url="http://10.99.9.1/login"` from the
  router 404s — intercept applies to traffic ENTERING the
  interface, not router-originated (t28-hsmon-proof.md).
  (Side finding: `/tool/fetch` is write-gated, needs `--yes`.)

### 3. Walled garden with tags (writes — idempotent rows)

```sh
centrs execute --quickchr <twin> '/ip/hotspot/walled-garden/ip/add dst-host=example.com action=accept comment="t28-hs"' --yes
# -> {"ret": "*1"}
# rollback: /ip/hotspot/walled-garden/ip/remove [find comment="<tag>"]
```

- Grounded (t28-hsmon-proof.md): add + tagged remove both ran.
- HTTPS destinations go in `walled-garden/ip` (layer-3,
  pre-auth); the L7 `walled-garden` match is HTTP-only
  and silently misses HTTPS (domain skill). Wrong list =
  silently unreachable auth host = "login page loads but
  auth hangs". State which list and why in the proposal.
- External-auth portals must garden the auth host AND its
  asset/CDN hosts, or the unauthenticated browser can't
  fetch the redirect page (domain skill). List every host
  in the proposal; verify each resolves from the guest
  segment during the client proof (step 5).

### 4. Tear down in dependency order (writes — reverse of build)

```sh
# instance -> profile -> walled-garden rows -> pool -> address -> VLAN
'/ip/hotspot/remove [find name=<tag>-hs]'
'/ip/hotspot/profile/remove [find name=<tag>-hs-prof]'
'/ip/hotspot/walled-garden/ip/remove [find comment="<tag>"]'
'/ip/pool/remove [find name=<tag>-hs-pool]'
'/ip/address/remove [find comment="<tag>"]'
'/interface/vlan/remove [find comment="<tag>"]'
# verify: hotspot/vlan/pool print {} ; profile back to factory default ;
#         nat shows only the disabled unused-hs-chain placeholder
```

- Grounded verbatim (t28-hsmon-proof.md): all six removes
  ran; hotspot/vlan/pool back to `{}`; profile back to the
  single factory `default`; all 28 drill auto-NAT rules
  gone with the instance — the only remaining hs match is
  the pre-existing disabled `unused-hs-chain` placeholder
  ("place hotspot rules here"), which is factory, not dirt.
- Order matters: the instance holds refs to profile/pool/
  interface. Forward-order teardown (VLAN first) fails on
  refs-in-use; reverse-order always unwinds. Record the
  order in the runbook, not just the commands.

### 5. Client flow (PRESCRIBED — needs a real L2 client)

- The unexecuted half, honestly marked: DHCP lease on the
  guest segment → HTTP request intercepted to the login
  page → credential/RADIUS/MAC auth → bonded session →
  walled-garden hosts reachable pre-auth, general traffic
  post-auth. Each arrow needs a dated observation before
  the portal is production.
- First-client effects to expect (domain skill): `api.json`
  appears only after the first CAPPORT probe; move it to
  the override dir then. `$(...)` template vars render
  server-side — view-source on the client shows VALUES,
  which is how template bugs get diagnosed.
- RADIUS mode bypasses local `/ip/hotspot/user` entries
  entirely (domain skill): a portal that "ignores new
  users" is usually `use-radius=yes` with a dead server,
  not a user-db problem. Check the mode before the rows.

## Part 2 — Skill doc

### Trigger

Load when: setting up or changing a hotspot; debugging
portal login or intercept; walled-garden work; hotspot +
firewall interaction questions; DHCP/pool wiring for guest
access; any "guests can't reach X" report on a hotspot segment.

### Prereqs

- centrs on PATH; target reachable (`first-contact` first
  on any box not yet in the device registry).
- The `routeros-hotspot` domain skill for chain semantics,
  option 114, templates, RADIUS (this skill is procedure).
- A twin at matching firmware for build/teardown proofs;
  a REAL L2 client for the client flow (step 5).
- The proposal: interface, address plan, pool, profile
  options, garden hosts, auth mode. No proposal = no run
  on non-twins.

### Access

- Twins: anything goes — but keep the drill on an
  isolated VLAN even on twins; intercepting the
  management path slows the lab for everyone.
- bigdude (production): reads free; ANY write asks the
  developer first — including walled-garden rows.
- Operator Unknown → ask before any write (concepts K14).

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s is ample; `/tool/fetch` probes want 30s |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |

### Outputs

- Proposal: interface/address/pool/profile/garden/auth + v6 posture.
- Twin evidence: build IDs, live-state reads, teardown
  prints, auto-rule gone proof.
- Client-flow record (prescribed until run): per-arrow
  dated observations with a real client.
- Final record: applied commands + post-apply prints, or
  rollback record with pristine proof.

### Verification

- `proxy-status: running`, `invalid: false`, DNS name resolved.
- Auto NAT rules present while live, gone after teardown
  (modulo the factory placeholder).
- Default templates present (or override dir verified
  file-by-file when customized).
- Teardown prints: hotspot/vlan/pool `{}`, profile
  factory-only. Client flow: each arrow dated (when run).

### Recovery

- Instance `invalid: true` → profile/address/pool ref
  broken: re-print each layer, fix the ref, don't
  re-add blind (dupes accumulate).
- Portal loads but auth hangs → garden list wrong
  (HTTP list for an HTTPS host?) or RADIUS dead while
  `use-radius=yes`. Check mode, then rows, then server.
- Login loop / never bonded → `addresses-per-mac`
  exhaustion or DHCP pool empty: read
  `/ip/hotspot/active/print` + lease table.
- Intercepted management traffic → hotspot bound to
  the wrong interface: disable the instance FIRST
  (`set disabled=yes`), then re-plan. Never debug
  intercept live on the management path.
- Redaction: scrub secrets from stored prints per C1.

### Limits

- Client flow is PRESCRIBED until a real L2 client runs
  it — the first client proof updates this skill.
- DHCP server + option 114 wiring is prescribed with
  the client flow (domain patterns, unexecuted here).
- HTTPS login, RADIUS, and template overrides are
  follow-on proofs, not covered by the basic drill.
- CHR proves build/teardown/live-state only; wireless
  hotspot segments need radio hardware for client proofs.
