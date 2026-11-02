---
name: home-router-container
description: "On-router compute home: containers on router disk. Use when: enabling containers, deploying or debugging served artifacts, dashboard/admin-tool/cron work, disk-space or container-health alarms, or reviewing served code for npm compatibility."
topics: [container, dashboard, workspace]
requires: [container, disk]
tested: none
---

# `home-router-container` skill (steered-to primary) [template v1 draft]

Vendored from the build notes for review with template v1.
Branching, capture boundary, and session commit rules live in
`home-private-git` and are not repeated. No secrets below.

## Part 1 — The checklist (enable → deploy → operate)

### 0. Decide this is the home

Use router-container when ALL hold: the router has usable disk (real
disks or USB — not ~26 MB-free flash), the container package is
available for the board's arch, device-mode may be set, and the owner
accepts on-router compute. This is the demo shape and the only home
that unlocks dashboard, admin tools, and crons owned by the owner's
agent. Otherwise: `home-router-disk-sync` (disk, no container) or
`home-single-copy`. Arch check FIRST: arm32 boards need
Node-port scoping work — never assume container images run there.

### 1. Disk check

1. Read the disk table (size/free per disk) and record which disk
   hosts container storage. Refuse flash-only boards for this home.
2. Record the decision (disk, sizes, date) in the device's inventory
   entry — later space alarms cite this baseline.

### 2. Container enablement (production writes — owner go-ahead per item)

1. Install/enable the container package.
2. Set device-mode so `container=true`. The mode change is an
   owner-hands step (press/power-cycle semantics); the agent verifies
   after, never performs the hands part remotely.
3. Verify by read-back: container menu present, device-mode reports
   container allowed. Record versions.

### 3. Deploy recipe (editing source never proves deployment)

1. Build off-router. Canonical source lives in git or the desktop
   single copy — never author directly on the router.
2. SERVED-CODE RULE (decided 2026-10-28): dashboard/proxy code
   that runs on the router MUST be npm-compatible — NO Bun-isms (no
   `Bun.*` APIs, no Bun-only imports or behaviors). Bun stays the
   workspace-side tool for repo/tool updates only. Review diffs of
   served code against this rule before every deploy; a Bun-ism in
   served code fails the review the same as a secret in a commit.
3. Transfer the artifact via centrs transfer (mind first-attempt
   0-byte: retry `--force`; pin `--via sftp` explicitly).
4. Record the deployment SEPARATELY from the source: artifact,
   version/hash, time, target path, reload action taken.
5. Read back the served artifact and compare hashes. No read-back
   proof means not deployed, whatever the transfer log says.

### 4. Dashboard first-prompt (golden path, not a ready-made dashboard)

"Build me a dashboard" runs: collect lay-of-land via centrs retrieve,
populate region/site/room/device layers, upload the HTML via transfer,
read it back over HTTP, hand the owner the URL. Skills plus schemes
plus scripts — the agent builds it; the template only paves the path.

### 5. Cron / collect cadences

Collection, investigation, and notification stay separate cadences
with hysteresis, dedup, and announce-recovery. Container-owned crons
are recorded with schedule plus last-run evidence. A failed check
never renders green.

### 6. Space / health monitoring

Free-space checks are template concerns from day one; flash wear
stays a caution on every write-heavy design; container logs are
bounded and rotated. Alarms cite the §1 baseline.

### 7. Session loop (extends the git-home loop)

Open: `git pull`, pull router-owned dirs (logs, collected data,
served artifacts), run the checker, spot read-back of served
artifacts. Close: commit shaped work, record any deployments,
push/merge per `home-private-git` §2.

## Part 2 — Skill doc

### Trigger

Load when: the deployment targets on-router compute; enabling
containers; deploying or debugging a served artifact (dashboard, admin
tool, cron); disk-space or container-health alarms.

### Prereqs

- Usable disk verified (§1); container package + device-mode path
  confirmed with the owner; board arch has image support (arm32
  flagged).
- Agent machine: trilogy + pull/checker + transfer path (first-contact
  negotiation).
- `workspace.toml` declares this home; canonical source home (git or
  single-copy) exists — this skill never stands alone without one.

### Access

- Enablement + device-mode + first deploy: owner go-ahead per item
  (production writes; the production rule generalized).
- Routine re-deploys of an approved artifact follow the config flow
  (the git workflow §2): shaped proposal, drift delta, staged apply.
- Reads-first always; Operator Unknown → ask before any write.

### Envs

None new. Transport auth reuses the first-contact envs
(`CENTRS_*`, CDB-first). Container registry credentials, if any, are
owner-provisioned and live in the deployment's own store.

### Outputs

- Enablement record (disk, versions, date, hands-step witness).
- Deployment records (artifact/version/hash/time/path/reload action).
- Dashboard URL plus read-back proof; cron table with last-run evidence.

### Verification

- Served-bytes hash equals source hash after every deploy.
- Device-mode/container state reads back as expected each session.
- Cron last-runs fall inside their cadences; misses are findings.
- Free space above the recorded floor; logs bounded.
- Claim discipline: command + output on every claim.

### Recovery

- Bad deploy: re-deploy the last known-good artifact (rollback is a
  forward deploy of the old bytes, recorded as such).
- Container misbehaving: restart per the artifact's own reload/restart
  semantics — every served artifact's recipe states them.
- Disk-full: collect-and-trim only with owner ack; captures are
  evidence, never silently deleted.
- Transfer/transport faults: first-contact recovery applies.

### Limits

- Arch matrix gates everything (decided
  2026-10-28: arm32 needs dashboard-RUN support via the §3
  npm-compat rule, not a tool port; agents/tooling stay off arm32).
  Until a minimum disk/RAM matrix lands, owner-verified disk per §1
  is the gate.
- Flash wear and free space are permanent constraints, not setup-time
  checks.
- No read-back proof = not deployed. No exceptions for "transfer said ok".

## Part 3 — Assumptions (decided during template design; this skill assumes)

1. The golden-path shape holds: skills + schemes + scripts, agent-built
   dashboard via the §4 flow.
2. Node-port scoping narrowed per the served-code npm-compat rule (§3);
   no full tool port. §0 still refuses image assumptions on unproven archs.
3. Minimum disk/RAM/arch matrix lands from the demo track;
   §1 is the interim gate.
4. Canonical source home (git or single-copy) always exists alongside;
   this skill owns router-owned dirs and served artifacts only.
