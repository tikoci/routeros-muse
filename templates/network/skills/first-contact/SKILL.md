---
name: first-contact
description: "First contact with a RouterOS box: probe, select transport, authenticate, persist to CDB, escalate. Use when: contacting a box not yet in the device registry, any transport/auth/timeout failure, or before first SSH on a new box."
topics: [contact, transport]
tested: none
---

# `first-contact` skill (probe → select → CDB → escalate) [template v1 draft]

Promoted from the evidence-critic-verified negotiation recipe (all claims
supported against live sources). Vendored for review with template v1.
No secrets below; addresses/MACs from captures are redacted to roles.

## Part 1 — The checklist (probe-select-CDB-escalate)

Run top to bottom. Stop at the first transport that yields an authenticated
read. Never SSH-first blind (specimen: an agent burned turns on
`execute --via ssh` before probing what the box offers).

### 0. Load credentials (CDB-first, env fallback)

1. `centrs devices show <handle>` — if a record exists, use it (zero flags).
2. Else check env: `CENTRS_USERNAME` / `CENTRS_PASSWORD`, and
   the temporary handoff mapping `ROUTEROS_USER`/`ROUTEROS_PASSWORD` →
   `CENTRS_*` (a credential-handoff design replaces this).
3. If neither exists: skip to step 5 (escalate) AFTER completing the
   no-cred probe (step 1) — reachability + latency are still reportable
   without creds.

### 1. Probe (no creds needed)

- TCP ports per box: 22 (ssh), 80/443 (REST), 8291 (winbox), 8728/8729
  (native API plain/TLS), UDP 20561 (mac-telnet),
  UDP 5678 (MNDP).
- Cheap liveness reads (do NOT authenticate yet):
  - `centrs discover --timeout 15s` for L2 neighbors.
    Caveat: host firewall can eat L2; one live box was MNDP-invisible
    while alive. Absence proves nothing.
  - REST alive test: any `/rest/*` answering 401 = RouterOS v7 REST alive,
    auth-gated. But 443-accept-then-reset is NOT REST
    (possibly SSTP); verify with a real REST call.
  - ARP presence = L2-adjacency fact. Required
    before even considering mac-telnet.
- Record: open ports, REST-401 yes/no, ARP yes/no, MNDP seen yes/no.

### 2. Select (probe-then-pick — centrs auto-select does NOT fail over)

- No-failover: refused 8728 ends the attempt; SSH/REST are never tried.
  You must pick explicitly.
- Per-operation preferences:
  - `retrieve`: rest-api first, native-api second (`--follow`: native only,
    no downgrade). Pin with `--via`.
  - `execute`: auto picks native-api unless target is an `http(s)://` URL
    (then rest-api) or a bare unresolved MAC (then mac-telnet).
    Pin with `--via <native-api|rest-api|mac-telnet>`. NOTE: the
    documented execute `--via` value list omits `ssh` but ssh is a CHR-passed
    execute cell and `--ssh-key`/`--insecure` document `--via ssh`
    — `ssh` works despite the value-list gap.
  - `transfer`: methods are `rest`/`native`/`sftp` — NOT the execute names.
    Record `via=ssh` is ignored; pin `--via sftp` explicitly.
    Auto: downloads + ≤60 KB uploads via
    rest/native; >60 KB uploads via sftp.
    A pinned `--via` never silently downgrades.
  - `terminal`: ssh default; mac-telnet for MAC targets.
- Decision order for first contact: REST (401→alive) → native-api 8728 →
  ssh 22 (only if a key exists — batch SSH is key-only, step 3) →
  mac-telnet (only with proven L2 adjacency AND mac-server enabled).
- `--via` + quickchr: v1 forwards rest-api/native-api/ssh only; anything
  else is typed `quickchr/unsupported-via`, never silent fallback.
  Prefer `--quickchr <name>` for twins — no creds needed.

### 3. Authenticate (transport-specific rules)

- Batch SSH (execute/transfer-sftp) runs `BatchMode=yes` and NEVER sends a
  password — key auth only.
  Missing key fails fast; it never prompts. Remediation names the key
  source used.
- RouterOS ≥7.21 default `/ip/ssh password-authentication=yes-if-no-key`
  refuses password login once the user HAS a key.
  Installing a key disables password SSH for that
  user — an owner-accepted side effect; say so before installing a key.
- SSH user needs `ssh` policy; SFTP file access needs `ftp` policy.
- mac-telnet: MTWEI required; stock RouterOS offers 16-byte MD5 salt but
  REJECTS the MD5 proof.
  `END_AUTH` ≠ success — success only when terminal output arrives.
  ~10s login stall is normal; do NOT confuse
  with the 30s login timeout on 7.26beta3
  — that one is a device/firmware failure, escalate.
- REST/native take username+password (env or CDB). TLS/REST verify by
  default; self-signed RouterOS certs fail `transport/tls-certificate`
  naming `--insecure`. SSH host keys are
  trust-on-first-use by default.
- Prove auth with a read, not a write: `retrieve --host <h>
  /system/identity --via native-api --format json` →
  `{"ok": true, ...}`.

### 4. Persist (CDB write on first success)

- `devices` is the ONLY command that writes the CDB.
- On first authenticated success: `centrs devices add <handle>` (+
  `--user/--password` or key path), per-device `via=`/`port=`/`ssh-key=`
  overrides as comment-kv. Precedence:
  defaults → centrs.env → comment-kv → env → CLI flag; `meta.settings`
  reports winner+source.
