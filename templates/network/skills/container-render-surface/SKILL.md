---
name: container-render-surface
description: "Serve a live surface from the router itself: /app YAML deploy of a status/dashboard page, hash-verified read-back, agent-push sync loop, teardown to pre-state. Use when: putting a quick-check page ('are things up?') on a router, serving a directory as a website from the box, syncing served content, or asking whether a render deploy actually took."
topics: [container, dashboard, rendering, sync]
requires: [twin, container]
tested: twin-run
---

# `container-render-surface` skill (adopt → write-safe → deploy → sync → teardown) [template v1 draft]

A last-mile template extending the /app groundwork. The
container as escape hatch + render surface: serve a
directory as a website (file copy + HTML link) and run
quick-check pages for needs too hot for per-prompt
directory reads. Proven on a CHR twin (7.26beta3,
this run — references/twin-run.md): t28-render v1
deployed, served bytes hash-matched on two paths, v2
synced via recreate with hash-tracked change, teardown
to pre-state. Consumes the /app groundwork
(use-https=no testing pattern, disk rules, quirk list)
and verifies per `deployment-readback-verification`
(hash compare over the serving path, never trust the
return). Disk sync here is agent-push, proven; the
container self-pull half is prescribed, pending.

## Part 1 — The checklist (adopt first, hashes close)

Run top to bottom. Every deploy closes with a served-
bytes hash match, every drill ends at pre-state.

1. Adopt the box: fingerprint /app + /container +
   /disk + /file + nat/veth before touching anything
   (step 0).
2. Write the YAML transport-safe: single-quote style,
   ASCII-only, no doubles, doubled backslashes,
   explain-first (step 1).
3. Deploy + enable + read back: add → use-https=no →
   enable → poll → fetch → hash vs record (step 2).
4. Sync loop: content change ships via recreate;
   H1→H2 hash-tracked, canonical source off-router
   (step 3).
5. Teardown to pre-state: cascade-verify, orphan-hunt,
   record the deploy (step 4).

### 0. Adopt (fingerprint the dirty box)

