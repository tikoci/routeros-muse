---
name: mailbox-envelope-exchange
description: "Async job exchange where no live path exists: signed/encrypted envelopes as files, manifest-last, one writer per folder, poll pickup. Use when: reaching an agent or container across an air gap, staging offline jobs, or carrying envelopes on BTH, Cloudflare, or Drive-boundary carriers."
topics: [mailbox, offline, transport, manifest, drive]
tested: none
---

# `mailbox-envelope-exchange` skill (wrap → drop → poll → collect) [template v1 draft]

Promoted from the envelope design (brief §transport-never-authority
+ ladder §2), the signing-key open decision (AGENTS.md:94, concept
review), the lived coord precedent (one draft per post, 19/19 tests
green this session), and the pull manifest-last mechanics (pull.ts).
Backlog #36. No secrets below; envelope contents are never quoted.

## Part 1 — The checklist (async, signed, manifest-last)

Run top to bottom. The mailbox is the rung for "no live path":
slow, certain, andiveness-proof by construction.

1. Wrap the job (§0): envelope format, signature + scope +
   expiry, encryption for the mailbox path.
2. Drop manifest-last, one writer per folder (§1): files first,
   manifest final, never two writers.
3. Pick the carrier by habitat (§2): BTH, Cloudflare, or the
   Drive boundary — each with its hard limits.
4. Poll, collect, close (§3): poll pickup, verify-then-act,
   receipt, cleanup.

### 0. Wrap (transport is never authority)

Design (brief, collected — the FORMAT is settled, the SIGNER is
an open decision, see Limits):

- Mutating requests carry an APPLICATION-LAYER signature from a
  key the transport doesn't hold: Cloudflare terminates TLS at
  its edge and the BTH URL is bearer-shaped, so neither can
  vouch for the request. The container verifies signature +
  scope + expiry before acting.
- For the mailbox path, job envelopes are END-TO-END ENCRYPTED
  between agent and container: relays carry ciphertext only. A
  relay that can read the job is a relay that can forge it —
  ciphertext-only or it isn't the mailbox path.
- The envelope format is IDENTICAL across carriers (BTH Files
  and Cloudflare Worker+KV): same signed + encrypted job blobs
  in a directory. The format is the design asset; the carrier
  differs by habitat (brief ladder §2).
- Envelope contents: job id (self-minting, coord-style:
  timestamp + habitat — no counter lock), payload, scope,
  expiry, signature. Scope says what the job may touch; expiry
  bounds replay; the id makes duplicates detectable.

### 1. Drop (manifest-last, one writer per folder)

Mechanics grounded in two lived systems:

- **Manifest-last** (pull.ts, read this session): files land
  first, each hashed; `manifest.json` (file list + sha256 +
  status + notes) is written AFTER all files; `latest` flips
  last. The mailbox mirrors it: envelope files first, manifest
  (ids + hashes + completeness) final. A reader that sees no
  manifest sees nothing-yet — never a half-written job. The
  manifest is the completeness statement, not a nicety.
- **One writer per folder** (coord protocol + corpus rule):
  coord runs one draft per post, never edit another's (Gmail
  whole-body replace → append races; self-minting IDs; 19/19
  protocol tests green, re-run this session). Corpus: "one
  writer per file" across habitats. Mailbox extension: one
  writer per FOLDER — the writer owns the drop dir, the reader
  only reads. Two writers to one folder is how whole-file
  replace races eat jobs; split folders instead.
- Job lifecycle per folder: `pending/` (writing, manifest
  absent) → manifest lands → `ready/` (atomic move or manifest
  flip) → reader collects → `done/` + receipt. The reader
  NEVER acts on `pending/` — only manifest-complete drops.
- Duplicates are normal (retries, double-poll): job ids make
  them detectable, idempotent handlers make them harmless.
  "Exactly once" is claimed by NOBODY on this path — at-least-
  once + idempotence is the contract.

### 2. Carry (habitat picks, limits bind)

- **BTH Files** (LAN-side + humans): zero setup, append-only,
  plain-HTTP scheme (bth-file-exchange: list/dl/upload, no
  DELETE). Envelopes ride as files; the container watches the
  shared dir on local disk. Limit: relay refuses the cloud
  sandbox — never the cloud agent's carrier.
- **Cloudflare Worker+KV** (cloud agent): ordinary
  Cloudflare-fronted HTTPS, reachable from the sandbox. Limit:
  new infra (Worker + KV + account) vs BTH's zero; build-week
  verification #1 (quick-tunnel round-trip from Habitat A)
  still open at design time — first use proves the carrier.
- **Drive boundary** (publication-boundary/poll ONLY —
  reconcile with anti-drive-live, performed here): Drive is
  NEVER live interchange (guardrail: FUSE pain, whole-file
  races, conflict copies). A Drive folder MAY carry mailbox
  drops ONLY under all of: one writer per folder (§1),
  manifest-last (§1), dated drops (age on everything, K12),
  POLL pickup (reader polls rarely; no sync-watch, no "sync
  will handle it"), and never live state (jobs + receipts,
  not plans/captures/CDB). This reconcile DERIVES from the
  guardrail (same failure modes, fenced one by one) — it
  narrows Drive to a bounded carrier, it doesn't reopen
  Drive-as-bus. Ratification pending: first Drive-carried
  drop records here whether the fence held.
