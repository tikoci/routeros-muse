---
name: firewall-apply
description: "Change firewall rules the safe way: read the order first, propose with placement, twin-verify with counters, tag everything, roll back clean. Use when: any /ip/firewall or /ipv6/firewall change (filter, NAT, mangle, address-list), rule-order questions, or proving a firewall change before production."
topics: [firewall]
requires: [twin]
tested: none
---

# `firewall-apply` skill (read order → propose → twin-verify → tag → clear) [template v1 draft]

Promoted from an executed twin verification loop
(7.26beta3 CHR twin): tagged
non-terminal log rules, host→guest traffic, counter read-back,
`place-before` ordering proof, live non-terminal fall-through
proof, tag cleanup to pristine. Consumes the `routeros-firewall`
DOMAIN skill (rule semantics) and adds this procedure (proposal
shape, twin verification, ledger). Terminal accept/drop placement
is PRESCRIBED from the domain skill, not executed — the drill
stays non-terminal by design so the twin was never at lockout
risk. No secrets below.

## Part 1 — The checklist (order first, always)

Run top to bottom. No firewall write touches a non-twin box
before step 3 passes on a twin AND the proposal (step 2) has
owner approval.

1. Read the current order: full `print` of the target chain(s)
   before proposing anything. Position is the semantics —
   there is no priority field.
2. Write the proposal: rule intent, exact position
   (`place-before` target or append-justified), blast radius,
   counter prediction (what traffic should hit it), and the
   rollback read (tag cleanup command + pre-change print).
3. Twin-verify with traffic: stage the rule on a twin, drive
   real packets at it, read counters back. Zero-hit rules are
   unproven rules.
4. Apply with tags: every rule the change owns carries the
   change tag in `comment`; address-list/interface-list
   support rows carry it too. Untagged rules are orphans.
5. Clear and ledger: on rollback, tag-remove and re-print to
   prove pristine; record proposal + twin evidence + final
   print in the ledger either way.

### 0. Order is the semantics (domain recap)

From the `routeros-firewall` domain skill — the load-bearing
rules, restated once so the procedure stands alone:

- Rules evaluate top-to-bottom, first match wins. Default
  `add` APPENDS; `place-before=0` inserts at top.
- An `accept` must sit ABOVE any `drop` for the same traffic
  or it never fires.
- `action=log`, `add-src/dst-to-address-list`, and
  `passthrough=yes` are NON-TERMINAL: evaluation continues
  and a `drop` below still fires.
- `/ip/firewall` and `/ipv6/firewall` are SEPARATE: v4 rules
  never match v6 traffic and vice versa. A change covering
  "the firewall" audits both.
- Scale with `src/dst-address-list=` and
  `in/out-interface-list=`, never one rule per IP or per
  interface. Cleanup is tag-based
  (`remove [find comment~"tag-"]`) — NEVER
  `remove [find dynamic=no]`, which deletes other tools'
  rules too.

### 1. Read the order (reads — the mandatory first step)

```sh
centrs execute --quickchr <twin> '/ip/firewall/filter/print'
centrs execute --quickchr <twin> '/ipv6/firewall/filter/print'
# -> full ordered rule lists (or {} when the chain is empty — fresh-twin baseline)
```

- Grounded: a fresh-twin baseline read `{}` (no filter rules on a
  fresh CHR); populated order read after staging showed
  position-exact rows.
- Read BOTH families even for a v4-only intent: the proposal
  must state the v6 posture ("no v6 rules, unchanged") rather
  than assume it. Silent half-coverages are how bypasses ship.
- Also read the support menus the change touches
  (`address-list/print`, `interface/list/print`): a rule
  referencing a missing list is a different failure than a
  misordered rule, and the read tells them apart.

### 2. Propose with placement (the approval artifact)

```sh
# Proposal shape (written, approved, then executed verbatim):
#  intent:   <what traffic, what verdict>
#  position: place-before=<n|0> | append (justify: chain currently ends with <x>)
#  blast:    <which hosts/flows can match; what breaks if wrong>
#  counters: <predicted hits from <traffic source>>
#  rollback: remove [find comment~"<tag>-"] + pre-change print attached
```

- Position is part of the proposal, not an implementation
  detail: `place-before=0` vs append changes which traffic
  the rule ever sees. The approver approves the POSITION.
- Counter prediction forces a verification plan: "3 HTTP
  hits → ~21 packets on the log rule" is falsifiable; "it
  should work" is not. The twin run (step 3) checks it.
- Terminal-rule placement (accept-above-drop) is prescribed
  from the domain skill: an accept that lands below its drop
  is a no-op with a confident comment. The proposal's
  position line is where that gets caught.

### 3. Twin-verify with traffic (writes — the proof step)

```sh
centrs execute --quickchr <twin> '/ip/firewall/filter/add chain=input protocol=tcp dst-port=80 action=log log-prefix="t28-fw" comment="t28-fw-probe"' --yes
# -> {"ret": "*1"}
curl -s -m5 -o /dev/null http://127.0.0.1:<twin-http>/   # drive real packets
centrs execute --quickchr <twin> '/ip/firewall/filter/print stats'
# -> ";;; t28-fw-probe  0 input  log  1 086  21"  (3 hits = 21 packets / 1086 bytes)
```

- Grounded end to end: 3 host→guest HTTP hits
  through the quickchr forward produced 21 packets /
  1086 bytes on the staged log rule. Counters are the proof
  the rule matches the intended traffic.