- Caveat: `devices set <t> key=` SHOULD remove the token per docs
  but currently stores an empty value.
  Workaround: remove/add the record instead of empty-token removal.
- NEVER improvise a CDB with secrets outside the designed handoff;
  ssh-key stores a PATH only, never key material.

### 5. Escalate (terminal states — reach them fast, not after flailing)

Escalate to the developer/owner when ANY holds (correct terminal states:
every open door needs a password nobody has, every key door
needs SSH enabled):

1. No creds anywhere (CDB empty, env empty) AND REST-401/auth-gated on all
   open management ports. Ask: one password (agent self-serves from there:
   import ssh key + enable ssh over REST, then never needs it again —
   the REST-first path), OR human enables `/ip service ssh` via
   winbox.
2. SSH down + REST down + only winbox/L2 visible. Human-hands only.
3. mac-telnet 30s login timeout with mac-server=all + proven L2.
4. Any write-shaped bootstrap on a NON-twin box (key install, service
   enable): owner go-ahead required (production rule — owner-approved).
5. Timeout kill suspected: default execute timeout is 10s
   (`CENTRS_TIMEOUT`); a 12s run dies mid-payload
   silently — retry `--timeout 30s` before escalating.
   REST caps at 60s.
6. Transfer 0-byte first attempt: retry with `--force`.
7. REST permission denial (HTTP 500/9) reads retryable/outcome-unknown —
   NEVER treat as success.

Escalation packet: probe table (step 1) + selected via + exact command +
  error code + what was already tried. Claim = command + output.

## Part 2 — Skill doc

### Trigger

Load when: contacting a RouterOS box not yet in the CDB; any
`transport/*`, `auth/*`, or timeout failure; before first `execute --via
ssh` on a new box; enbeep TX path setup. (Entry-skill + capability-probe
pattern.)

### Prereqs

- centrs on PATH (pinned version; pin via mise/bun).
- `centrs devices list` readable (CDB path resolvable; `--cdb-file` override).
- For twins: `quickchr list` shows the machine running.
- For L2 steps: same-subnet adjacency (ARP check first).

### Access

- Reads-first: retrieve identity/resource before any write.
- Production: reads free; ANY write asks the developer first.
- Twins: anything goes; never delete a twin others rely on.
- Multi-step work on a shared box: set `/system/note` WIP flag first, clear
  after — coordination convention, not a lock.
- Operator Unknown → ask before any write.

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth |
| `CENTRS_SSH_KEY` | Batch SSH key path fallback |
| `CENTRS_TIMEOUT` | Default 10s execute timeout |
| `CENTRS_PORT` / `CENTRS_HOST` | Port/host overrides (careful: URL host pins rest) |
| `CENTRS_INSECURE` / CDB `insecure=` | Trust opt-out, always warned |
| `CENTRS_CDB_PASSWORD` | Encrypted CDB decrypt |
| `ROUTEROS_USER`/`ROUTEROS_PASSWORD` | TEMPORARY handoff only; a credential-handoff design replaces |

### Outputs

- Probe table: port → open/closed, REST-401, ARP, MNDP.
- Selected `--via` + reason; authenticated identity read (JSON envelope).
- CDB record created/updated (handle, via, port, ssh-key path — never key
  material, never passwords in prose).
- On failure: escalation packet (step 5).

### Verification

- Identity read `ok:true` over the selected transport.
- `devices show <handle> --via <p>` reports expected protocol without
  connecting.
- `meta.settings` shows intended via source; `meta.warnings` carries every
  auto hop with reason.
- Claim discipline: every claim carries command + output; a twin pass ≠
  permission.

### Recovery

- Timeout kill → `--timeout 30s` (REST ≤60s).
- 0-byte upload → retry `--force`.
- Empty-token → remove/add record.
- REST denial → treat as failure, never success, never retry blindly.
- mac-telnet timeout → stop L2 attempts, escalate with the failure evidence.
- Redaction: scrub `password|secret|private-key|community` + container
  inline `env="K=V"` values from ANY captured output before storing/posting.
  Captures stay local, never committed.

### Limits

- No silent cross-`--via` downgrade anywhere: pinned transport that can't
  do the op errors `transport/*`.
- `centrs check` (reach+health battery) is DESIGNED, not implemented
  — this recipe is the manual version until it lands.
- quickchr v1: no mac-telnet path; rest/native/ssh only.
- SNMP retrieve-only, must reject execute.
- btest explicit-only, never in any chain.
- RoMON/WinBox Terminal/future methods (scp/fetch/ftp): explicit-only or
  not-built.

## Part 3 — CDB assumptions (a future credential-handoff design replaces these; this recipe assumes)

1. CDB file lives at the centrs default (`~/.config/tikoci/winbox.cdb`)
   or `--cdb-file`; `devices` sole writer.
2. `__default__` record supplies fallback creds for ad-hoc targets but
   NEVER widens the MCP allowlist.
3. Per-device `via=` names EXECUTE transports (`rest-api|native-api|ssh|…`)
   and transfer does NOT honor them —
   recipe pins transfer `--via` explicitly until unified.
4. `ssh-key=` is a filesystem path; encrypted-CDB password comes from
   `--cdb-password`/env, never stored beside the CDB.
5. A credential-handoff design will replace the `.env`-mapping handoff and
   decide rotation/persistence; until then: persist to CDB on first success
   (fixes "clean-system amnesia"), never paste secrets into coord
   drafts or notes.
