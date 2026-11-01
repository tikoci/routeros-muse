---
name: agent-access-bootstrap
description: "Router access accounts done safely: local reader/admin/break-glass, custom minimal groups (never defaults), Wi-Fi AAA default-group audit, show-sensitive verify, revocation. Use when: onboarding a router's agent access, adding a reader or admin account, auditing who can log in, or recovering from a credential incident."
topics: [accounts, aaa, radius, wifi]
requires: [twin]
tested: none
---

# `agent-access-bootstrap` skill (reader → admin → break-glass → audit) [template v1 draft]

Promoted from a twin account-matrix proof, an
earlier CHR policy matrix, the standing access
decision + a RADIUS outage journal,
and the default-group trap. No secrets
below; passwords are throwaways-never-recorded by rule.

## Part 1 — The checklist (least privilege, local first)

Run top to bottom. Every account answers "what breaks if this leaks"
before it is created.

1. Create the custom minimal groups (§0): reader + admin-shaped,
   explicit policies, never a default group — twin-proved first.
2. Create the local accounts (§1): agent reader, agent admin,
   human break-glass; humans normally ride RADIUS, agents never do.
3. Audit the AAA defaults (§2): default-group trap, Wi-Fi login
   rights, show-sensitive verify as the reader.
4. Record + bound revocation (§3): ledger entry, what each account
   can reach, how each is killed.

### 0. Groups (custom minimal, never default)

Re-verified 2026-10-29 on a CHR twin, 7.26beta3.
The default `read` group carries
`local,telnet,ssh,reboot,read,test,winbox,password,web,sniff,
sensitive,api,romon,rest-api` — reboot, sensitive, password, and
sniff ride along with "read". Never give an agent a default group.

```sh
centrs execute --quickchr <twin> --yes \
  '/user/group/add name=<reader-group> policy=read,api,rest-api' --json
# ok:true — read-back shows every negation explicit:
# read,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,
# !test,!winbox,!password,!web,!sniff,!sensitive,!romon
```

Version rule (CHR matrix, 7.23.8 → 7.26beta3): before
7.26beta3, REST needs `api` as well as `rest-api` or every request
fails `not allowed (9)`; 7.26beta3 fixed REST login for
`rest-api`-without-`api`. A recipe for stable/long-term routers
still adds `api`. The twin read `ok:true via rest-api` as
`read,api,rest-api` on 7.26beta3 — that row is verified.

Admin-shaped group: reader policies + `write`, still without
`policy`, `sensitive`, `reboot`, `sniff`, `password`
(help-verified shape — the twin run proved the reader half; the
admin half follows the same add + read-back, first applier records
it). The proposing account needs `write` (staged-script approval
runs under it), so the centrs remote profile — not RouterOS — is
what stops direct writes. A dedicated account with no
`policy/sensitive/reboot` bounds the blast radius of a centrs bug.

Script-policy trap [VERIFIED CHR 7.25]: a user without
`write` running a `policy=read,write` script is refused `(9)` —
RouterOS checks the runner's rights at approval time, which is what
makes human-run approval sound. And a user creating a script wider
than their own policy gets `201 Created` with the policy quietly
narrowed, `source` EMPTIED, `invalid=true`: the proposer must read
the script back and fail closed on `invalid` or empty source.

### 1. Accounts (local reader, local admin, local break-glass)

The standing decision (journaled operating guide): agent accounts encode
their level — a *reader* (no write, reboot, sniff, sensitive) and
an *admin* for writes; a local *break-glass* for humans. Humans
normally log in through RADIUS. Agents never do:

> The agent's access path must not depend on the service it may be
> asked to fix. (Outage lesson: when the RADIUS database failed
> to open after a reboot, human logins failed because
> one site authenticates against another. The agent kept access
> because its accounts are local to each router.)

```sh
centrs execute --quickchr <twin> --yes \
  '/user/add name=<reader> group=<reader-group> password="<throwaway>"' --json
# ok:true {"ret":"*2"} — password value NEVER enters notes/ledger/coord
```

- Passwords are set from shell variables holding throwaways,
  rotated before each credentialed probe, and redacted to
  `<throwaway>` in every record.
- One agent identity per router: local accounts, per-device
  credentials, no shared agent password across the fleet.
- Break-glass is human-only, full-adjacent rights, sealed (sealed
  envelope / owner custody per the credential scheme in force):
  its existence is recorded, its secret is not. First use of
  break-glass anywhere is an incident to write up, not a routine.
- Service accounts the router itself needs (RADIUS client secret,
  API users for the container) are separate entries with the same
  treatment: named, minimal, recorded-by-shape.

### 2. Audit (AAA defaults, Wi-Fi rights, show-sensitive)

The default-group trap [JOURNALED, precondition re-verified on the
twin]: RouterOS ships `/user/aaa default-group=read`, which means
every Wi-Fi login in User Manager is ALSO a router login with read,
sensitive, reboot, and password rights. The fix is a no-policy group
as the default, so only an explicit RADIUS group grants router
access:

