---
name: vpn-setup
description: "Tunnel bring-up with read-back proofs: pick the transport from the measured matrix, twin-proof WireGuard or a relay tunnel, verify handshake and counters, tear down clean. Use when: connecting an agent or owner to a router across networks, choosing between VPN/BTH/Cloudflare paths, or proving a tunnel before production."
topics: [vpn, tunnel]
requires: [twin]
tested: none
---

# `vpn-setup` skill (pick → twin-proof → verify → record) [template v1 draft]

Promoted from a twin WireGuard handshake proof,
the T3 tunnel mechanics research, a cloud-sandbox
egress matrix (shared tunnel thread), and the connectivity design
notes' measured rejection table. No secrets below; key
material is shape-only (keys died with the twin).

## Part 1 — The checklist (egress picks the transport)

Run top to bottom. Never start from preference ("we use WireGuard"):
start from where the far side lives, because the far side's egress
decides what can possibly work.

1. Pick the transport from the measured matrix (§0): far-side egress
   first, then CPU budget, then who operates the relay.
2. Twin-proof the bring-up (§1–§2): build the config on a disposable
   twin, read back every object, prove the handshake or the HTTP
   round-trip — config present is not transport proven.
3. Apply to production behind approval (§3): proposal + deadman, apply,
   re-run the same read-back proofs against the real box.
4. Record the run in the evidence ledger (§4): commands + outputs +
   environment, claim labels, anomalies. Unrun halves stay pending.

### 0. Pick (measured matrix, not preference)

Far-side egress kills transports before RouterOS ever sees them.
Measured 2026-10-24/28 from a cloud-sandbox agent (full
recon note; corpus brief §hard-blocks):

| Transport | From that sandbox | Reason (measured, not lore) |
|---|---|---|
| WireGuard / IPsec / L2TP / SSTP / OpenVPN-TCP | dead | UDP `sendto` → EPERM (seccomp); direct TCP policy-denied (`other_tcp`) with a plaintext banner, not a network fault |
| ZeroTier (incl. TCP/443 fallback) | dead | Fallback never activated in tests [JOURNALED]; MikroTik side lacks it too |
| cloudflared quick + `--protocol http2` | dead | Binary ignores the HTTP CONNECT proxy; direct call hits the banner → `tls: first record does not look like a TLS handshake` |
| MikroTik `routingthecloud.net` relay | refused | Connection closed before any HTTP response (works fine from residential nets) |
| Plain HTTPS/WSS via egress proxy | WORKS | `relay.t3.codes/health` ok, `app.t3.codes` 200, WSS 101 upgrade |
| T3 Connect MCP over that HTTPS | PROVEN | OAuth token exchange 200, 66 tools, hello-world thread completed |

And proven live on a Linux build host the same week:
T3 Connect reachable, 4 QUIC connections, HTTPS in / QUIC out,
nothing listening inbound, cloudflared a pure data-plane transport
(~42 MB RSS) with auth done by the CLI's device flow.

Decision rules that fall out:

- Agent on an open network (LAN, workstation, build host) → WireGuard or ZeroTier
  inside the estate; BTH Files for human/agent file exchange.
- Agent behind a hostile proxy (cloud sandbox) → the agent side must
  be plain HTTPS/WSS: Cloudflare tunnel with cloudflared on the FAR
  side dialing out, or a mailbox rung. Nothing that needs local UDP,
  TUN, or direct TCP survives — `/dev/net/tun` existing does not help.
- Weak CPUs: QUIC buys little there; WireGuard (kernel, ChaCha20) is
  the efficient pick over a tunnel binary.
- BTH VPN is fine for the owner's phone; it is not an agent API path
  (UDP underneath, app-centric).

### 1. Twin-proof WireGuard (handshake or it didn't happen)

Proven 2026-10-29 on a fresh CHR 7.26beta3 twin, driven by centrs
0.1.9-next `--quickchr`. Key fields redacted to
shape throughout.

```sh
centrs explain '/interface/wireguard/add name=wg-test listen-port=13231'
# verdict: pass · write-shaped · runtimeAcceptance: not-proven (offline only)

centrs execute --quickchr <twin> --yes \
  '/interface/wireguard/add name=wg-test listen-port=13231' --json
# ok:true {"ret":"*3"} — interface exists, keypair auto-generated

centrs retrieve --quickchr <twin> /interface/wireguard --json
# *3 wg-test listen-port=13231 mtu=1420 running=false
# public-key <44ch base64, auto-generated>, private-key <present>
```

