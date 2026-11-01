---
name: first-contact
description: "First contact with a RouterOS box: probe, select transport, authenticate, persist to CDB, escalate. Use when: contacting a box not yet in the device registry, any transport/auth/timeout failure, or before first SSH on a new box."
topics: [contact, transport]
tested: none
---

# `first-contact` skill (probe → select → CDB → escalate) [template v1 draft]

Promoted from the evidence-critic-verified negotiation recipe (all claims
supported against live sources). Vendored for review with template v1.
Build-tracker references (T/C/K IDs, notes paths, coord UIDs) are pointers
pending staging scrub. Sources cited inline as `path:line`. No secrets
below; addresses/MACs from captures are redacted to roles.

## Part 1 — The checklist (probe-select-CDB-escalate)

Run top to bottom. Stop at the first transport that yields an authenticated
read. Never SSH-first blind (specimen: coord UID 517 — agent burned turns on
`execute --via ssh` before probing what the box offers).

### 0. Load credentials (CDB-first, env fallback)

1. `centrs devices show <handle>` — if a record exists, use it (zero flags).
2. Else check env: `CENTRS_USERNAME` / `CENTRS_PASSWORD` (CLI.md:46-47), and
   the temporary handoff mapping `ROUTEROS_USER`/`ROUTEROS_PASSWORD` →
   `CENTRS_*` (orca-setup.md:47-51; T9 replaces this).
3. If neither exists: skip to step 5 (escalate) AFTER completing the
   no-cred probe (step 1) — reachability + latency are still reportable
   without creds (check/README.md:48-56).

### 1. Probe (no creds needed)

- TCP ports per box: 22 (ssh), 80/443 (REST), 8291 (winbox), 8728/8729
  (native API plain/TLS — target.ts:10-11), UDP 20561 (mac-telnet —
  mac-telnet.ts:11,39), UDP 5678 (MNDP — CLI.md:307).
- Cheap liveness reads (do NOT authenticate yet):
  - `centrs discover --timeout 15s` for L2 neighbors (CLI.md:299-311).
    Caveat: host firewall can eat L2; pierce was MNDP-invisible while alive
    (coord UID 517). Absence proves nothing.
  - REST alive test: any `/rest/*` answering 401 = RouterOS v7 REST alive,
    auth-gated (coord UID 517). But 443-accept-then-reset is NOT REST
    (possibly SSTP — orca-setup.md:44-45); verify with a real REST call.
  - ARP presence = L2-adjacency fact (check/README.md:48-50). Required
    before even considering mac-telnet.
- Record: open ports, REST-401 yes/no, ARP yes/no, MNDP seen yes/no.

### 2. Select (probe-then-pick — centrs auto-select does NOT fail over)