- Prefer a non-terminal `action=log` twin probe for the FIRST
  verification of any match criteria: it proves the match
  (chain/proto/ports/lists) with zero forwarding impact.
  Promote to the terminal verdict only after the match is
  proven — match-wrong + terminal is how lockouts ship.
- Zero-hit rules are unproven: if counters stay 0, the match
  is wrong (family? interface? list contents?) — fix the
  match on the twin, never "it'll hit in production".

### 4. Ordering + fall-through (writes — twin, proven live)

```sh
centrs execute --quickchr <twin> '/ip/firewall/filter/add chain=input protocol=tcp dst-port=80 action=log log-prefix="t28-fw-top" place-before=0 comment="t28-fw-top"' --yes
# -> {"ret": "*2"} — listed FIRST on re-print: place-before proven
curl ...   # one more hit = 7 packets
# t28-fw-top: 0 -> 7 packets; t28-fw: 21 -> 28 packets — BOTH incremented
```

- Grounded: `place-before=0` put `*2`
  above `*1` on re-print; one further hit incremented BOTH
  rules' counters — the live proof that `log` is
  non-terminal and evaluation falls through.
- Use this drill shape to prove any ordering claim before
  production: stage two tagged log rules at the disputed
  positions, drive traffic, read both counters. The numbers
  settle "which rule sees it first" without touching verdicts.
- Cleanup is the tag remove (step 5): both drill rules went
  with one `remove [find comment~"t28-fw"]`, re-print back
  to `{}`.

### 5. Tag, apply, clear (writes — production shape)

```sh
# Apply: every owned row tagged, support rows included
centrs execute <prod> '/ip/firewall/filter/add chain=<c> ... comment="<tag>-<intent>" place-before=<n>' --yes
# Rollback: one tag remove + pristine proof
centrs execute <prod> '/ip/firewall/filter/remove [find comment~"<tag>-"]' --yes
centrs execute <prod> '/ip/firewall/filter/print'   # compare against pre-change print
```

- Tag scope covers support rows: address-list entries and
  interface-list members the change added carry the same
  tag and go in the same rollback. A rule rollback that
  leaves its list entries behind is half a rollback.
- Pristine proof is a re-print compared against the
  proposal's attached pre-change print — not "remove
  returned ok". The remove returning `{}` says nothing
  about what remains.
- Production applies need owner approval per change (production
  rule); the twin evidence + proposal + pre-change print
  are the approval packet.

## Part 2 — Skill doc

### Trigger

Load when: any `/ip/firewall` or `/ipv6/firewall` change is
planned (filter, NAT, mangle, address-list, interface-list);
rule-order questions; proving a firewall change on a twin;
rollback of a firewall change.

### Prereqs

- centrs on PATH; target reachable (`first-contact` first on
  any box not yet in the device registry).
- The `routeros-firewall` domain skill for rule semantics
  (this skill is the procedure wrapper, not the reference).
- A twin at matching firmware for the verify run; a traffic
  source that reaches the twin (host→guest forward, second
  twin, or on-box generator).
- The proposal written (intent/position/blast/counters/
  rollback). No proposal = no run on non-twins.

### Access

- Twins: anything goes — but prefer non-terminal probes
  first even on twins; lockout-free drills keep iteration fast.
- Production: reads free; ANY write asks the
  developer first — including log-rule probes, not just
  terminal verdicts.
- Operator Unknown → ask before any write.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s is ample for filter ops |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |
| `CENTRS_SSH_KEY` | Batch SSH key path (key-only, never password) |

### Outputs

- Pre-change print(s): ordered rules for every touched
  chain, both families.
- Proposal: intent/position/blast/counters/rollback.
- Twin evidence: staged commands + traffic driven +
  counter read-backs + cleanup print.
- Final record: applied commands, post-apply print, or
  rollback record with pristine proof.

### Verification

- Counters on the staged rule match the prediction after
  driven traffic (nonzero and proportionate).
- Re-print shows the rule at the proposed position.
- Tag remove + re-print matches the pre-change print
  exactly (rollback case).
- Both families audited: the record states the v6 posture
  even when the change is v4-only.

### Recovery

- Counters stay 0 → match is wrong (family/interface/list),
  not "production will differ". Fix on the twin.
- Rule lands in the wrong position → remove by tag and
  re-stage; never `move` by interactive row number in
  scripts (routeros-scripting: row numbers are unstable).
- `validation/syntax` on a firewall path → check the
  package/menu exists on the box before re-quoting
  (routeros-centrs: missing menus reject this way).
- Lockout on a twin → console in via quickchr and
  tag-remove; on production → escalate with the proposal +
  twin evidence, do not guess at rules.
- Redaction: scrub secrets from stored prints (pre-publish-scrub
  tiers); firewall prints can carry addresses worth treating as
  sensitive off-box.

### Limits

- Terminal accept/drop placement is PRESCRIBED from the
  domain skill, never executed — the first terminal-rule
  twin run must update this skill with its evidence.
- Counter proofs cover match + position only; throughput,
  conntrack-table, and FastTrack interactions are outside
  this drill (see domain skill mangle/DoS references).
- CHR twins have no radios and x86-only packages: wireless
  and hardware-specific chains need their own proof boxes.
- NAT/mangle rows follow the same procedure (propose →
  twin-verify → tag → clear) but have no executed drill
  yet — same honesty rule applies.
