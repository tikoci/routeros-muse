---
name: deployment-readback-verification
description: "Prove a deploy by reading the served artifact: deploy log separate from source, reload per target, hash-compare read-back, never trust the return. Use when: deploying dashboards, configs, or served code to any target; asking 'is it live?'; debugging serve-vs-source mismatches."
topics: [deployment, verification, redaction]
tested: none
---

# `deployment-readback-verification` skill (record → reload → read → compare) [template v1 draft]

Promoted from an /app end-to-end proof
(served + read back), the container deploy recipe
(home-router-container §3), and the never-trust-the-return
finding (False return, flow proceeded). No
secrets below; hashes travel, contents stay targeted.

## Part 1 — The checklist (deployed means read back)

Run top to bottom. Editing source never proves deployment.
The corollary proven on CHR: a success return never proves it
either — only the served artifact, read back, counts.

1. Record the deploy separately from the source (§0): artifact,
   hash, time, target, reload action — the deploy log.
2. Reload per the target's semantics (§1): container, /app,
   disk-synced, each reloads differently — run YOUR target's.
3. Read back the SERVED artifact (§2): over the serving path,
   not the source path — and compare hashes.
4. Reconcile or roll (§3): match closes, mismatch debugs by
   layer, deploys never linger unverified.

### 0. Record (the deploy log is not the source log)

From home-router-container §3 (read this session): build
off-router (canonical source in git/desktop — never author on
the router), then record the deployment SEPARATELY: artifact,
version/hash, time, target path, reload action taken.

- Source says what SHOULD serve; the deploy log says what WAS
  PUT where, when, and how it was activated. One cannot
  substitute for the other — the gap between them is exactly
  where "but I deployed it" incidents live.
- Hash at record time (sha256 of the artifact bytes): the
  read-back (§2) compares against THIS, not against a
  re-read of source (source may have moved since).
- Served-code rule rides here (home-router-container §3 step 2):
  router-served dashboard/proxy code MUST be npm-compatible,
  no Bun-isms — review diffs against the rule BEFORE the
  deploy record is written. A Bun-ism fails the review like
  a secret in a commit.
- Transfer mechanics (home-router-container §3 step 3 + friction notes):
  centrs transfer, minding first-attempt 0-byte (retry
  `--force`) and SFTP pinning. Transfer-log "ok"
  is a claim about BYTES MOVED, not about serving — it
  opens the deploy record, it never closes it.

### 1. Reload (each target its own semantics)

Editing/transferring never activates: every serving target has
a reload step, and skipping it serves the OLD artifact with a
NEW deploy record — the classic mismatch.

- **Container HTTP** (proven on CHR): nginx:alpine served 200
  "Welcome to nginx!" after pull + start; node:alpine
  executed on request. Reload = container (re)start per the
  container lifecycle (config changes via `configs:` need
  the recreate path — a config edit beside a running
  container serves stale until recreated).
- **/app** (proven end-to-end on CHR): `/app/set use-https=no`
  → app pulls, runs, serves; t26-hello-node served HTTP 200
  `t26-ok`. Reload = the /app state machine (set/start);
  watch `.about` for the REAL error (native-api may hide
  pending/transitory ones — a listen may be needed).
- **Disk-synced surfaces** (collected: container-render-surface
  + disk-sync): file copy + served-by-container (self-pull
  or agent-push). Reload = whatever re-reads: container
  restart, app re-pull, or the sync tick — NAME it in the
  deploy record; "the sync handles it" is not a reload
  action (anti-drive-live: sync-haunted phrases).
- **Published ports**: /app created the correct
  dstnat rule (host:8080 → container:80) but router-side
  fetch to :8080 refused — router-originated packets bypass
  dstnat. Published-path verification happens at RULE level
  on CHR; packet-level needs hardware or a host forward.
  Record WHICH level the proof reached.

### 2. Read back (served path, hash compare)

The end-to-end shape: served HTTP 200 `t26-ok`, read back
router-side via `/tool/fetch` to the container IP. Generalize:

- Read over the SERVING path: HTTP fetch for HTTP artifacts
  (router-side `/tool/fetch` to the container/app address),
  file read for file-served artifacts (`:put [/file/get …]`
  proven on a twin with exact byte sizes). Never "verify" by
  re-reading the SOURCE, the transfer log, or the return
  code — those aren't the served thing.
- Compare HASHES (record-time sha256 vs read-back sha256):
  equality closes, inequality debugs. Byte counts travel
  alongside (401 B real, exact) — size mismatch with
  hash match is impossible; size match with hash mismatch
  is corruption with confidence.
- Redaction rides the read-back (topics: redaction): served
  artifacts get the tiering test (pre-publish-scrub sensitivity tiers) —
  a dashboard that serves a secret is a leak with a URL.
  The read-back that proves deployment ALSO proves
  servability-safety, same bytes, second verdict.
