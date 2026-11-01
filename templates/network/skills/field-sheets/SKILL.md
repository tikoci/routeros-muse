---
name: field-sheets
description: "Turn the plan into physical actions for hands on site: per-location sheets with labels, ports, compass-words aiming, and every step carrying an expected result plus a stop condition. Use when: sending someone to a pole, cupboard, or bench; checking installed work; or closing a hands loop with photos."
topics: [fieldwork]
tested: self-test
---

# `field-sheets` skill (records → sheet → hands → evidence → records)

Backlog #18. The plan lives in records; the person on the
pole cannot read TOML. This skill translates one location
at a time into a sheet that says what goes where, what
comes out, and how to tell it worked — and it holds the
line the other way: a checked box is not proof a cable
moved. Sources: concept review §10 (field sheets), the
showing-the-owner note §2 (setup sheets), feedback §3
(install sheet), demo catalog U2 (install photo check),
K25 (human-artifact-agent loops). No twin, no box writes:
records reads + local rendering only. Fixtures synthetic.

Boundaries (stated both ways so nothing is absorbed
silently): #16 map-reports owns the render primitive
(`?p=N` single-page render + headless screenshot + print
HTML from the same records) and photo FILING (unchanged
bytes + sha256 + EXIF index + recorded GPS error +
photos-are-not-pins). THIS skill owns sheet CONTENT (the
IKEA-style per-location page, what-plugs-into-what,
compass-words aiming, "how to tell it worked", "if not,
stop and send a photo") and the sheet the photo is
checked against. Topology questions belong to #45.

## Part 1 — The checklist (every step proves itself or stops)

Run top to bottom. A sheet that cannot say "how to tell
it worked" or "when to stop" does not reach hands — the
reference renderer rejects it mechanically.

1. Derive the sheet from records: device record → devices,
   labels, ports, aiming, revision (step 0).
2. Write for hands: labels as printed, ports as seen,
   aiming in compass words, one picture idea (step 1).
3. Give every step an expected result AND a stop
   condition — no exceptions (step 2).
4. Render + deliver: phone PNG and/or print HTML,
   offline-capable (step 3).
5. Close the loop: confirmations and photos flow back
   into records; corrections regenerate (step 4).

### 0. Derive (device in, sheet out — never hand-authored)

- Source is the device record: device labels (K9: label
  is what is on the unit), port maps, aiming data,
  install state. The sheet carries the device id plus a
  revision id so a photo of an old sheet cannot pass
  as a new one.
- One location per sheet: a pole, a cupboard, a bench
  position. Someone at a pole needs different paper
  than someone reviewing alternatives — derive the
  right artifact for the immediate task (§10 rule).
- Regeneration beats editing: any record correction
  re-renders the sheet with a new revision. Hand-
  editing a generated sheet is forgery of evidence.
- Observed (self-test): `references/render-sheet.py`
  renders the 2-location synthetic fixture (pole +
  cupboard) and rejects a spec whose step lacks a
  stop condition.

### 1. Write for hands (plain words, observable facts)

- Labels as printed on the unit ("labeled AP-POLE-1
  on the unit"), ports as seen ("ether1 ← cable from
  the ground box"), aiming in compass words ("faces
  northeast toward the barn roof"), never degrees
  alone. Collected shape: IKEA-style, one page per
  location (showing-the-owner §2).
- Say what stays untouched, not just what moves:
  "SFP ← empty (do not plug anything here)" and
  "ether2 → house router (do not unplug)" prevent
  the two most common hands errors — helpfulness
  and tidiness.
- One picture idea per sheet: what a confirmation
  photo should show (LED row, label close-up, phone
  screen at the gate). The photo is evidence for a
  step, not decoration.
- No RouterOS commands on the sheet, no TOML, no
  device-id algebra. If the sheet needs a command, the
  plan is wrong — hands does physical actions; the
  agent does the typing later from the evidence.

### 2. Expected + stop (the contract — every step, both halves)

- Expected result: the observable success check —
  "power LED turns solid green within 60 seconds",
  "two bars or better on a phone held at the gate".
  Observable by the person holding the sheet, with
  a time bound where waiting matters.
- Stop condition: "if this does not happen, stop and
  report this observation" (§10 recommendation) —
  "no LED after 90 seconds — unplug, photograph the
  ground box LEDs, report". A stop names what to
  leave as-is (usually: everything), what to capture
  (usually: a photo), and what to send (photo +
  revision id). Observed: the fixture's 3-step pole
  sheet carries 3 expected + 3 stop lines, asserted.
- No silent retries past the stop: one named retry
  ("try the spare cable from the hook once") is a
  step, not improvisation. Past that, hands stops
  and the agent re-plans from the evidence.
- The agent MUST NOT treat a checked box as remote
  verification of a physical act (§10: do not assume
  the agent can verify a cable move remotely merely
  because the person checked a box). Confirmation is
  photo + reading, or it is pending.

### 3. Render + deliver (the owner's phone is the screen)

- Phone PNG first: 1080×1350 portrait per page
  (showing-the-owner §2: iMessage/RCS-ready), one
  PNG per location. Print HTML from the same spec
  for the bench. Observed: fixture page renders
  1080×1350, non-blank, zero external refs (offline
  capable — the pole has no Wi-Fi yet).
- The render primitive is #16's (`?p=N` + headless
  screenshot); this skill's renderer follows the
  same flags so sheets and maps come out identical
  in size and handling. Same records, right screen.
- Deliver with the revision spoken aloud: "sheet
  rev fx-2026-10-31-01, two pages". Old pages stay
  open on phones — the revision is the only thing
  that tells them apart (Fix-GPS lesson, §10).

### 4. Close the loop (evidence in, corrections out)

- Confirmations land as evidence: photo + step +
  revision id, filed per #16 (unchanged bytes,
  hash, EXIF index, recorded GPS error). The photo
  completes the step it was taken for — and only
  that step.