- Read before writing: `/app` (total + custom=true
  rows), `/container` (id/name/running/root-dir),
  `/disk`, `/file` (full name list), the nat rows
  and veth rows your app's name would touch. This
  drill's pre-state (observed): 103 apps (1 custom:
  *1 t26-hello-node), 3 containers (*7/*8 stopped,
  *9 running), 19 files.
- Residue is the norm on a dirty box: this run found
  duplicate t26 dstnat rules (*4 + *5, same target)
  and an orphan `veth-app-birdnet-go` from earlier
  work — observed, fingerprinted, left untouched.
  Your teardown restores YOUR delta against THIS
  fingerprint, not against factory.
- Non-disturbance rule: the shared dirty box keeps
  other drills' apps live. Never disable/
  remove another drill's rows; name yours distinctly
  (a drill prefix — t28- here) so the orphan-hunt (step 4) cannot
  misfire.

### 1. Write transport-safe YAML (three layers, all observed)

- Layer 1 — YAML: single-quote style, ASCII-only
  (an em-dash was rejected offline). Validate with
  `centrs explain '/app/add yaml="…"'` BEFORE sending:
  this run's 656-byte v1 passed offline (`verdict:
  pass`, canonical path /app verb add).
- Layer 2 — RouterOS strings: `'` is NOT a RouterOS
  token — only `"` opens a string (centrs
  validation/syntax, observed on first attempt). Wrap
  the whole YAML in `"…"`, which is exactly why the
  YAML itself must contain NO double quotes.
- Layer 3 — backslash unescaping (observed end to
  end): RouterOS `"…"` turns `\\` into `\` and `\n`
  into a real newline. JS `'\n'` in configs content
  must therefore be written `\\n` in the YAML, or the
  stored script breaks. Proven: the 38-byte note body
  (trailing newline included) hash-matched.
- Command form: `command: 'node /app.js'` (plain
  string, zero commas/quotes/braces) stores as cmd
  `node /app.js` — no comma mangling on the /app
  path (comma-hostility is the plain-container
  CLI path). Ports: `'8081:80/tcp'` (old OCI style,
  closest to the proven shape; pick a port no live app uses).
- references/ ships the proven pair:
  t28-render-v1/v2.tikapp.yaml. The self-test asserts
  every rule above mechanically (ASCII, no-doubles,
  paired backslashes, required keys, pyyaml parse).

### 2. Deploy + read back (hashes close, returns don't)

- Add: `/app/add yaml="…"` → capture the returned id
  (*69 v1, *CF v2 — ids are NOT reused after remove).
  Fresh apps arrive `disabled=true`: `/app/set
  use-https=no` (the testing pattern — default true
  needs paid-license cloud certs) then `disabled=no`.
- Poll, don't trust: start-load causes transient REST
  timeouts (observed twice); a timeout is not a
  verdict — poll `/app` (ui-url assigned) +
  `/container` (running=true) until the row says so.
  This run: *A at 172.18.0.4 (v1), *B at 172.18.0.5
  (v2) — read the IP from the row, never assume it.
- Read back over the serving path:
  `/tool/fetch url=http://<container-ip>/<path>
  dst-path=<tmp>` → 200 → download + sha256 vs the
  record-time hash. Observed v1: root 131 B
  0aeeb5cd… + note 38 B e754a7b1… — both exact.
  Published ports verify at RULE level on CHR (dstnat
  8081 → .5 observed); packet-level shares the
  dstnat-bypass caveat (router-originated packets
  skip dstnat — needs hardware or a host forward).
- Redaction rides the read-back (deployment-readback-verification):
  the served bytes get the tiering test — a quick-check page
  must serve status, never secrets. This drill serves two
  static strings; the rule still ran.

### 3. Sync (recreate with hash tracking)

- Config/content changes need the RECREATE path
  (deployment-readback-verification §1: a config edit beside a
  running container serves stale): `/app/remove` → re-add with new YAML →
  re-enable → re-read. Observed: v1 root/note
  0aeeb5cd…/e754a7b1… became v2 e732a341…/622d9eb8…
  (131 B / 49 B), each matching its own record hash
  and differing from v1 — the sync is proven by the
  hash delta, not by the smooth sequence.
- Canonical source lives OFF-router (git/desktop —
  deployment-readback-verification §0); the box holds only deployed bytes. This
  drill's canonical pair is references/*.tikapp.yaml
  — the drill deployed FROM the shipped files, so the
  proof and the artifact cannot skew.
- `/app/remove` timed out AND succeeded, twice
  (transport/timeout after 10 s; state showed full
  cascade on poll). Timeout removal rule: never
  re-issue blindly — poll `/app` + `/container`
  first; a double remove of a gone id is the failure
  this rule prevents.
- Prescribed, pending: container SELF-pull sync (box
  re-pulls on a tick) and hot-path per-prompt checks
  (a sensor reading without an agent round-trip) —
  the drill proves agent-push only.

### 4. Teardown + record (pre-state or it didn't happen)

- Remove the app, then VERIFY the cascade (observed
  clean, both cycles): container gone, veth gone
  (`device removed by app …` in the log), dstnat row
  gone, bridge port gone. Log lines observed:
  `container removed by app`, `app removed by
  api:…`, `veth-… link down`, `device removed by app`.
- Orphan-hunt by YOUR prefix: /app custom rows, /container
  names, nat comments, veth names, /file names — all
  must show zero t28- rows. Observed final: files
  20 = pre 19 + `autosupout.old.rif`, which is
  ROUTER-generated rotation (a new supout landed
  mid-drill — see Limits), not drill residue.
- Delete drill temp files (`/file/remove` on the
  fetch targets — all four True) and stop the twin.
  Final fingerprint (observed): containers *7/*8/*9,
  103 apps / 1 custom (*1), nat t26-only, twin stopped.
- Record the deploy per deployment-readback-verification:
  artifact (YAML version + content hash), target, reload action
  (recreate), read-back hashes with times. This drill's record is
  references/twin-run.md.

## Part 2 — Skill doc

### Trigger

Load when: putting a served page on a router (status,
dashboard, quick-check); syncing served content;
asking "is the new version live"; debugging serve-vs-
source mismatch on /app or containers; or scoping a
live surface for a site.

### Prereqs

- The /app groundwork read: install-disk
  setup, use-https=no pattern, quirk list. This skill
  assumes a working /app host (CHR twins qualify).
- deployment-readback-verification (hash discipline,
  reload rows, mismatch layers).
- routeros-app-yaml + routeros-container domain skills
  for format/lifecycle depth.
- centrs + quickchr on PATH; python3 for hashing.

### Access

- Deploys are writes: twin-first always (this drill ran
  on a twin only); production /app + container lifecycle
  needs the developer per deployment-readback-verification Access.
- Read-backs are reads: free anywhere — run them
  generously, they are the only deploy proof.
- Dirty-box discipline (§0): fingerprint first, prefix
  your rows, restore your delta, touch nothing else's.

### Envs

| Name | Use |
|---|---|
| (none) | Transfers + reloads + fetches take CLI shape; no environment. |

No secrets, tokens, or API keys — served pages carry
status text, never credentials (redaction verdict on
every read-back).

### Outputs

- Live render surface (URL + published rule) with
  hash-closed deploy record.
- Sync record per version (record hash vs served hash,
  both values, delta stated).
- Pre/post fingerprints + teardown verdict (pre-state
  restored, or residue named with owner).

### Verification

- Hash equality over the SERVING path per version,
  both values quoted; sync proven by H1≠H2 with each
  matching its own record.
- Reload/recreate action named + confirmed by row
  state (not by return codes).
- Published paths: level stated (rule vs packet).
- Orphan-hunt clean for your prefix; fingerprint
  delta empty-or-explained (box-generated residue
  named, e.g. supout rotation).
- Twin left stopped; no drill rows on any other twin.

### Recovery

- Timeout on add/set/remove → poll state, never
  re-issue blind (observed: both removes timed out
  and succeeded; re-issuing risks double-remove).
- App won't start → read `.about` (the real error;
  native-api may hide transitory ones — a listen may
  be needed, earlier precedent), then configs/cmd layers.
- Serve mismatch (hash differs) → deployment-readback-verification
  mismatch layers in order: reload skipped (stale container — recreate),
  wrong target, transfer short, wrong fetch path.
- Supout/crash mid-drill → drill pauses, box state
  re-fingerprinted before continuing; the anomaly
  ships in the record either way (this run: supout
  at 23:14:20, drill unaffected — see Limits).

### Limits

- BETA ANOMALY (observed, load-bearing): CHR 7.26beta3
  generated `supout.rif` mid-drill (`service
  malfunction`, 23:14:20, during v1 start-load; the
  window also produced the transient REST timeouts).
  The drill completed hash-exact regardless — but /app
  churn on this beta can hiccup services. Supout file
  stays on the box (local-only, not exfiltrated);
  upstream filing is left for the /app follow-up work, not filed here.
- Published-path packet level unverified (the CHR
  dstnat-bypass limit, inherited — rule-level only).
- Self-pull sync + hot-path checks prescribed, not
  executed (agent-push is the proven half).
- Plain-container file-into-container still unresolved
  (inline mount= fails all forms) — this drill
  routes files via /app configs:, which is the
  workaround, not the fix.
- One app, one page: fleet render surfaces (many
  boxes, one dashboard) have no skill yet.
