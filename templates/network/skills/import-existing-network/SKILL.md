---
name: import-existing-network
description: "Adopt a running network without breaking it: pull first, checker-verify, derive the plan ONLY from observed state, import writes later under approvals. Use when: onboarding an existing router or network, adopting captures someone else took, writing a first plan for unknown infrastructure, or asking what a box can and cannot do."
topics: [provisioning, migration]
tested: none
---

# `import-existing-network` skill (pull → verify → adopt → plan-from-observed) [template v1 draft]

Promoted from the executed pull-first adopt drill
(a 7.26beta3 CHR twin): `pull.ts` capture
(status ok, 5 files), `checker.ts` clean (no problems),
full adopt read, and a plan derived SOLELY from observed
state (cited by shape) — with ZERO
writes to the box. This skill holds the ONE allowed
plan-from-capture direction: capture → plan is permitted;
plan → capture (writing a capture to fit a plan) is forgery.
Import (writing the plan back) is `change-apply`'s procedure
with approvals — a separate, later act.
No secrets below.

## Part 1 — The checklist (read everything, write nothing)

Run top to bottom. No write touches the adopted box during
steps 1–4 — not even "harmless" ones. Writes begin at step 5
under the normal approval rules.

1. Pull first: capture the box (export + JSON menus +
   manifest) before any other contact beyond reachability
   (step 0).
2. Checker-verify: the capture is adopted ONLY if the
   checker passes (hashes, schema, serial continuity).
   Unchecked captures are rumors (step 1).
3. Adopt by reading: inventory facts AND absences from the
   capture. An absence (no firewall rows, no UM package)
   is a finding, not a gap (step 2).
4. Plan from observed: every plan line traces to a capture
   line or a stated absence. Intent comes from the owner,
   never from the capture (step 3).
5. Import under approvals: execute the plan back onto the
   box via change-apply (twin-proof, propose, stage, run,
   read back, clear). Adoption ends; change begins (step 4).

### 0. Pull first (reads — the mandatory opening)

```sh
cd pull && bun pull.ts --quickchr <device> --out out
# -> {"status":"ok","dir":"out/<device>/<ts>/","files":5,"notes":[...]}
```

- Grounded: the twin pull returned
  `status: ok` with 5 files + manifest; the CHR note
  ("no routerboard; identity is license system-id") rode
  along in `notes` — device identity established at capture.
- Capture shape: `export.rsc` (`/export terse`, secrets
  redacted, header stabilized) + 4 JSON menus (resource,
  ip-address, interface, package; volatile stripped so
  diffs mean config changed) + `manifest.json` (target,
  serial, time, tool versions, sha256 per file).
- Serial gate: a capture whose serial differs from the
  device's last manifest is REFUSED (exit 2, `attempt.json`
  only, nothing published). Same device, different box is
  the failure this gate exists for — never bypass it.
- Captures are LOCAL ONLY (`pull/out/`): they carry
  system IDs and network shape. Never publish, paste, or
  commit them; cite paths + redacted facts only.

### 1. Checker-verify (no router contact — the trust step)

```sh
cd pull && bun checker.ts --device <device> --out out
# -> {"device":"<device>","ok":true,"dir":"out/<device>/latest","totalBytes":2073,"files":5,"problems":[]}
```

- Grounded: the twin `ok: true`, 5
  files, zero problems. The checker re-hashes every file
  against the manifest and validates schema + `latest`
  symlink — adoption rests on THIS verdict, not on the
  pull's exit code alone.
- Partial captures (`status: partial`) keep last-good
  files and say so in `manifest.notes`: adoptable for
  the files present, with the missing ones named as
  unknowns. Partial is honest; silent is not.
- Adopt a capture someone else took the same way: run
  the checker yourself before reading it as truth. The
  manifest's tool versions tell you what produced it.

### 2. Adopt by reading (facts AND absences)

```text
# twin adopt read, sysid redacted:
O1: CHR, x86_64, 7.26beta3, 512 MB            (system-resource.json)
O2: routeros package ONLY — no container/UM/dude/cmr/zerotier/wireless
O3: 1 ether via DHCP; placeholders-only firewall + hotspot; default users
O4: identity is license system-id (CHR rule)  (manifest notes)
O5: single uplink, DHCP-learned address       (interface/ip-address JSON)
A1: no retained backup snapshot               (absence — finding, not gap)
A2: no monitoring probes                      (no netwatch/scheduler rows)
A3: no firewall policy                        (placeholders only)
A4: factory-default identity                  (no /system/identity line)
```

- Grounded: five facts, four absences, each traced to its source
  file. The adopt read fits on one screen and says what
  the box IS, not what to do about it.
- Absences are findings: "no firewall rows" is the plan
  input for firewall-apply; "only routeros installed" is the STOP
  rule for container/UM/dude steps. An adopt read with
  no absences section skipped half the capture.
- Factory rows are not dirt: the disabled `unused-hs-chain`
  placeholders appear in a FRESH capture (proven here) —
  don't plan their removal, don't read intent into them.
- Coverage honesty (backup-restore-upgrade step 0): the export omits UM state,
  dude DB, cert bodies, file bytes. The adopt read states
  which omitted classes apply to THIS box and what extra
  reads would close them — or marks them unknown.