- NEVER TRUST THE RETURN (debugging note, load-bearing):
  the first `use-https=no` set returned False yet the flow
  proceeded. Returns lie in both directions (false False,
  false True) — the read-back is the only truth. Any
  procedure that branches on a return without a read-back
  is pending, not proven.

### 3. Reconcile (match closes, mismatch layers)

- MATCH (hashes equal over the serving path): close the
  deploy record with the read-back cited (time + path +
  hash). The deploy is DONE — say so, short sentence,
  pointer to the record.
- MISMATCH: debug by layer, in order — (1) reload skipped?
  (§1: most common — old artifact serving), (2) wrong
  target? (path/version skew between record and server),
  (3) transfer short? (0-byte class — re-transfer +
  re-read), (4) serving stale cache? (restart/re-pull the
  server, not the source), (5) read the wrong path?
  (your fetch != the served route — dstnat-bypass class).
  Fix the layer, re-record, re-read. Never edit the record
  to match the read — the record describes the ATTEMPT.
- Deploy tracked in the session close (home-router-container
  §7: record any deployments) + operations deployments log
  (templates/network/operations/deployments.md): the fleet's deploy
  history is one list, per-artifact entries, each closed
  by its read-back. Unclosed entries are drift until
  proven (capture-drift-hygiene).
- Rollback = a new deploy record (old artifact hash,
  new time, same reload + read-back): rollbacks verify
  like deploys because they ARE deploys. "Rolled back"
  without a read-back is a wish.

## Part 2 — Skill doc

### Trigger

Load when: deploying anything served (dashboard, config,
proxy, page, file tree); "is it live?" questions; served
content looks stale or wrong; designing a deploy pipeline.
(Entry-skill + capability-probe pattern.)

### Prereqs

- Artifact built + hashed off-router (source canonical
  elsewhere — home-router-container §3 step 1).
- Target's reload semantics known (§1 row) BEFORE the
  transfer — deploying without knowing the reload is
  half a plan.
- Read-back path available (`/tool/fetch` router-side,
  HTTP from the consumer side, or file read) + the
  expected hash in hand.

### Access

- Deploys are writes: approval per item, staging where
  the target allows (twin-first for the procedure per
  change-apply; the /app shape is proven on CHR).
- Production /app + container lifecycle needs
  the developer (owner-hands for enablement semantics;
  agent verifies after, home-router-container §2).
- Read-backs are reads: free anywhere, any time — and
  the ONLY deploy proof, so run them generously.

### Envs

| Name | Use |
|---|---|
| (none) | Transfers + reloads + fetches take CLI shape; no environment. |

### Outputs

- Deploy record: artifact + hash + time + target path +
  reload action + read-back (hash match cited).
- Mismatch debug trail (when: layer found + fix + re-proof).
- Fleet deploy-history entry (operations/deployments.md).
- Servability-safety verdict (redaction tiering on the
  served bytes).

### Verification

- Hash equality over the SERVING path, quoted (record hash
  vs read-back hash — both values, not "match ✓" alone…
  well, the values' shapes where secret-adjacent).
- Reload action named + confirmed (container state, /app
  `.about`, sync tick — per target, not assumed).
- Published paths: level stated (rule-level vs
  packet-level — the dstnat lesson).
- Deploy history entry closed with the read-back pointer;
  no open-ended "deployed" claims anywhere.

### Recovery

- False-False return (flow proceeded): ignore the return,
  run the read-back. Returns are hints.
- False-True return (flow didn't): the read-back catches
  it (stale hash) — then debug by layer (§3), starting
  with reload-skipped.
- Stale-forever (reloads don't take): suspect the wrong
  target (two containers, old + new) or a stuck server
  (recreate, don't poke) — identify by served-hash
  fingerprinting, then fix decisively.
- Deploy record lost (source moved, hash unknown): re-hash
  the CURRENT source, note the skew honestly (record hash
  ≠ deploy hash — the read-back still proves CURRENT
  serving, not the original deploy), re-record going
  forward.

### Limits

- SECTION-VS-STANDALONE (answered
  here with source): home-router-container §3 IS the
  container deploy recipe (record + rule + transfer +
  read-back) — this skill generalizes it across targets
  (/app, disk-synced, published ports) with reload
  semantics + the never-trust-the-return proof. home-router-container
  keeps its recipe (home-specific); this is the
  cross-home procedure homes cite. No duplication: it
  specializes, this generalizes.
- The proof is CHR (/app + containers on CHR free):
  published-path packet level + hardware serve paths need
  hardware proof (rule-level verified, packets pending).
- Reload rows for disk-synced surfaces collected
  (container-render-surface), not executed here: first disk-synced
  deploy grounds its row.
- Hash-compare proves BYTES served, not MEANING served:
  a correct-hash dashboard with wrong data is a data bug
  past this skill's verdict — the read-back proves the
  pipe, the content needs its own eyes.
