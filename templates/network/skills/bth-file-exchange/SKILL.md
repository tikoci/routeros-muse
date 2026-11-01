---
name: bth-file-exchange
description: "BackToHome Files as the zero-setup exchange rung: LAN-side and human file drops over the MikroTik relay, append-only, plain-HTTP scheme. Use when: moving files between owner and agent without new accounts, handing a human a share link, or staging envelopes for the mailbox path."
topics: [bth, mailbox, lan]
tested: none
---

# `bth-file-exchange` skill (share → drop → list → fetch) [template v1 draft]

Promoted from the BTH Files design (connectivity notes: scheme
from forum topic #181789), the live access matrix (A recon: relay
refuses the sandbox, works from residential nets), bigdude's BTH
presence (orca-setup), and fresh-CHR menu probes
(t28-cf-proof.md). Backlog #35. No secrets below; share URLs are
bearer-shaped and never quoted with real IDs.

## Part 1 — The checklist (a share link, nothing to install)

Run top to bottom. BTH Files is the rung with zero new accounts
and zero new infrastructure: a directory on the router, a relay
URL, a plain-HTTP scheme.

1. Confirm the habitat can reach the relay (§0): LAN-side and
   residential yes, cloud sandbox no — matrix first.
2. Create the share (§1): directory + upload flag on the
   router (collected shape — first creation grounds it).
3. Exchange files (§2): list / download / upload over plain
   HTTP, append-only discipline.
4. Close or hand off (§3): share link to the human, or envelopes
   to the mailbox path; revoke by removing.

### 0. Reach (matrix first, share second)

Live access matrix (measured, not assumed):

- From residential networks / LAN-side agents: the relay works
  (brief §hard-blocks: "working fine from residential networks";
  Safari reaches the BTH share fine on a real network). This is
  the habitat the rung is FOR: Muse Code on the owner's Mac,
  any LAN-side agent, and humans with browsers.
- From the Muse-app sandbox: the relay REFUSES — connection
  closed before any HTTP response, from curl/Python/Chromium
  alike (brief §hard-blocks; A recon §2). BTH Files cannot be
  the cloud agent's rung today. When reach differs by habitat,
  that's data: record which habitat each result came from.
- The relay host's real DNS (single A record, TTL 60, from a
  real network) vs sandbox fake-IP answers: never treat a
  sandbox-side DNS answer as real — check from a normal
  network (brief §DNS-intercepted).

BTH presence on the pilot router: bigdude's `/ip/address` shows
a BTH entry (orca-setup) — the feature is live there, share
mechanics un-run. Fresh CHR has NO enumerable BTH file-share
menu with BTH off (`/ip/cloud/file-share`,
`/ip/cloud/back-to-home-file`, `/ip/cloud/shares` all
`validation/unknown-path`; `:parse` rejects the guessed forms —
t28-cf-proof.md). Menus appear with the feature, and enabling
phones home: share creation stays pending a deliberate run.

### 1. Share (collected shape, pending first creation)

Design shape (connectivity notes, applicant 2026-10-23; feature
debuted 7.18 as `/ip/cloud/file-share`): a BACK-TO-HOME-FILE
share of a directory (e.g. `disk1/bthf/muse-test-1`,
`allow-uploads=yes`), reachable at
`https://<id>.routingthecloud.net/s/<key>`.

- The on-router container doesn't need HTTP at all: it watches
  the shared directory on local disk while the agent side wraps
  the plain-HTTP scheme. MikroTik's relay is the middleman —
  zero new accounts/infra beyond RouterOS itself.
- Dedicated directory per share (test names namespaced,
  e.g. `muse-test-1`): shares are cheap, cross-share
  confusion is forever. Upload flag explicit per share.
- FIRST CREATION is pending: exact menu path + property names
  on current firmware unconfirmed ( CHR probes couldn't
  enumerate them with BTH off). First applier runs
  explain-validate-run (docs → offline → live → twin… but
  BTH needs the real relay — twin proves syntax, the relay
  proves reach) and records the working shape here.
- Enabling BTH anywhere is a deliberate, recorded decision
  (touches the MikroTik relay; twin-ops sanitization rule) —
  never a side effect of a twin run.

### 2. Exchange (plain HTTP, append-only)

Scheme from the forum writeup (topic #181789 — collected, the
round-trip itself is the pending proof):

- `GET ?list` → JSON directory listing.
- `GET <path>?dl` → download.
- `POST` multipart field `file` WITH trailing slash → upload.
  (The trailing slash is load-bearing per the writeup — first
  uploader confirms or corrects.)
- No DELETE: the share is append-only. Supersede by versioned
  names (`plan-2.toml` beside `plan-1.toml`), never by
  overwrite-then-pretend. Stale files are removed router-side
  by the share owner, recorded when they are.

