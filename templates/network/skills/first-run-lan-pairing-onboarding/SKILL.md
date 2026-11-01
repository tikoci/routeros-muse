---
name: first-run-lan-pairing-onboarding
description: "Pair an agent system to its routers from the LAN: install-secret host bind, MNDP neighbor sweep, WinBox CDB seeding, LAN-only password entry with scope grants. Use when: first run of a router-hosted agent app, adding a router to the fleet, re-pairing after a restart, or asking where router passwords may be typed."
topics: [onboarding, pairing, cdb, lan]
tested: none
---

# `first-run-lan-pairing-onboarding` skill (bind → sweep → seed → grant → hand off) [template v1 draft]

Promoted from the centrs-as-app first-run paragraph (install-time
generated-secret in production since 2026-10-10), the
`discover`/`devices` CLI shapes (observed centrs `0.1.9-next`
this session), the tunnel-research LAN firewall findings, and the
`/app`-on-L009 precedent. Backlog #43. Hands off to #26 (agent
accounts), #14 (transport negotiation), and #41 (upstream
connector door) after pairing — pairing proves the LAN bond, not
the cloud path. No secrets below; passwords and addresses appear
as shapes only.

## Part 1 — The checklist (LAN bond before any cloud door)

Run top to bottom. Pairing is done when the host is bound, every
fleet router is seeded with an explicit grant, and no password
has left the LAN.

1. Bind the host at first run (§0): install-secret auto-add,
   two-listener boundary from first boot.
2. Sweep MNDP neighbors (§1): `centrs discover` offer list —
   offering is not enrolling.
3. Seed the CDB (§2): WinBox import, explicit adds, address-book
   treatment for fleet rows.
4. Type passwords on LAN only + grant scopes (§3): LAN page for
   secrets, firewall + service gates, per-group scopes.
5. Record the pairing + hand off (§4): pairing state, ledger
   entry, handoff to accounts/transport/connector.

### 0. Bind (host first, by install secret)

- First run auto-adds the host router using the install-time
  generated-secret pattern — already in production on the
  applicant's network since 2026-10-10 (collected:
  centrs-as-app-design § Two listeners). The host is an implicit
  target: this slice needs no WinBox CDB at all (collected:
  review-of-reviews §6).
- Restart may deliberately REQUIRE re-pairing. Never silently
  fall back to a saved administrator when the bound account
  fails — fail closed to re-pairing (collected: Astra §3).
- The two-listener boundary holds from first boot: the public
  listener serves ONLY `/mcp` + `/healthz` behind an
  authenticated identity; the LAN listener serves pairing,
  password entry, device mapping, scope grants, the approval
  queue, and the call log. The LAN side is NEVER published
  through any public door (collected: app-design § Two
  listeners).
- The container is proven ground, not the risk: Bun `/app` on
  arm64 L009s since 2026-10-10 (collected: claude-code-feedback
  §1a + grounds table). Spend the risk budget on the pairing +
  approval loop instead. Still verify the SELECTED device (Bun
  ships no 32-bit ARM — the L009 precedent settles only L009s).

### 1. Sweep (MNDP offers, humans enroll)

Observed `centrs discover --help` (0.1.9-next, this session):

```text
Usage: centrs discover [--timeout 15s] [--save] [flags]
  --timeout <ms|15s>   Listen window. Default 15s.
  --save               Persist neighbors into the CDB
                       (group=discovered, source=mndp).
  --group <name>       --save group. Default discovered.
  --port <port>        UDP bind. Default 5678.
  --cdb-file / --cdb-password / --format / --json
```

- MCP shape matches: `centrs_discover` listens for MNDP
  neighbors; `save=true` writes the CDB and requires
  `confirm:true` (observed `src/mcp/tools.ts` discover input
  shape + `requireConfirm`).