Add the peer with a REAL harvested key (second interface on the same
twin is the cheapest real key; never invent key material):

```sh
centrs execute --quickchr <twin> --yes \
  '/interface/wireguard/add name=wg-b listen-port=13232' --json
# harvest wg-b's public-key from a retrieve (44 chars — assert the length)
centrs execute --quickchr <twin> --yes '/interface/wireguard/peers/add \
  interface=wg-test public-key="<wg-b key>" allowed-address=10.99.99.2/32 \
  endpoint-address=<guest-ether1> endpoint-port=13232' --json
# ok:true {"ret":"*1"} — peer row exists, rx=0 tx=0 (config, not transport)
```

Reciprocal peer + keepalive, wait, then the proof read:

```sh
centrs execute --quickchr <twin> --yes '/interface/wireguard/peers/add \
  interface=wg-b public-key="<wg-test key>" allowed-address=10.99.99.1/32 \
  endpoint-address=<guest-ether1> endpoint-port=13231 \
  persistent-keepalive=10s' --json
centrs execute --quickchr <twin> --yes '/interface/wireguard/peers/set \
  numbers=peer1 endpoint-address=<guest-ether1> persistent-keepalive=10s' --json
sleep 15
centrs retrieve --quickchr <twin> /interface/wireguard/peers --json
# peer1 rx=212 tx=156 last-handshake=20s   (MIRRORED on peer2: rx=156 tx=212)
```

The verdict fields are `last-handshake` fresh + rx/tx mirrored both
directions. No interface addresses were assigned — the handshake needs
only reciprocal peers + reachable endpoints. `running=false` before
the first peer is normal, not an error.

Teardown is part of the proof (peers first, then interfaces):

```sh
centrs execute --quickchr <twin> --yes \
  '/interface/wireguard/peers/remove numbers=peer1,peer2' --json
centrs execute --quickchr <twin> --yes \
  '/interface/wireguard/remove numbers=wg-test,wg-b' --json
centrs retrieve --quickchr <twin> /interface/wireguard --json
# objectCount 0 — clean
```

### 2. Relay rungs (collected shapes, round-trips pending)

Three shapes, none with an executed round-trip yet. Quoted so the
first runner has the exact starting point; each names what "proven"
requires.

- **BTH Files (LAN-side + human exchange).** `/ip/cloud/file-share`
  (7.18+; design notes say `/ip/cloud/back-to-home-file`) sharing a
  directory, reachable at `https://<id>.routingthecloud.net/s/<key>`.
  HTTP scheme from forum topic #181789: `GET ?list` → JSON,
  `GET <path>?dl` downloads, `POST` multipart field `file` WITH
  trailing slash uploads, no DELETE (append-only). Zero new
  accounts/infra. Proven requires: share → upload → list → download
  round-trip from the environment that will use it. The cloud-sandbox
  environment can never be that environment (relay refuses it — §0).
- **Cloudflare tunnel (cloud-agent interactive rung).** cloudflared
  runs on the FAR side (router container) dialing outbound-only; the
  agent side is a plain HTTPS hostname. This is the deployed shape on
  one production router: its export showed a cloudflared container with a
  tunnel token in inline `env=` (redaction incident —
  token since rotated out of captures). Proven requires: quick-tunnel
  round-trip from the consuming environment (still open).
- **BTH VPN enable (owner path).** `centrs explain
  '/ip/cloud/set back-to-home-vpn=only-ipv4'` passes offline
  (runtimeAcceptance not-proven). The BTH users submenu is NOT
  enumerable on a fresh CHR with BTH off (`validation/unknown-path`,
  `availableChildren: []`). Enabling phones home
  to the MikroTik relay: do it deliberately, never as a side effect
  of a twin run (twin-ops sanitization rule).

### 3. Production apply (proposal + deadman, same proofs)

- Tunnel changes are writes: twin-proof first (change-apply), then a
  proposal the approver can read — transport, endpoints, keys-by-shape
  (never key material in chat), rollback = the §1 remove path.