```sh
centrs execute --quickchr <twin> --yes \
  '/user/group/add name=<no-policy> policy=' --json
# ok:true — empty policy accepted, reads back all-negated (twin run)
centrs execute --quickchr <twin> --yes \
  '/user/aaa/set default-group=<no-policy>' --json
# read back /user/aaa to confirm; twin restored to read afterwards
```

Wi-Fi AAA audit (same trap, wireless half): User Manager
`shared-users` defaults to 1 — a second device on the same login
drops. Per-person WPA-Enterprise logins each land on their VLAN via
explicit RADIUS group attributes; after the default-group fix, a
login with NO group attribute gets router access nowhere. Audit
shape: list UM users → each has an explicit group → default-group
is the no-policy group. (Collected from an earlier access demo + trap
write-ups; the twin run proved the group/aaa mechanics, not a live
WPA-Enterprise join — radio truth needs hardware.)

Show-sensitive verify (reproduced on the twin): with a RADIUS
secret on-box, `/export show-sensitive` as the reader renders
`secret=*****`, while the admin sees the clear value. Run this
verify after every bootstrap: it proves the reader's policy gap is
real, not assumed. Caveat carried from the field: the
pull STILL redacts container env values after finding `/export`
prints them in clear even WITHOUT show-sensitive — "safe to share"
is a tested transformation, never a flag.

### 3. Record + revocation (bound every account)

- Ledger entry per bootstrap (evidence-ledger): date + environment +
  box, groups with full read-back policies, accounts by name +
  group (never secrets), AAA read-back, show-sensitive verify
  output, pending list.
- Revocation bound, per account: disable/remove command recorded at
  creation time (`/user/remove numbers=<name>` proved in teardown;
  groups likewise). Rotation of any secret the account could read
  travels with the revocation — a removed reader whose RADIUS
  secret it once saw stays valid is half-revoked.
- Verify the kill: a login attempt as the removed account must fail
  (bare-401 / auth-failed shape, failure-layer-attribution), and
  the failure must appear in `/log`. Unverified revocation is
  pending, not done.
- Active-session behavior (`/user/active` — whether removal kills
  live sessions) was NOT probed in the twin run: pending. First
  revocation that needs it grounds it.

## Part 2 — Skill doc

### Trigger

Load when: onboarding agent access to a new or adopted router;
adding reader/admin/break-glass accounts; auditing logins, groups,
or AAA defaults; any credential incident or rotation; "who can log
in here" questions. (Entry-skill + capability-probe pattern.)

### Prereqs

- The box reachable over an admin path (first-contact if new).
- Twin at matching firmware for the proof half (matrix rows are
  version-sensitive — 7.26beta3 vs stable differ).
- The credential scheme in force (the device CDB once the
  credential-handoff design lands; throwaway
  discipline until then). No password ever touches notes or chat.

### Access

- Twin: full freedom, teardown after, groups/users removed.
- Production: account changes are writes — approval per item;
  the developer approves. The bootstrap proposal names every
  group policy verbatim (read-back shape, not shorthand).
- Break-glass secret: owner custody, sealed, never in agent-visible
  storage. Its NAME is recorded; its VALUE never is.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Raise for slow-twin reads during bootstrap |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Preferred over CLI flags for credentialed probes (fewer secrets in argv/history) |

### Outputs

- Groups created with full read-back policies; accounts by
  name + group; AAA read-back showing the no-policy default.
- Show-sensitive verify transcript (reader `*****` vs admin clear).
- Ledger entry + revocation bounds (kill command + verify shape
  per account).
- Pending list: anything collected-but-unrun (radio joins,
  active-session kill, pre-7.26beta3 rows if the fleet has them).

### Verification

- Every group read back after creation (negations explicit).
- Reader REST read ok; reader write denied with
  `routeros/permission-denied` (post-centrs#541 — never retryable).
- `default-group` reads back the no-policy group.
- Show-sensitive renders `*****` for the reader.
- Revocation rehearsed or explicitly pending with an owner.

### Recovery

- Locked out mid-bootstrap: break-glass (human), then write up the
  incident — including how the lockout happened, or it recurs.
- `not allowed (9)` on EVERY REST request: group has `rest-api`
  without `api` on pre-7.26beta3 firmware — add `api` (the version
  trap, now also named in centrs' own remediation text).
- RADIUS outage (humans down, agent up): agent accounts stay local
  and working — fix the service (incident-response), do NOT "fix"
  by moving agents onto RADIUS.
- Secret suspected exposed: rotate it, verify the new value works
  and the old fails, record as anomaly (redaction-incident rule).

### Limits

- CHR proof only (7.26beta3): local users, no live RADIUS server,
  no WPA-Enterprise join (no radios on CHR). The outage rule and
  Wi-Fi halves are journaled, not re-run here.
- Pre-7.26beta3 matrix rows collected from earlier runs, not re-run
  on this twin. Mixed-firmware fleets re-prove per firmware.
- Admin-half group recipe is help-verified shape + same-mechanics
  reasoning: first applier runs the add + read-back and records it.
- Active-session kill semantics pending (`/user/active` unprobed).
- Cloudflare Access user/group shapes out of scope here (an
  open /app-playbook boundary question).