- Offering is not enrolling: every discovered neighbor still
  needs an explicit grant (§3) before any agent call touches it.
  A `--save` into `group=discovered` is an address-book entry,
  not an authorization (see #42 §1: CDB group ≠ auth).
- Reachability caveats (collected: Astra §7 + tunnel research):
  a container's loopback is the container — the local router hop
  needs the correct gateway/service address, firewall
  permission, service admission, and trust config. L2 discovery
  and MAC-Telnet work only where routing/L2/RouterOS policy
  allow; local placement enables nothing by magic. Pin ONE
  transport for the first slice.
- Address-shape lesson from the tunnel bring-up (collected, no
  live addresses recorded here): three candidate shapes were
  tried — the `/app` gateway shape (not a real RouterOS
  address), a macvlan-child shape (a host cannot reach its own
  macvlan child from the container side — dial times out), and
  the plain bridge shape, which worked once the firewall let it
  in. Expect the same ladder on a new box; record which shape
  won.

### 2. Seed (CDB import + explicit adds)

- A WinBox CDB import seeds a fleet (collected: app-design § Two
  listeners); RouterOS CMR device mapping SHOULD feed the CDB as
  that integration lands — but CMR mechanics are a parked
  beta3 re-check, not asserted here, and CMR stays
  enrollment-only meanwhile (run-script ignores the controller
  login's policy — journaled 2026-10-13; collected:
  review-of-reviews §6 + #42 §0).
- `devices` is the ONLY command that writes the CDB (observed
  `centrs devices --help`, 0.1.9-next): `init|list|show|groups|
  add|edit|set|remove`, with `--cdb-file` / `--cdb-password`
  overrides, `--group`, `--user` / `--password` for add/set,
  `--match` disambiguation for show, and `--where` / `--near` /
  `--bbox` list filters.
- Fleet CDB rows are an ADDRESS BOOK once mounted: credentials
  come from the bound principal or the service account, never
  from a CDB password picked because the name matched. The
  precedence audit (§3-adjacent, full treatment in #42 §3)
  applies: env and `__default__` must never override a remote
  identity silently (collected: review-of-reviews §6 +
  Astra §4).
- CDB group stays inventory metadata through seeding — group
  names chosen at import time (`discovered`, site names,
  roles) organize; they authorize nothing (collected:
  Astra §4).

### 3. Grant (LAN-only secrets, explicit scopes)

- Passwords are typed into a page served by the router ON THE
  LAN. They never transit the internet or an agent habitat —
  this is the hard boundary, not a preference (collected:
  app-design § Two listeners).
- "LAN only" is reachability, not trust: the LAN UI still needs
  authentication, TLS for password entry, and browser CSRF
  protection (collected: Astra §5).
- Firewall + service gates, learned the hard way (collected:
  tunnel research): the input chain's closing drop-not-from-LAN
  rule silently eats container dials — symptom is a timeout /
  silent origin (Cloudflare 502 in the tunnel case), fixed by an
  accept from the container source to the service port placed
  BEFORE the drop. Diagnostic: a timeout vs a TLS handshake
  distinguishes "firewall ate it" from "service refused it".
  Service gates apply too: `www-ssl` `available-from` ranges
  must include the app-bridge source shape.
- Scope grants per device group (collected: app-design §
  Security model): authenticated identity → scopes (read / plan
  / commit, per device group); writes only via approved plans;
  commits arm the on-router dead-man by default. Devices get
  per-device least-privilege RouterOS users; credentials exist
  only in the app's on-router store.
- RouterOS-login option: presented credentials validated by a
  real local login, that user as principal, scopes from groups,
  revocation by disable/delete with short-lived bearers —
  with the #42 §1 vetting caveats (TOTP unproven,
  `sensitive`-store deferred) attached, not waived.
- Why LAN-first (collected: tunnel research § auth mismatch):
  RouterOS Basic is unrepresentable in the Muse vault
  (single-secret-or-OAuth only), so no cloud door can carry the
  first credential — LAN pairing precedes every remote door by
  construction.

### 4. Record (pairing state → ledger → handoff)

- The app keeps pairing state, device mapping, scope grants, and
  the call log visible in the LAN UI and the container log:
  every call logged with identity, target, plan, outcome
  (collected: app-design § Security model). Custody gradient to
  preserve across doors: NO door holds a router credential
  outside the on-router store (collected: app-design).
- Ledger entry per pairing (evidence-ledger): date + box +
  method (install-secret / MNDP / import), grants by SHAPE
  (never secrets), firewall/service rules added with their
  before/after read-backs, pending list.
- Handoff, in order: #26 bootstraps the agent accounts (local
  reader/admin/break-glass — agents never ride RADIUS); #14
  negotiates the transport; #41 verifies the upstream connector
  door with harmless live reads. Pairing hands OFF to these —
  it never substitutes for them.
- Pending stays explicit: CMR mapping (beta3 re-check), the app
  as its own OAuth authorization server (grown-up door form;
  token floor first), federation (one call, many apps —
  deferred, CDB fan-out covers the lab case).

## Part 2 — Skill doc

### Trigger

Load when: first run of a router-hosted agent app; adding a
router to the fleet; re-pairing after a restart or credential
change; "where may router passwords be typed" questions; a new
box needs its LAN bond before any cloud door. (Entry-skill +
capability-probe pattern: K22.)

### Prereqs

- The app container running on the host router (or the CHR
  standing in for it) with the LAN listener reachable.
- centrs on PATH at a known version (`discover`/`devices`
  shapes here observed at 0.1.9-next).
- Someone on the LAN able to type passwords into the LAN page
  at pairing time (no remote password relay, ever).
- Twin or disposable box for the first untested-shape run —
  never a first pairing proof on a load-bearing router.

### Access

- Reads-first: MNDP sweep + CDB list/show reads before any
  save/add; firewall/service read-backs before rule changes.
- Local/LAN writes free on lab boxes; production router writes
  (firewall accepts, service gates) ask the developer first
  per item (bigdude rule carries over).
- Passwords travel LAN-page-only: never into chat, notes,
  coord, env dumps, or staged scripts.
- Never delete twin1/twin2; dirty pairing experiments get a
  fresh twin.

### Envs

| Name | Use |
|---|---|
| `CENTRS_CDB_FILE` | CDB path for `--save` / `devices` writes (default under `~/.config/tikoci/`) |
| `CENTRS_CDB_PASSWORD` | Decrypt/re-encrypt password for an encrypted CDB |
| `CENTRS_*` | Transport auth for verification reads (first-contact) — never the pairing secret's carrier |

No install secrets, router passwords, or CDB passwords persist
in env. Pairing secrets live in the on-router store from the
moment they exist.

### Outputs

- Bound host (method + date + store location by shape).
- MNDP offer list with per-neighbor enroll/defer verdicts.
- Seeded CDB: records + groups + the address-book caveat noted.
- Scope grants per device group + firewall/service read-backs.
- Pending list: CMR, OAuth-AS, federation, cloud-door verify.

### Verification

- Host bound via install secret OR explicitly re-paired after
  restart — no silent saved-admin fallback anywhere in the
  path (tested by restarting and watching it fail closed).
- Every fleet router has BOTH a CDB row AND an explicit grant;
  rows without grants get no agent calls (spot-check one).
- Password audit: no router password in chat, notes, ledger,
  coord, env, or staged text — grep the session's trail.
- Firewall/service read-backs show the pairing rules in place
  with the drop-not-from-LAN still closing the chain.
- Claim audit: each pairing claim carries command + output or
  an honest collected/pending label.

### Recovery

- Pairing fails after restart → re-pair deliberately (expected
  path, not an error); if a saved credential silently worked
  instead, that is the bug — file it.
- MNDP sees nothing → check L2 placement + bridge shape (§1
  ladder) before assuming the box is down; confirm the UDP
  bind + listen window first.
- Timeout vs refusal → run the §3 diagnostic (timeout =
  firewall-ate-it suspect; TLS handshake = service refused) and
  read back the input chain order.
- Secret left the LAN → delete every copy, rotate if live,
  record as an anomaly (evidence-ledger recovery precedent).

### Limits

- The install-secret pattern is collected (production since
  2026-10-10 per the design note), not re-run in this session
  — the first live pairing is still pending.
- CLI shapes are help-verified (0.1.9-next `--help` observed),
  not run-verified: no live `discover --save` or `devices add`
  against a twin is recorded in this skill yet.
- CMR device mapping is a parked verification item — quoted
  as seam, never as working.
- This skill proves the LAN bond only. Cloud reachability,
  vault behavior, and connector verification belong to #41 —
  pairing success implies none of them.
- The app-as-OAuth-authorization-server is design, not code —
  the token floor is the only minting path until it exists.