- Corrections regenerate: "the switch is in the
  other room" updates the RECORD, re-renders the
  sheet, new revision, old sheet retired. The loop
  is human → artifact → agent → structured record
  (K25); the page emits feedback without permission
  to change the network.
- "Done" means every step's expected result held
  with evidence attached. Anything else is an open
  loop with a named next holder (hands or agent),
  never a silent partial.

## Part 2 — Skill doc

### Trigger

Load when: sending hands to a site; writing an install
or check sheet; reviewing install photos against a
sheet; or answering "what do I do when I get there".

### Prereqs

- Backlog #18 + the device record(s) for the location.
- Concept-review §10 + showing-the-owner §2 read
  (the procedure's sources).
- python3 + headless chromium for the reference
  renderer (stdlib + browser only, offline).
- A named hands contact for delivery; steps 0–3
  need no hands present.

### Access

- Records reads + local rendering only: safe
  anywhere, including beside production. No twin,
  no box contact of any kind.
- Sheets may carry location-revealing detail
  (photos, aims, layouts) — handle finished sheets
  like pulls (local-only, redacted citation) until
  the owner says otherwise. Fixtures are synthetic.

### Envs

No environment this skill consumes. Delivery channel
(chat, print, message) is chosen per run and leaves
no state in the skill.

### Outputs

- Sheet spec (JSON: revision + locations, validated).
- Rendered sheets (phone PNG per location + print
  HTML), revisioned, offline-capable.
- Filed confirmations (photo + step + revision).
- Record corrections where hands disagreed (with
  regenerated sheets).

### Verification

- Renderer accepts the spec (every step carries
  expected + stop; devices labeled; revision set).
- Rendered page carries device, labels, ports,
  compass-words aiming, both halves of every step,
  revision, and zero external refs (self-test
  asserts all of these mechanically).
- PNG is 1080×1350 and non-blank (same primitive
  as #16/#52/#55).
- Every "done" step has evidence filed against its
  revision; open loops name their holder.

### Recovery

- Spec rejected → fill the named gap (usually a
  missing stop); do not ship a sheet the renderer
  refuses.
- Hands reports a stop → treat as evidence, not
  failure: re-plan from the photo + revision, re-
  render, new revision.
- Wrong-revision evidence arrives → file it under
  its own revision, say what changed since, and
  re-confirm the affected steps on the new sheet.
- Sheet and site disagree → the site wins until
  re-surveyed; the record updates, the sheet
  follows, never the reverse.

### Limits

- No real-hands run yet: renderer + contract are
  proven on synthetic fixtures; first pole/cupboard
  use ratifies the wording (reading level, step
  granularity, photo discipline).
- A sheet cannot verify itself: checkbox ≠ proof,
  photo of the wrong thing ≠ proof. The agent's
  verification standard is evidence per step.
- This skill owns sheet content + contract; render
  primitive and photo filing stay with #16, maps
  with #16/#51, topology with #45. Handoffs named.
- Sheets describe physical acts only. Anything the
  owner must approve on the network goes through
  `change-apply`, never through a sheet step.
