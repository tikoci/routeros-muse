---
name: unbox-provision
description: "Provision a new box end to end: bind device/label/serial from the sticker, render the baseline from plan, twin-proof it, apply on the bench, first pull. Use when: unboxing hardware, adding a device, reprovisioning from scratch, or asking where provisioning ends and managing begins."
topics: [provisioning, inventory]
requires: [twin]
tested: twin-run
---

# `unbox-provision` skill (bind → render → twin-proof → apply → first pull) [template v1 draft]

Unbox and look-after are different products: provisioning
is wholesale, human-hands, destructive-by-design; management is
incremental, remote, read-first. This skill owns the unbox side
up to the boundary commit ("first pull") and then hands off.
Fold-ins carried as sections: sticker-identity-bootstrap,
photo-to-plan-device-onboarding, unbox-baseline-render,
configure-from-plan-twin-first, unbox-import. Claim labels:
observed = a CHR twin drill 2026-10-30;
collected = corpus cites; pending = honestly unrun. No
secrets below; identifiers redacted to hashes.

## Part 1 — The checklist (hands first, then the twin, then the box)

Run top to bottom. Steps 1–4 need no live box except the
twin; the new hardware is touched at step 5, read at step 6.

1. Bind device/label/serial: the sticker writes the serial
   into the device; the router proves itself from then on.
2. Photo-to-plan: read model/serial/MAC from the label
   photo with the password region masked before any cloud call.
3. Render the baseline from plan: device + plan become the
   full bench script, secrets as placeholders only.
4. Twin-proof the render: the exact render runs on a twin
   at matching firmware; read-back must match intent.
5. Apply on the bench + install sheet: netinstall, reset,
   or staged-script — plus the sheet for the hands on site.
6. First pull + boundary: pull, checker-verify, commit
   "first pull". Unbox ends; look-after begins.

### 0. Sticker-identity bootstrap (device vs label vs serial)