Exchange discipline:

- Human ↔ agent drops: owner drops a config export/backup in
  Safari, a local agent picks it up; agent drops a script or
  report, owner downloads it. "A share link" is the familiar
  end-user model — meet the human there, not at a CLI.
- Agent ↔ agent (LAN-side): same share as a drop box between
  habitats on the same network. Cross-habitat (cloud sandbox
  involved): NOT this rung — the relay refuses it (§0); use
  the Cloudflare mailbox half (mailbox-envelope-exchange,
  backlog #36).
- Envelopes over drops: signed/encrypted job blobs ride as
  files with identical format across BTH and Cloudflare
  carriers (the envelope format is the design asset; the
  carrier differs by habitat). Manifest-last, one writer per
  folder (#36 rules apply once that skill lands).
- Every transfer checks size + sha256 after (homework §13
  transfer rule — REST/native byte-count history). A download
  isn't "received" until it verifies.

### 3. Close (revoke by removing, record what moved)

- Revocation is removal: delete the share (or its files)
  router-side; the relay URL dies with it. No per-link
  revocation inside one share — one share per trust scope,
  so removal is clean.
- Record the exchange (evidence-ledger): share name (never the
  full URL — the key half is bearer-shaped), file names +
  sizes + sha256, directions, habitats both ends. The ledger
  proves what moved without re-exposing it.
- Test shares die after use (`muse-test-1` is not a pet):
  remove + verify-list-empty, same session. Lingering test
  shares are how stale data becomes "the" data.
- If the share ever carried secrets (exports with keys,
  credential files): the share's whole history is tainted —
  rotate what passed through it, note the anomaly, prefer a
  fresh share next time (pre-publish-scrub: rotate first).

## Part 2 — Skill doc

### Trigger

Load when: moving files owner↔agent without new accounts;
handing a human a download/upload link; staging job envelopes
for the mailbox path; "how do I get this file on/off the
router" questions from LAN-side habitats. (Entry-skill +
capability-probe pattern: K22.)

### Prereqs

- Habitat check FIRST (§0 matrix): LAN-side/residential, or
  stop and re-pick the rung.
- Router with BTH available + a directory to share + the
  upload decision (yes/no per share).
- The exact share-create shape — pending first run (§1):
  until then, this skill briefs the runner, it doesn't hand
  them a command.

### Access

- Share creation/removal: router writes — approval per item
  (bigdude: developer). Share URLs are bearer-capable: treat
  the full URL like a password in every channel (coord,
  chat, notes quote the share NAME, never the URL).
- Upload/download: whoever holds the link. Scope shares so
  link-holders are exactly who you mean.
- Enabling BTH: deliberate relay-touching decision, recorded
  (never a twin side effect).

### Envs

| Name | Use |
|---|---|
| (none) | Plain HTTP + router config; no environment. |

### Outputs

- Share record: router, directory, upload flag, share name
  (URL key redacted to shape).
- Transfer log: files + sizes + sha256 + directions +
  habitats, verify line each.
- Closure: share removed (or handed off with an owner) +
  list-empty verify.

### Verification

- List works (`GET ?list` JSON) before first upload — the
  share is reachable from the consuming habitat, not just
  configured.
- Every file verifies post-transfer (size + sha256).
- Round-trip pending until run: share → upload → list →
  download from the habitat that will use it. NO round-trip
  has executed yet — this is the skill's open proof.
- Closure verified (list-empty or owner-accepted handoff),
  not assumed from the remove command.

### Recovery

- Relay refuses (closed before HTTP response): habitat
  problem, not a share problem — re-check §0, switch rungs
  (Cloudflare half) for that habitat. Don't debug the share.
- Upload fails: trailing slash first (scheme's known
  sharp edge), then upload-flag state, then the writeup
  against current firmware (2026 writeup vs today's
  RouterOS — drift possible, record what you find).
- Stale/conflicting files (no DELETE to save you):
  versioned names going forward; owner-side cleanup for
  the backlog, recorded.
- Share URL leaked (pasted somewhere it shouldn't be):
  bearer-compromise drill — remove the share NOW, fresh
  share if still needed, rotate anything it carried that
  was secret, anomaly note.

### Limits

- Share-create shape + HTTP round-trip BOTH pending: the
  two halves this skill most needs are its two open proofs.
  First runner grounds them (or corrects the writeup).
- Cloud-sandbox habitats can never use this rung (relay
  refusal measured, twice). No fallback, no retry logic —
  different rung.
- Append-only is protocol truth (no DELETE): workflows
  needing revoke-one-file or overwrite need versioning
  discipline, not wishes.
- Relay dependence: MikroTik's cloud is the middleman —
  outages and policy changes there are outside our control
  and outside our logs. Critical paths note the
  dependency; they don't assume it.