- VPN misconfiguration locks you out remotely: the deadman is
  load-bearing here, not optional. change-apply's staged-script +
  timed-revert pattern applies verbatim.
- After apply, re-run the §1 read-back proofs against the real box:
  same `retrieve` calls, same verdict fields. A production bring-up
  without `last-handshake` (or the HTTP 200 for a relay rung) is an
  unproven bring-up.
- Production rule: reads free, ANY write asks the developer first — per
  item, no blanket approval.

### 4. Record (ledger entry, not vibes)

- Every tunnel run lands in the evidence ledger (evidence-ledger):
  date + environment + machine, each command with its output, claim
  labels (observed / collected / pending), anomalies.
- Key material never enters the ledger: public keys by length + first
  run's existence, private keys and tokens never. centrs redacts what
  it holds, not what RouterOS returns (centrs#359) — strip
  `private-key` before pasting any retrieve output.
- The un-run halves (§2) stay listed as pending in the run note until
  somebody runs them. Promotion never silently drops them.

## Part 2 — Skill doc

### Trigger

Load when: connecting an agent or owner to a router across networks;
choosing between VPN / BTH / Cloudflare / mailbox transports; proving
a tunnel before production traffic; "can X reach Y" questions where X
sits behind an unknown egress. (Entry-skill + capability-probe
pattern.)

### Prereqs

- The far side's egress described honestly: UDP out? direct TCP?
  HTTP proxy only? §0's matrix answers it for the cloud-sandbox
  environment; any new environment re-probes before picking.
- centrs + quickchr on PATH for twin-proofing (twin-ops for the twin
  discipline); approval + deadman for production writes.
- The question written down: who connects to what, from where, for
  which traffic. No question = no tunnel.

### Access

- Twin runs: disposable boxes, anything goes, teardown after.
- Production: the approver named on the proposal; production writes need
  the developer per item. Key material stays out of chat/shared drafts/notes.
- BTH/Cloudflare enables touch third-party relays (MikroTik,
  Cloudflare): deliberate decision each time, recorded in the ledger.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Raise for slow-twin reads during bring-up |
| `QUICKCHR_SHUTDOWN_TIMEOUT` | Overrides default 10s twin shutdown wait |

### Outputs

- Transport choice with the matrix row that forced it.
- Twin-proof record: config commands + read-backs + handshake (or
  HTTP) verdict fields.
- Production proposal: transport, endpoints, keys-by-shape, rollback.
- Ledger entry: dated commands + outputs + environment + claim labels.

### Verification

- WireGuard: `last-handshake` fresh AND rx/tx mirrored on both peers.
  Config rows without those fields are unproven.
- Relay rung: HTTP round-trip (list/upload/download or tunnel 200)
  executed from the consuming environment, not merely configured.
- Post-run: twin removed or stopped-at-prior-state; production
  re-verified with the same reads as the twin.
- Ledger: every claim carries command + output or is labeled pending.

### Recovery

- No handshake (rx/tx stuck at 0): check endpoints reachable (guest
  ether1 address, not the NAT gateway), keys correspond
  (44-char pubkey on the right peer), keepalive set on at least one
  side to start the conversation.
- `validation/unknown-path` on a VPN submenu: menu may not exist
  until the feature is enabled (BTH users on fresh CHR) — check
  feature state before re-quoting (centrs#361).
- Relay rung dead from one environment: re-check §0 before debugging the
  router — sandbox egress vs residential network is the usual split.
- Locked out after a production apply: deadman reverts; if none was
  set, that is the incident to write up first (incident-response).

### Limits

- CHR proof only (7.26beta3, single-box handshake): no cross-host
  traffic, no throughput numbers (free-license 1 Mbps cap), no radio
  truth. Hardware proof needs hardware.
- §2 is collected, not proven: BTH Files round-trip, quick-tunnel
  round-trip, and BTH enable are all still pending first runs.
- ZeroTier bring-up un-run (package present on one production router,
  the build host on a ZeroTier net — presence, not proof).
- Matrix rows are dated per environment (cloud sandbox 2026-10-28, build
  host 2026-10-28/29): egress policies change; re-probe when the environment
  changes, never cite the matrix as timeless.