- C7: refused 8728 ends the attempt; SSH/REST are never tried
  (needs.toml:70-79; coord UID 518 dogfood #1). You must pick explicitly.
- Per-operation preferences (CONSTITUTION.md:450-460):
  - `retrieve`: rest-api first, native-api second (`--follow`: native only,
    no downgrade). Pin with `--via` (CLI.md:35).
  - `execute`: auto picks native-api unless target is an `http(s)://` URL
    (then rest-api) or a bare unresolved MAC (then mac-telnet)
    (execute/README.md:146-160). Pin with
    `--via <native-api|rest-api|mac-telnet>` (CLI.md:81). NOTE: CLI.md's
    execute `--via` value list omits `ssh` but ssh is a CHR-passed execute
    cell (MATRIX.md:37) and `--ssh-key`/`--insecure` document `--via ssh`
    (CLI.md:96-97) — `ssh` works despite the value-list gap.
  - `transfer`: methods are `rest`/`native`/`sftp` — NOT the execute names.
    C10: record `via=ssh` is ignored; pin `--via sftp` explicitly
    (needs.toml:103-112; CLI.md:165). Auto: downloads + ≤60 KB uploads via
    rest/native; >60 KB uploads via sftp (transfer/README.md:102-112).
    A pinned `--via` never silently downgrades (transfer/README.md:114-117).
  - `terminal`: ssh default; mac-telnet for MAC targets (CLI.md:205).
- Decision order for first contact: REST (401→alive) → native-api 8728 →
  ssh 22 (only if a key exists — batch SSH is key-only, step 3) →
  mac-telnet (only with proven L2 adjacency AND mac-server enabled).
- `--via` + quickchr: v1 forwards rest-api/native-api/ssh only; anything
  else is typed `quickchr/unsupported-via`, never silent fallback
  (quickchr-provider.ts:460-476). Prefer `--quickchr <name>` for twins —
  no creds needed (orca-setup.md:110-111).

### 3. Authenticate (transport-specific rules)

- Batch SSH (execute/transfer-sftp) runs `BatchMode=yes` and NEVER sends a
  password — key auth only (ssh.ts:39-46,99-112; CONSTITUTION.md:512-517).
  Missing key fails fast; it never prompts. Remediation names the key
  source used (ssh.ts:107-112).
- RouterOS ≥7.21 default `/ip/ssh password-authentication=yes-if-no-key`
  refuses password login once the user HAS a key (ssh.ts:111;
  terminal/README.md:124). Installing a key disables password SSH for that
  user — owner-accepted side effect on bigdude (orca-setup.md:195-202).
- SSH user needs `ssh` policy; SFTP file access needs `ftp` policy
  (ssh.ts:103-105; terminal/README.md:128).
- mac-telnet: MTWEI required; stock RouterOS offers 16-byte MD5 salt but
  REJECTS the MD5 proof (mac-telnet.ts:15-21; execute/README.md:513-516).
  `END_AUTH` ≠ success — success only when terminal output arrives.
  ~10s login stall is normal (terminal/README.md:179-183); do NOT confuse
  with the C2 30s login timeout on 7.26beta3 (needs.toml:15-24;
  tikoci-issues.md:10-16) — that one is a device/firmware failure, escalate.
- REST/native take username+password (env or CDB). TLS/REST verify by
  default; self-signed RouterOS certs fail `transport/tls-certificate`
  naming `--insecure` (CONSTITUTION.md:502-505). SSH host keys are
  trust-on-first-use by default (CONSTITUTION.md:506-510).
- Prove auth with a read, not a write: `retrieve --host <h>
  /system/identity --via native-api --format json` →
  `{"ok": true, ...}` (orca-setup.md:52-54).

### 4. Persist (CDB write on first success)

- `devices` is the ONLY command that writes the CDB (CLI.md:19,258).
- On first authenticated success: `centrs devices add <handle>` (+
  `--user/--password` or key path), per-device `via=`/`port=`/`ssh-key=`
  overrides as comment-kv (devices/README.md:107-122). Precedence:
  defaults → centrs.env → comment-kv → env → CLI flag; `meta.settings`
  reports winner+source (devices/README.md:146-148).
- C9 caveat: `devices set <t> key=` SHOULD remove the token per docs
  (devices/README.md:141-143) but currently stores an empty value
  (needs.toml:92-101; coord UID 518 dogfood #3). Workaround: remove/add
  the record instead of empty-token removal.
- NEVER improvise a CDB with secrets outside the designed handoff
  (orca-setup.md:141-143); ssh-key stores a PATH only, never key material
  (devices/README.md:133-137).

### 5. Escalate (terminal states — reach them fast, not after flailing)

Escalate to the developer/owner when ANY holds (correct terminal states
from UID 517: every open door needs a password nobody has, every key door
needs SSH enabled):

1. No creds anywhere (CDB empty, env empty) AND REST-401/auth-gated on all
   open management ports. Ask: one password (agent self-serves from there:
   import ssh key + enable ssh over REST, then never needs it again —
   coord UID 518 pierce path), OR human enables `/ip service ssh` via
   winbox.
2. SSH down + REST down + only winbox/L2 visible. Human-hands only.
3. mac-telnet 30s login timeout with mac-server=all + proven L2 (C2).
4. Any write-shaped bootstrap on a NON-twin box (key install, service
   enable): owner go-ahead required (bigdude rule; orca-setup.md:186-203
   D1–D4 were owner-approved).
5. Timeout kill suspected: default execute timeout is 10s
   (`CENTRS_TIMEOUT`, execute.ts:1322-1326); a 12s run dies mid-payload
   silently — retry `--timeout 30s` before escalating (C11;
   needs.toml:114-123; enbeep-bigdude.md:152-154). REST caps at 60s
   (CONSTITUTION.md:489-491).
6. Transfer 0-byte first attempt: retry with `--force` (C8;
   needs.toml:81-90; coord UID 518).
7. REST permission denial (HTTP 500/9) reads retryable/outcome-unknown —
   NEVER treat as success (C6; needs.toml:59-68).

Escalation packet: probe table (step 1) + selected via + exact command +
  error code + what was already tried. Claim = command + output.

## Part 2 — Skill doc

### Trigger

Load when: contacting a RouterOS box not yet in the CDB; any
`transport/*`, `auth/*`, or timeout failure; before first `execute --via
ssh` on a new box; enbeep TX path setup. (Entry-skill + capability-probe
pattern: concepts.toml K22:195-202.)

### Prereqs

- centrs on PATH (pinned version; orca pins via mise/bun — orca-setup.md:22-34).
- `centrs devices list` readable (CDB path resolvable; `--cdb-file` override).
- For twins: `quickchr list` shows the machine running.
- For L2 steps: same-subnet adjacency (ARP check first).

### Access

- Reads-first: retrieve identity/resource before any write.
- bigdude (production): reads free; ANY write asks the developer first.
- Twins: anything goes; never delete twin1/twin2.
- Multi-step work on a shared box: set `/system/note` WIP flag first, clear
  after (K11; concepts.toml:96-103) — coordination convention, not a lock.
- Operator Unknown → ask before any write (concepts K14; concepts.toml:123-130).

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth (CLI.md:46-47) |
| `CENTRS_SSH_KEY` | Batch SSH key path fallback (CLI.md:96) |
| `CENTRS_TIMEOUT` | Default 10s execute timeout (execute.ts:1322-1326) |
| `CENTRS_PORT` / `CENTRS_HOST` | Port/host overrides (careful: URL host pins rest) |
| `CENTRS_INSECURE` / CDB `insecure=` | Trust opt-out, always warned (CONSTITUTION.md:493-500) |
| `CENTRS_CDB_PASSWORD` | Encrypted CDB decrypt (CLI.md:267) |
| `ROUTEROS_USER`/`ROUTEROS_PASSWORD` | TEMPORARY handoff only; T9 replaces (orca-setup.md:47-51) |

### Outputs

- Probe table: port → open/closed, REST-401, ARP, MNDP.
- Selected `--via` + reason; authenticated identity read (JSON envelope).
- CDB record created/updated (handle, via, port, ssh-key path — never key
  material, never passwords in prose).
- On failure: escalation packet (step 5).

### Verification

- Identity read `ok:true` over the selected transport (orca-setup.md:52-54).
- `devices show <handle> --via <p>` reports expected protocol without
  connecting (devices/README.md:387-390).
- `meta.settings` shows intended via source; `meta.warnings` carries every
  auto hop with reason (CONSTITUTION.md:467-474; transfer/README.md:114).
- Claim discipline: every claim carries command + output; lab pass ≠
  permission (K23; concepts.toml:204-211).

### Recovery

- C11 timeout kill → `--timeout 30s` (REST ≤60s).
- C8 0-byte upload → retry `--force`.
- C9 empty-token → remove/add record.
- C6 REST denial → treat as failure, never success, never retry blindly.
- C2 mac-telnet timeout → stop L2 attempts, escalate with D2 evidence shape
  (tikoci-issues.md:10-16).
- Redaction: scrub `password|secret|private-key|community` + container
  inline `env="K=V"` values from ANY captured output before storing/posting
  (C1; needs.toml:4-13; redaction incident orca-setup.md:204-210).
  Captures stay local, never committed (orca-setup.md:165-166).

### Limits

- No silent cross-`--via` downgrade anywhere: pinned transport that can't
  do the op errors `transport/*` (CONSTITUTION.md:467-474).
- `centrs check` (reach+health battery) is DESIGNED, not implemented
  (MATRIX.md:42,98-103) — this recipe is the manual version until it lands.
- quickchr v1: no mac-telnet path; rest/native/ssh only.
- SNMP retrieve-only, must reject execute (MATRIX.md:35-37).
- btest explicit-only, never in any chain (CONSTITUTION.md:479-480).
- RoMON/WinBox Terminal/future methods (scp/fetch/ftp): explicit-only or
  not-built (transfer/README.md:98-100,117-119).

## Part 3 — CDB assumptions (T9 designs the real scheme; this recipe assumes)

1. CDB file lives at the centrs default (`~/.config/tikoci/winbox.cdb`;
   CLI.md:266) or `--cdb-file`; `devices` sole writer (CLI.md:19).
2. `__default__` record supplies fallback creds for ad-hoc targets but
   NEVER widens the MCP allowlist (CONSTITUTION.md:433-438; confirmed
   src/resolver/cdb.ts:98-118, DEFAULT_RECORD_TARGET at :115).
3. Per-device `via=` names EXECUTE transports (`rest-api|native-api|ssh|…`)
   (devices/README.md:112) and transfer does NOT honor them (C10) —
   recipe pins transfer `--via` explicitly until unified.
4. `ssh-key=` is a filesystem path; encrypted-CDB password comes from
   `--cdb-password`/env, never stored beside the CDB.
5. T9 will replace the `.env`-mapping handoff (S2; needs.toml:235-244) and
   decide rotation/persistence; until then: persist to CDB on first success
   (fixes UID 517 "clean-system amnesia"), never paste secrets into coord
   drafts or notes.
