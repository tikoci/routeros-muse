---
name: home-router-disk-sync
description: "Router disk home without containers. Use when: mapping router disk dirs, running the pull-first session loop, resolving sync conflicts, or answering which copy wins."
topics: [disk, sync, workspace]
requires: [disk]
tested: none
---

# `home-router-disk-sync` skill (disk, no container) [template v1 draft]

Vendored from the build notes for review with template v1.
Branching, capture boundary, and session commit rules live in
`home-private-git` and are not repeated. No secrets below.

## Part 1 — The checklist (map → pull-first loop)

### 0. Decide this is the home

Use router-disk-sync when the router has usable disk but no container
stack (policy, arch, or flash constraints), and an SSH or native-API
read path works. Keeps bulky or sensitive collected data on the
router with minimal prerequisites. Dashboards and crons must live
elsewhere (git home or a container deployment) — there is no on-router
compute here. No disk at all → `home-single-copy`.

### 1. Map the dirs (once per device, refreshed when the router changes)

1. List the router-owned scheme locations on disk (logs, collected
   data, served-static if any) with sizes.
2. Record the map in the device's inventory entry: router path → local
   landing path under `observations/<device>/raw/`.
3. Consult the per-version export-omission list BEFORE first
   pull: known-missing sections (UM, smb, per-version gaps) read as
   known gaps afterward, never as drift.

### 2. Session open (pull-first — the agent's first move, every session)

1. `git pull` the canonical source home (or confirm single-copy canonical).
2. Pull EVERY router-owned dir via centrs retrieve/transfer down to
   `observations/<device>/raw/` (ignored). Export-over-native-API is
   the proven read; pin `--via` explicitly (auto-select does
   not fail over, transfer ignores record `via=ssh`).
3. Manifest check: age, sha256 + byte size per file (checker over
   captures; prototype `bun checker.ts --all`).
4. Read ages with the freshness split: content-changed vs
   last-observed vs last-attempted — a quiet router with fresh pulls
   is healthy, not stale.

### 3. Sync rules (one direction per directory, never two-way)

| Directory class | Direction | Conflict rule |
|---|---|---|
| Router-owned (logs, collected data) | pull only | re-pull wins; agent edits here are forbidden |
| Agent-owned (plan, skills, schemes, docs) | sync from canonical home | canonical home wins; second copies carry age manifests |

Conflicts resolve by re-pull, never by pushing agent edits into
router-owned paths. There is no merge step in this skill.

### 4. Drift handling

Plan-vs-capture disagreement goes on the drift list or the router
gets fixed. Never rewrite the plan to match unless that is the
recorded decision. Drift entries cite the pull manifest + time.

### 5. Session close

1. Commit shaped work + refreshed `summary.md` files (capture
   boundary per `home-private-git` §1.4: raw ignored, redacted
   summaries commit).
2. Report pull sizes — large captures need size reporting so growth
   is visible before it hurts.
3. Push to `main` per `home-private-git` §2 (PRs only on explicit
   owner request, never suggested).

## Part 2 — Skill doc

### Trigger

Load when: the deployment keeps router-owned data on router disk
without containers; mapping router disk dirs; any sync conflict or
"which copy wins" question; pull-size growth alarms.

### Prereqs

- Usable router disk with scheme locations reachable; SSH or
  native-API read path verified (transport negotiation on first contact).
- Dir map recorded (§1); the export-omission list consulted for the box's version.
- Agent machine: trilogy + pull/checker; canonical source home exists.

### Access

- Reads-first: pull + checker before any write.
- Router-owned paths: pull + read only. Any router change goes
  through the config flow (workflow: Configuring) with owner go-ahead on
  production boxes — never a "sync back".
- Operator Unknown → ask before any write.

### Envs

None new. Transport auth reuses the first-contact envs (`CENTRS_*`,
CDB-first). Long pulls may need `--timeout 30s` (the 10s
default kills long runs silently).

### Outputs

- Dir map (device → router paths → local landing paths).
- Per-session pull report: manifests, sizes, checker verdicts.
- Drift entries citing manifest + time; refreshed summaries.

### Verification

- Manifests fresh (last-attempted ≈ session start) and checker exit 0.
- `git status --short` shows no `raw/` paths (ignore rule holds).
- No agent-authored bytes under any router-owned landing path —
  `raw/` is pull-written only.
- Sizes reported; growth vs previous session visible.

### Recovery

- Manifest mismatch / tamper signal: treat as incident input
  (workflow: Troubleshooting), not as a cue to hand-edit `raw/`.
- 0-byte transfer: retry `--force`. REST denial: failure, never
  success, never blind retry. Timeout kill: `--timeout 30s`.
- Sync conflict: re-pull (§3 table). There is no second remedy.

### Limits

- No on-router compute: dashboards, crons, and admin tools live in
  another home or a container deployment.
- Every session pays a pull cost; huge captures need the size +
  freshness discipline, not skipping.
- The proven read is export-over-native-API; other paths must prove
  themselves per box before becoming routine.

## Part 3 — Assumptions (ratified elsewhere; this skill assumes)

1. Scheme locations for router-owned dirs come from the workspace
   template; until then the §1 map is per-deployment and recorded,
   not standard.
2. The export-omission list is consulted per box version; unlisted gaps
   are drift until proven otherwise.
3. Canonical source home (git or single-copy) always exists alongside;
   this skill owns the pull direction only.
