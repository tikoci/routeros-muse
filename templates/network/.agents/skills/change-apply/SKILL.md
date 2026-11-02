---
name: change-apply
description: "Apply a router change the safe way: twin-proof, propose, stage as /system/script, human-run, read back, clear WIP. Use when: any write to a router (config change, key install, service enable), staged-script questions, or approval-flow work."
topics: [change, approval]
tested: none
---

# `change-apply` skill (propose → stage → run → read back → clear) [template v1 draft]

Promoted from the twin-proven staged-script mechanics (a full
stage/run/read/remove cycle executed on a 7.26beta3 CHR twin) plus
the approval-wrapper design and WIP-flag convention. The
MECHANISM is proven; this playbook wraps it in routine procedure.
No secrets below.

## Part 1 — The checklist (prove it, then change it)

Run top to bottom. No write touches a non-twin box before step 2
passes on a twin AND step 3 has owner approval.

1. Prove the change on a twin first: build the exact script body,
   run steps 4–7 against a twin, and confirm read-back matches intent.
2. Write the proposal: what changes, why, blast radius, rollback read
   (the command that proves the old state is restorable), and the twin
   evidence (machine + date + command + output).
3. Get owner approval on non-twin boxes: production rule — reads free,
   ANY write asks first. Approval names the script; the run is
   restricted to that planned name.
4. Set the WIP flag, then stage: `/system/note` note set first
   (coordination, not a lock), then `/system/script/add` the body.
5. Run positionally and read back: `/system/script/run <name>`
   (positional arg — `numbers=` is rejected), then `:put [/file/get
   X contents]` and compare against the proposal's expected text.
6. Clean up and clear: remove script + artifact files, verify the box
   is pristine, clear the WIP flag. Record command + output in the ledger.

### 0. Shape of a safe change

- Every change is a staged `/system/script` with a planned name, run
  once, read back, and removed. No ad-hoc writes, no interactive
  edits, no persistent helper scripts left behind.
- Twin-proof is mandatory for anything not yet run on that exact
  firmware: kept twins exist for this; never delete a twin others
  rely on — make your own dirty-work box for destructive probes.
- Claim discipline: a twin pass is not permission and approval
  is not correctness. Twin results state limits (no radios on CHR,
  x86 package gaps vs ARM hardware).

### 1. Stage (write, needs approval on non-twins)

```sh
centrs execute --quickchr <twin> \
  '/system/script/add name=<plan-name> source="..."' --yes
# -> {"ret": "*1"}
```

- Grounded in the twin run: `/system/script/add
  name=drill-staged source="/export file=drill-staged"` returned `*1`.
- Keep the source body ASCII-clean and comma/quote-simple; complex
  quoting breaks across the CLI transport (same lesson as the /app
  `cmd` quirk).
- Set the WIP flag BEFORE staging on a shared box: `/system/note/set
  note="WIP: <plan-name> <date>"`.
  Empty note means well; clear it at the end.

### 2. Run (write — POSITIONAL arg)

```sh
centrs execute --quickchr <twin> '/system/script/run <plan-name>' --yes
# -> {"ret": ""}
```

- Grounded in the twin run: positional works.
- `/system/script/run numbers=<name>` FAILS with
  `validation/unknown-attribute` (RouterOS: bad parameter numbers).
  This was the documented-wrong syntax; the correction is proven.
  Do not "fix" it back.
- Timeout: default execute timeout is 10s (`CENTRS_TIMEOUT`); a
  long-running script dies mid-payload silently. Pass `--timeout 30s`
  for anything over ~8s.

### 3. Read back (read — the proof step)

```sh
centrs execute --quickchr <twin> ':put [/file/get <artifact>.rsc contents]'
# -> {"ret": "<full text>"} (proven exact to 24 KB)
```

- Grounded in the twin run: 401 B real export plus 4 KB and
  24 KB synthetic blobs returned byte-exact. Production-class exports
  (~20 KB) are covered by the same primitive.
- Bonus: `/file/print` returns `contents` inline for small files.
- Compare read-back against the proposal's expected text. Mismatch =
  stop, investigate, do NOT proceed to cleanup-blind; the box state
  is unknown until read-back matches.

### 4. Clean up + verify pristine (writes)

```sh
centrs execute --quickchr <twin> '/system/script/remove numbers=<plan-name>' --yes
centrs execute --quickchr <twin> '/file/remove numbers=<artifact>.rsc' --yes
# numbers= WORKS for both removes (only run/ is positional)
```

- Grounded in the twin run: both removes accept `numbers=`;
  post-run `script/print` empty and `file/print` showed only the
  pre-existing `skins/` dir (twin left pristine).
- Clear the WIP flag: `/system/note/set note=""`. Verify empty.
- Final verify: re-run the read that motivated the change (identity,
  target menu) and confirm the intended state.

## Part 2 — Skill doc

### Trigger

Load when: any write to a router is planned (config change, key
install, service enable, package op); staged-script questions; the
approval flow needs its enforcement half. (Entry-skill +
capability-probe pattern.)

### Prereqs

- centrs on PATH; target reachable (run `first-contact` first on any
  box not yet in the device registry).
- A twin at matching firmware for the proof run (`quickchr list`
  shows it running); never delete a twin others rely on.
- The proposal written: change, why, blast radius, rollback read,
  twin evidence. No proposal = no run on non-twins.

### Access

- Twins: anything goes ( Twin-proof runs need no approval).
- Production: reads free; ANY write asks the developer
  first — including staging the script, not just running it.
- Multi-step work on a shared box: WIP flag set first, cleared after
  — coordination convention, not a lock.
- Operator Unknown → ask before any write.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s execute timeout; raise to 30s for long scripts |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |
| `CENTRS_SSH_KEY` | Batch SSH key path (key-only, never password) |

### Outputs

- Proposal record: change/why/blast-radius/rollback-read/twin-evidence.
- Twin evidence: machine + date + exact commands + outputs.
- Production run record: staged name, run output, read-back text,
  cleanup verification, WIP cleared.
- On mismatch: stop report (expected vs observed, box state unknown).

### Verification

- Read-back text matches the proposal's expected text exactly.
- Post-run `script/print` shows no leftover; `file/print` shows only
  pre-existing entries.
- `/system/note` empty after the run (WIP cleared).
- Claim discipline: every claim carries command + output.

### Recovery

- `validation/unknown-attribute` on run → you used `numbers=`; switch
  to the positional form (step 2). Do not retry `numbers=` variants.
- Silent mid-payload death → timeout kill; retry with `--timeout 30s`.
- Read-back mismatch → STOP. Do not clean up blind: the artifact file
  is evidence. Re-read, compare, escalate with expected vs observed.
- Wedged state on a twin → rebuild the twin (disposable); on
  production → escalate to the developer with the full run record.
- Redaction: scrub `password|secret|private-key|community` + inline
  `env="K=V"` values from any stored output.

### Limits

- The approval CARD (phone experience) is designed, not built;
  until it lands, approval is a developer message, and enforcement is
  this procedure's discipline (planned-name-only runs).
- Twin-proof covers CHR behavior only: no radios, x86-only packages,
  CHR lacks `/system/routerboard` (use license system-id for identity).
- Script source quoting across the CLI transport is fragile: keep
  bodies simple; test the exact body on the twin, never a paraphrase.
- Never leave helper scripts or artifact files on production; the
  pristine-verify step is mandatory, not optional.