- Carrier changes don't reformat envelopes (§0): the same
  blob moves from BTH to Cloudflare to Drive-boundary
  untouched. Re-wrap on carrier change is a protocol bug.

### 3. Collect (poll, verify, receipt, clean)

- Poll, don't watch: the reader polls on its cadence
  (look-after rhythm, not filesystem events — events don't
  cross relays). Poll interval is the latency statement:
  minutes-scale for email/mailbox checks, stated honestly
  (habitat-A verdict: no push on new email; same honesty
  here — the mailbox promises eventual, never instant).
- Verify-then-act per envelope: manifest hash matches file
  bytes → signature verifies (key the transport doesn't
  hold) → scope covers the job → expiry unpassed → THEN
  act. Any failure: quarantine the envelope (move aside,
  keep bytes), log the failure shape, act on nothing.
  Verification order is hash → signature → scope → expiry
  (cheap-to-dear, outside-in).
- Receipts close the loop: the reader drops a signed receipt
  (job id + outcome + timestamp) in the reply folder —
  same manifest-last discipline, roles reversed. The writer
  polls for receipts on the same cadence. No receipt by
  3× poll interval + handler bound = the job is LOST, not
  late: re-drop with the SAME id (idempotence absorbs the
  duplicate if the first actually ran).
- Cleanup: collected jobs + receipts age out per the folder's
  retention (stated, not infinite — append-only carriers
  fill). Retention expiry deletes OLDEST-COMPLETE first;
  pending (manifest-absent) drops are never reaped by age.

## Part 2 — Skill doc

### Trigger

Load when: no live path reaches the other side (air gap,
sandbox egress, offline router); staging jobs for later
execution; carrying envelopes on any file carrier; "how do
two agents talk without a connection" questions. (Entry-skill
+ capability-probe pattern: K22.)

### Prereqs

- The signer DECIDED (open decision — who holds keys the
  sandbox can't? see Limits): unsigned envelopes are drafts,
  not jobs. Nothing acts on an unsigned drop.
- Carrier agreed + reachable from BOTH ends (matrix-checked
  per habitat — BTH ≠ sandbox, §2).
- Folder layout + poll cadences + retention stated before
  the first drop. The discipline precedes the data.

### Access

- Drop folders: writer writes, reader reads, NOBODY else
  touches. Folder ACLs (share scope, link holders) set to
  exactly the two parties.
- Keys live with the signer, never on the carrier, never in
  the ledger (shapes only — key IDs, never material).
- Drive-boundary drops additionally obey anti-drive-live:
  dated, poll-only, jobs-only; any drift toward live state
  kills the carrier (Recovery).

### Envs

| Name | Use |
|---|---|
| (none) | Files + crypto + polling; no environment. |

### Outputs

- Envelope spec in force (format version, signer, scope
  vocabulary, expiry bounds).
- Drop record: job id + manifest + carrier + timestamp.
- Collection record: verify chain (hash/sig/scope/expiry)
  + outcome + receipt id.
- Carrier health notes (latency observed, failures, fence
  status for Drive-boundary).

### Verification

- Manifest verifies (hashes match) before signature checks
  begin — order matters, §3.
- Every acted job traces to a complete verify chain in the
  ledger (evidence-ledger: command + output per check).
- Receipts match drops (id reconciliation both directions);
  orphans (drop without receipt past bound) investigated,
  not assumed.
- Drive-boundary fence audit per drop: one writer ✓,
  manifest-last ✓, dated ✓, poll pickup ✓, jobs-only ✓.

### Recovery

- Manifest-absent past the writer's bound: writer died
  mid-drop — reader ignores (correct); writer re-drops
  whole (same id). Never complete a partial drop by hand.
- Signature/scope/expiry failure: quarantine + log + act
  on nothing. Three quarantines from one writer = revoke
  the writer's scope (key rotation per agent-access-bootstrap).
- Carrier degradation (relay down, share dead): envelopes
  re-drop UNCHANGED on the backup carrier (§2: format is
  carrier-agnostic). Carrier failure never rewrites jobs.
- Drive drift (live state appears, second writer, sync-watch
  proposed): kill the Drive carrier immediately (anti-drive-live
  Recovery), move to BTH/Cloudflare, write up the drift.
  The fence failing once is how it fails forever if excused.

### Limits

- SIGNER UNDECIDED (open, blocking real use): the brief asks
  the sandbox to sign while AGENTS.md:94 confirms it holds no
  keys (concept review :136). Until someone decides who signs
  with what, envelopes are format-complete but unactionable —
  this skill's procedures assume the decision exists.
- Partially verified: manifest-last + one-writer mechanics are
  lived (pull.ts, coord 19/19); the ENVELOPE round-trip
  (wrap → carrier → verify → act → receipt) has NOT executed
  end-to-end anywhere. First round-trip grounds it.
- Cloudflare-carrier verification #1 open (design-time); BTH
  share-create + round-trip open (bth-file-exchange); Drive
  fence unratified (§2). Three carriers, three pending proofs.
- Latency is poll-scale by design: anything needing live
  answers is not a mailbox job — re-pick the rung (vpn-setup
  ladder) instead of polling faster and calling it live.
