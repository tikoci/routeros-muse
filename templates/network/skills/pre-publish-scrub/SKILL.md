---
name: pre-publish-scrub
description: "Pre-public sweep before anything leaves the workspace: runtime state, identifiers by sensitivity tier, photo EXIF, synthetic fixtures, zero-findings gate. Use when: publishing a repo, sharing captures or notes, promoting private material to template, or asking 'is this safe to show?'."
topics: [privacy, secrets, hygiene, exif]
tested: none
---

# `pre-publish-scrub` skill (sweep → tier → gate → review) [template v1 draft]

Promoted from a real tunnel-token leak + redactor fix
(the setup guide's redaction section), the pull sanitizer + anchor tests
(sanitize.ts, pull.test.ts), the privacy tiers (decisions log),
and the staging rule. This skill names leak
vectors; it contains no leaked values.

## Part 1 — The checklist (nothing leaves without the gate)

Run top to bottom, in order. The gate (§3) is binary: findings =
no publish, no exceptions, no "just this once".

1. Sweep runtime state (§0): captures, logs, caches, shell
   history, and everything git-ignored that proves it was secret.
2. Tier every identifier (§1): low-sensitivity may travel, high-sensitivity never —
   sort each value you find, don't just grep-and-hope.
3. Run the zero-findings gate (§2): pattern sweep + redactor test
   + fixture rule, all green or no publish.
4. Stage, review, then publish (§3): clean-home staging, pair
   review, publish after both.

### 0. Sweep (runtime state first)

The leak that motivates this skill (privacy-tier
execution): the first full production export contained a live
Cloudflare tunnel token in a `/container/add env="..."` line — the
redactor only covered `/container/envs` lines. Caught by
spot-check, fixed the same session (inline env= K/V redaction +
anchor test), re-pulled clean, leaky capture dir deleted, repo-wide
grep confirmed no token remained. Lessons encoded here:

- Captures are guilty until scrubbed: `pull/out/` holds REAL
  network data (serials, public IPs) — local-only, git-ignored on
  promotion, never committed. The gitignore is the first scrub
  artifact: anything ignored is CONFIRMED secret, not "probably
  fine to show".
- Sweep list before any publish: capture dirs, QEMU/machine state,
  tool caches carrying device data, shell histories with
  credentials in argv (use env vars per agent-access-bootstrap so
  there's nothing to sweep), local handoff drafts, /tmp flowsheets.
- Router-side residue counts too: test users/groups/scripts left
  on a box travel with its next export. Every proof run ends
  pristine-verified (the proof teardown shape) — the scrub
  re-verifies, it doesn't assume.
- Photos are runtime state: label photos (netinstall-flash:
  "MAC comes from the label photo"), install photos, screenshots
  of WebFig/WinBox. No images exist in this tree today (find for
  png/jpg/heic returns nothing) — the photo half of this skill is
  prescribed-but-pending until the first photo lands.

### 1. Tier (the privacy tiers decide, not vibes)

The privacy tiers (decided 2026-10-28):

- LOW-sensitivity — may travel: device models, MACs, private IPs,
  software keys. (Still minimized: travel only what the reader
  needs, not everything captured.)
- HIGH-sensitivity — never: people names, location, public IPs,
  credentials, secrets, and CLUES (anything that reconstructs the
  high tier: DDNS names, tunnel hostnames, QR contents, exact
  firewall holes).
- Tiering is per-value, not per-file: a "clean" note with one
  pasted public IP is dirty. Sort each identifier you find into a
  tier; anything un-tierable is HIGH until proven otherwise.
- Two field rules that override flags: `/export` prints container
  env values in CLEAR even without show-sensitive
  (the pull redacts them anyway), and the router log repeats env
  values on every `/app` change. "Safe to share" is a TESTED
  TRANSFORMATION, never a flag.

### 2. Gate (zero findings or no publish)

Three checks, all green, quoted in the publish record:

1. **Pattern sweep.** Repo-wide grep for secret shapes over the
   publish set: `(password|passwd|secret|passphrase|private-key|
   community)=` values, `(pass|secret|token|key|pwd|credential)`
   env names, `BEGIN .* PRIVATE KEY`, 44-char base64 key shapes,
   public-IP shapes outside documented examples. Zero findings
   or no publish. (The sanitizer's SECRET_KEY/ENV_SECRET_NAME in
   sanitize.ts is the starting pattern list — the gate and
   the redactor share it so they can't drift apart.)
2. **Redactor test.** `pull` anchor tests green (redact, header-
   stable, volatile-strip, sha256, serial gate) — the redactor is
   code with tests, and the gate runs them. A redactor change
   without its anchor test fails the gate by construction.
3. **Fixture rule.** Publishable examples use SYNTHETIC fixtures,
   never scrubbed captures: checker tests build "pure tmp-dir
   fixtures, no router" (checker.test.ts) — that line is the
   pattern. Scrubbed-real is for internal records; published
   examples are born synthetic. TEST-NET addresses (203.0.113.x)
   for anything address-shaped.

The incident precedent for "gate passed": "repo-wide grep
confirms no token remains on disk" — quoted in the session note,
not assumed from the fix.

### 3. Stage + review (clean home, second pair of eyes)

- Stage-as-if-soon in a clean home: the promotable subset
  (templates/network/ + tools/ + docs) copied minus build-notes cruft, scrub
  pass AT staging. The staging copy is what the gate
  runs over — never gate the live tree and publish a copy.
- No legacy/undone-concept garbage travels: dead drafts,
  superseded notes, and "maybe later" files stay behind. Cruft is
  where stale secrets hide.
- Pair review before GitHub: a second agent (or the
  developer) re-runs the gate and spot-checks the tiering.
  Review stays async — post the staging for review, don't wait
  on it, and never publish while review is pending.
- Publish record: what was published, from which staging, gate
  outputs quoted, reviewer named. The record itself is tiered
  (staging paths are internal; the public tree is public).

## Part 2 — Skill doc

### Trigger

Load when: publishing anything (repo, gist, doc, screenshot);
sharing captures, notes, or ledger entries outside the workspace;
promoting private material toward templates/network/; "is this safe to show?"
questions; after ANY suspected leak (this skill + incident-
response together). (Entry-skill + capability-probe pattern.)

### Prereqs

- The publish SET defined: exact paths, exact destination. "The
  repo" is not a set — name the tree.
- Sensitivity tiers internalized (low travels, high never, clues are
  high). When in doubt, HIGH.
- Write access to a staging area outside the live tree.

### Access

- The scrubber may READ everything in the publish set, including
  secrets — that's the job. Findings travel by SHAPE ("token in
  export line 41"), never by value, in every message about them.
- Staging areas are local-only until published; a staging copy
  with findings is handled like a capture (delete after the fix,
  re-stage clean).
- Leaked-live-secret response: rotate FIRST (verify new works,
  old fails), then scrub, then write up the anomaly. Scrub
  without rotation is theater.

### Envs

| Name | Use |
|---|---|
| (none) | The scrub is grep + tests + review; it needs no environment. |

### Outputs

- Tiered findings list (per value: LOW/HIGH + disposition).
- Gate transcript: pattern sweep (zero), redactor tests (green),
  fixture attestation (synthetic).
- Staging location + pair-review request.
- Publish record (after review): what, from where, gate quoted,
  reviewer named.

### Verification

- Gate re-run green on the STAGING copy, quoted in the record
  (not "ran earlier on the tree").
- Spot-check: reviewer opens three random files and tiers what
  they see; any HIGH found = gate process failed, restart it.
- Post-publish: the public artifact fetched fresh and grepped
  once (publish pipelines inject surprises).
- No `out/`, machine-state, or history files in the published
  set — verified by listing, not by gitignore faith.

### Recovery

- Finding mid-publish: stop, fix at the SOURCE (redactor rule +
  anchor test if it's a class, not a spot deletion), re-stage,
  re-gate from zero. Never patch the staging copy by hand and
  call it gated.
- Live secret already published: rotate immediately, purge the
  artifact if the platform allows, write up the incident
  (redaction-incident precedent). Speed beats completeness in
  the first hour; completeness follows.
- EXIF/photo leak (no precedent yet — first occurrence writes
  this row): strip metadata (`exiftool -all=` or re-export),
  verify with a metadata read-back, add the photo pipeline to
  the gate. Until then: no photos publish without a stated
  metadata check.
- Gate keeps finding new classes: the pattern list grows in
  sanitize.ts WITH anchor tests — the gate improves, it doesn't
  get waived.

### Limits

- Grep-class scrubbing catches KNOWN shapes: novel secret
  formats (new token prefixes, QR payloads, steganographic
  anything) pass silently. Pair review + minimization are the
  backstop, not the patterns.
- EXIF/photo half is prescribed-but-pending: no images in tree,
  no executed strip-and-verify. First photo grounds it.
- The tiers are a decision, not physics: "models may travel" can
  still identify a network in combination — minimize even LOW.
- This skill gates publication; internal handling (captures
  local-only, creds never in notes) is the standing rule that
  makes the gate passable. A workspace that leaks internally can't
  scrub at the boundary.