- The rule (collected, from an earlier field run): the device ID names
  the JOB (`<site>-<location>-<role>`); the label is what
  is on the UNIT; the serial binds hardware to device at
  unbox. A device outlives the hardware in it (concept
  review §10: "the AP serving this room" vs "the unit
  installed there").
- The write is one record per device — copy
  `references/device-record.example.toml`: device, label
  model/serial/MAC, bound-at, bound-by, a password POINTER
  (`private/<device>.txt`), render + first-pull dates.
- Observed (the twin drill): CHR has no routerboard and no
  sticker, so identity is the license system-id and the
  label fields stay honestly N/A. pull.ts stores the
  binding as `system-id:<id>`; the drill
  verified manifest serial == `system-id:`+license id
  (binding-match True). First bare-id compare mismatched —
  the prefix rule is load-bearing, re-verify it, don't
  bypass it.
- Collected reconciliations (from pilot feedback):
  identifiers from the photo are still checked
  against the CONNECTED device; once connected the router
  reports its own model and even regulatory SKU
  (journaled: `/interface/wifi/radio countries`).
- Red line (collected, brief + grounds): the sticker's
  default password is a credential. Precedent (from pilot
  feedback, VERIFIED): sticker passwords sit in a per-device
  git-ignored file AND the harness denies reading it.
  Never in the ledger, never in a capture, never pasted.

### 1. Photo-to-plan device onboarding (PENDING on CHR)

- Collected pipeline (onboarding scenario, platform-explainer
  SAM §): holder photographs the label → SAM 3.1 segments
  the sticker region → vision/OCR reads model + serial +
  MAC → Rosetta resolves the exact hardware profile
  (ports, radios, version constraints) → device bound, twin
  shaped, install sheet produced.
- Masking is BEFORE the first cloud call INCLUDING
  segmentation (design-review rule): the password region
  never leaves the device unmasked. If the segmenter
  only runs in-cloud, the photo with the password goes
  nowhere — low-risk fallbacks (from an earlier field run): tape over
  the password before the photo, or on-device crop to
  identifiers-only first.
- SAM segments; it does not read text (from an earlier field run):
  reading is the vision model's job. Don't promise OCR
  from the segmenter.
- Photos carry location (from pilot feedback): strip EXIF GPS
  before any photo enters a shared folder or cloud model —
  unless location IS the point (siting), and then keep it
  out of public material.
- Pending: unexecuted on CHR (no sticker). Status stays
  PENDING SAM spike; the drill bound via license identity
  instead. Install-sheet + device-binding halves are
  journaled-by-hand.

### 2. Unbox-baseline render (plan → bench script)

- Collected shape (from pilot feedback, VERIFIED commit
  history): structural changes start in TOML; `render`
  turns a device into a FULL netinstall script —
  secrets stay placeholders, filled only in the copy
  that is uploaded; `stage` uploads to the netinstall
  server with the harness asking the human first.
- Baseline contents (collected, from pilot feedback): agent
  accounts (reader + admin), management access,
  `/system/note` shown at login, time + DNS,
  `device-mode` for bridge needs, the bridge itself
  where hardware allows. After the render every device
  is "in TOML" and look-after skills assume the baseline.
- Shape example: `references/baseline-render.example.rsc`
  (executed identity+note subset on top, prescribed
  remainder commented with OWNER-FILL + placeholder-only
  secrets; test.sh enforces both).
- Observed subset (the twin drill): identity+note staged as
  ONE `/system/script` (`unbox-baseline`, `;`-separated,
  quote-free args → `*1`), run positionally, read back
  exact. The twin executed the MECHANISM; accounts,
  access, time, DNS, device-mode are prescribed, not run.
- Inferred: where the main router is hand-built rather
  than rendered (from pilot feedback), the exception is named,
  not silently absorbed — the render covers the fleet
  shape.

### 3. Configure-from-plan twin-first (twin-first discipline)

- Collected: from the workspace plan,
  configure management access, agent accounts, the note
  convention, and services — TEST on a twin first, then
  apply with approval, then check the real service (a
  phone signs in and lands on the right VLAN, not "the
  config applied").
- Observed mechanics (the twin drill + change-apply): build
  the EXACT script body, WIP flag set first, stage, run
  positionally (`numbers=` is rejected on run/), read
  back against intent, remove script + artifacts, clear
  WIP. Mismatch = stop, artifact is evidence, no blind
  cleanup.
- Twin choice (twin-ops): EXACT firmware + packages of
  the target; verify package + disk before trusting.
  Twin results state CHR limits every time: no
  radios, x86-only packages, no routerboard menus.
- Inferred stop rule: a render the twin rejects (bad
  parameter, missing package) never reaches the bench —
  fix the PLAN, re-render, re-proof. The bench is not a
  debugger.
- Pending: multi-device render (VLAN + RADIUS + AP as
  RADIUS client) needs staged endpoints; the
  drill proved single-box mechanics only.

### 4. Bench apply + install sheet (hands on site)

- Collected routes: several
  provisioning routes exist — netinstall, a reset script,
  or step-by-step changes. Collected order (from pilot feedback): reset or
  netinstall on
  the BENCH, install sheet for the person on site, then
  first pull. Lockout on the bench is expected and
  cheap (the bench-vs-manage table) — that is WHY the bench
  exists.
- Observed route (the twin drill): staged-script apply
  (steps above). Netinstall/reset paths prescribed, not
  exercised here — netinstall-flash owns the
  netinstall-package flow when it lands.
- Install sheet (collected, from pilot feedback): IKEA-style —
  what goes where, what comes out, how to tell it
  worked. (DESIGN): after install, the holder
  photographs the wiring and the agent checks it against
  the sheet ("ether2 vs ether1") — no credentials in
  frame, a natural vision job.
- Approval shape at unbox (collected, from pilot feedback):
  "reset this device and install the render" is
  NORMAL at unbox and alarming in look-after — separate
  entry skills, separate policy classes. Stage/upload
  asks the human (harness ask-class); destructive bench
  acts are routine here, never silent.
- Pending: no sheet rendered this drill; sheet shape is
  collected, production is future work.

### 5. First pull + boundary (unbox-import)

- Observed (the twin drill): fresh device, `pull.ts` →
  status ok, 5 files, CHR identity note; `checker.ts`
  → ok true, 2739 bytes, 0 problems; drill markers
  present in export.rsc (3 hits). Trust-on-first-pull
  establishment — exactly the unbox case. Serial
  continuity is now ARMED for the next pull.
- The boundary is a commit message (collected, feedback
  §3): "netinstalled …, first pull". From the first
  pull on, every device has intent (TOML) AND evidence
  (pulled state), and the look-after loop applies:
  check note, explain offline, execute with approval,
  read back, pull, diff, record.
- Existing networks DON'T unbox (collected, feedback
  §3): the import path (import-existing-network) is
  a first pull plus questions to the owner — NO
  reinstall. Many owners only ever do look-after; make
  the import path explicit and never reinstall a box
  just to adopt it.
- Teardown observed (the twin drill): script removed,
  identity + note restored to pre-state (CHR / empty),
  45 file names identical to pre-state, the twin stopped,
  bench as found. Other packages untouched (no
  /user-manager, /disk, /file writes during the drill).
- Inferred: a first pull that fails (serial won't bind,
  checker problems) keeps the box OUTSIDE the managed
  set — no intent is written for an unproven box.

## Part 2 — Skill doc

### Trigger

Load when: unboxing hardware; adding a device to inventory;
reprovisioning from scratch; rendering a baseline; asking
where provisioning ends and managing begins; any "new box,
where do we start?" question. Do NOT load for existing
networks — that is import-existing-network.

### Prereqs

- Device named (`<site>-<location>-<role>`) or N=1 single
  file; plan/TOML intent for the device (zero ceremony:
  one router.toml + one observations/ folder suffices).
- A twin at the target firmware for step 3
  (`quickchr list`; never remove shared twins or retained evidence specimens).
- Bench access for step 5 when hardware is real
  (netinstall server or console); camera for steps 1–2
  with EXIF/GPS handling decided up front.
- pull/ + checker.ts runnable for step 6.

### Access

- Steps 1–4: reads + local compute + twin writes. Twin
  writes need no approval; other sessions' running twins
  are read-only (twin-ops non-disturbance).
- Step 5 bench: destructive-by-design is NORMAL here —
  but staged uploads + bench resets still ask the human
  (harness ask-class); this skill never self-approves.
- Step 6: reads only. Captures stay local (`pull/out/`);
  never print/commit/paste serials, IDs, MACs, addresses.
- Sticker passwords: git-ignored per-device file, harness
  denies reading (pilot-feedback precedent). Refuse any flow
  that would log, ledger, or cloud-send them.

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s; bench-apply runs want 30s+ |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` bench targets |
| `QUICKCHR_SHUTDOWN_TIMEOUT` | Overrides default 10s twin shutdown wait |

### Outputs

- Device record (TOML): device/label/serial/bound-at/bound-by
  + password pointer + render/first-pull dates.
- Baseline render: full bench script, secrets as
  placeholders; twin proof (machine + date + commands).
- Bench result: applied render + install sheet for site hands.
- First pull: capture dir + checker verdict + boundary
  commit ("first pull"); armed serial continuity.
- Import-path decision for existing boxes: import-existing-network, no reinstall.

### Verification

- Every device record names bound-by (sticker-photo |
  console-read | first-pull) — an unbound device is pending.
- Render secrets grep clean (placeholder-only); test.sh
  enforces this on the example, the agent enforces it on
  the real render.
- Twin read-back matches intent exactly before ANY bench
  apply; twin proof states CHR limits.
- Checker ok:true, 0 problems, on the first pull; drill
  markers (or real render lines) present in export.rsc.
- Post-drill twin pristine (scripts {}, identity/note
  restored, file set unchanged) or deliberately kept
  with a record.

### Recovery

- Pull `partial` → adopt files present, name missing as
  unknowns (import-existing-network step 1); re-pull plan.
- Serial mismatch (exit 2) → STOP: wrong box for the
  device. Re-establish deliberately, never by overwriting.
- Twin rejects the render → fix the PLAN, re-render,
  re-proof. The bench is not a debugger.
- Bench lockout → expected on the bench: console/
  netinstall again, fix the render, note the lesson.
- Password-region leak (photo sent unmasked) → treat as
  a credential incident: rotate the default password at
  first contact, scrub the image from shared stores.

### Limits

- Photo onboarding is PENDING: collected
  procedure, journaled-by-hand halves, no executed run.
  Never claim a masking guarantee you didn't execute.
- Full baseline beyond identity+note is prescribed, not
  twin-proven here; netinstall/reset routes not exercised.
- CHR proof never claims hardware truth: no radios, no
  sticker, x86-only, timing differs. Hardware proof needs
  hardware or explicit owner-accepted risk.
- This skill provisions; it never manages. After the
  boundary commit, look-after skills own the box — and
  "reset and reinstall" becomes alarming again.