### 3. Plan from observed (the one allowed direction)

```text
# twin plan lines (each traces to O/A above):
P1: bind device (serial+arch+version) in inventory (network-workspace-bootstrap) <- O1 O4 manifest
P2: snapshot: export (have) + binary backup (backup-restore-upgrade)            <- A1
P3: register first-contact path                                                 <- O5
P4: stage monitoring (monitoring-alerting)                                      <- A2
P5: propose firewall baseline (firewall-apply) (approval)                       <- A3
P6: set identity via change-apply (approval)                                    <- A4
P7: STOP: O2 forbids container/UM/dude/cmr/wireless steps                       <- O2
```

- Grounded by construction: seven
  plan lines, every one carrying its capture citation. A
  plan line without a citation is an invention — cut it
  or ground it with a new read.
- Non-goals are part of the plan: no traffic claims
  (volatile stripped), no health posture (CHR), no owner
  intent. The capture shows STATE; the owner supplies
  INTENT. "The owner probably wants X" is never a plan line.
- The STOP rule is load-bearing: O2-style package/role
  facts forbid whole plan branches. State the forbid
  explicitly — it stops the next agent from proposing
  containers on a box without the package.
- capture → plan is the ONLY allowed direction. Writing
  or editing a capture to fit a plan is forgery: captures
  are evidence (claim discipline), and the
  checker's hashes are the seal. Re-pull, don't rewrite.

### 4. Import under approvals (writes — adoption ends here)

- Import = executing P-lines back onto the box. Each line
  runs under its own skill's procedure with its own
  approvals: backup-restore-upgrade snapshot, first-contact contact,
  monitoring-alerting probes, firewall-apply firewall proposal,
  change-apply identity. This skill
  does not contain a write procedure — it HANDS OFF to
  the ones that do.
- Order: snapshot (P2) before ANY write; reads/registry
  (P1, P3) anytime; behavior changes (P4–P6) twin-proved
  and approved. The plan's numbering IS the execution
  order — renumbering at execution time needs a reason.
- Post-import capture: re-pull after the import and diff
  against the adopt capture. The diff is the proof the
  plan landed — and the only honest "done" for an import.
- Production rule throughout: reads free, ANY write asks the
  developer first. Adoption (steps 0–3) asks nothing
  because it writes nothing; import (step 4) asks per write.

## Part 2 — Skill doc

### Trigger

Load when: onboarding an existing router or network; adopting
captures someone else took; writing a first plan for unknown
infrastructure; asking what a box can/cannot do; any
"where do we start with this network?" question.

### Prereqs

- centrs on PATH; target reachable for the pull
  (`first-contact` establishes the path when unknown).
- pull/ + checker.ts runnable (`cd pull && make test`
  green); `out/` local and git-ignored-equivalent
  (never published — no repo here, keep it that way).
- Know the device's last manifest (serial continuity) or
  be prepared to ESTABLISH the device binding deliberately.

### Access

- Steps 0–3 are reads + local compute: safe on any box,
  including production (pull-first is the polite opening).
- Step 4 is writes: production rule — ANY write asks first,
  per the owning skill's approval shape.
- Captures stay local: never print/commit/paste serials,
  IDs, addresses, or secrets from them. Cite paths +
  redacted facts (O/A/P lines), never raw values.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s; pulls of big boxes want 30s+ |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |

### Outputs

- Capture: `out/<device>/<ts>/` + `latest`, checker verdict.
- Adopt read: O-facts + A-absences, one screen, cited.
- Plan: P-lines with capture citations + STOP rule +
  non-goals. Owner intent recorded separately, never
  merged silently.
- Post-import diff (after step 4): adopt capture vs
  re-pull, the honest "done".

### Verification

- Checker `ok: true`, zero problems, on the adopted dir.
- Every P-line carries O/A citations; every A-line names
  its source file; STOP rule present.
- Re-pull diff after import matches the plan's intent
  (modulo volatile, which is stripped by design).
- No capture bytes outside `pull/out/`; no serials/IDs
  in any stored or posted text.

### Recovery

- Pull `partial` → adopt the files present, name the
  missing as unknowns, plan the re-pull (don't stall
  the whole adopt on one menu).
- Serial mismatch (exit 2) → STOP: same device, different
  box. Re-establish the binding deliberately, never by
  overwriting the manifest.
- Checker problems → the capture is unusable as truth:
  re-pull; if it persists, the box or the tool is at
  fault — diagnose, don't adopt around it.
- Plan line with no citation → cut it or ground it with
  a new read. Invention is the failure mode; the
  citation rule is the guardrail.

### Limits

- The pull shape covers export + 4 JSON menus: UM rows,
  dude DB, cert bodies, file bytes need their own reads
  (backup-restore-upgrade coverage audit) and stay unknown until then.
- Volatile is stripped by design: no traffic, counter,
  or behavioral claims from captures, ever.
- Device binding is trust-on-first-pull: the FIRST capture
  establishes the serial; verify the box out-of-band
  (label photo, console) when it matters.
- This skill adopts and plans; it never writes. Import
  mechanics live in change-apply + the owning skills.
