# skills/ — load on demand

Guides for the agent, loaded when their trigger fires — never all at
once. Your `workspace.toml` home type names exactly one home skill;
`workflow/` covers the lifecycle in every home.

Each skill is a directory: `SKILL.md` (frontmatter + guide) plus an
optional `references/` folder with worked examples. Frontmatter carries
`name`, `description`, `topics:` (vocab-checked), optional `requires:`
(twin|container|disk|git|production-ok), and `tested:`
(none|self-test|twin-run). Every script or code file under `references/`
is executed by that skill's test entrypoint (`references/test.sh`) —
untested code fails the repo's skill gate, and `tested: twin-run`
additionally needs a cited `references/twin-run.md`. See
`anti-drive-live/` for the guardrail exception to the playbook shape.

- `home-private-git/` — default home: bootstrap, branching, session
  loop, capture boundary. (All homes borrow its branching + boundary
  rules.)
- `home-router-container/` — on-router compute: enablement, deploy
  + read-back, dashboard flow, crons, served-code npm rule.
- `home-router-disk-sync/` — disk without containers: pull-first
  loop, one-way sync, drift handling.
- `home-single-copy/` — no-disk local home: minimal layout, backup
  discipline, promotion trigger.
- `anti-drive-live/` — stop-sign: symptoms, redirect, archive rule.
- `first-contact/` — transport negotiation: probe, select, authenticate,
  persist to device registry, escalate with an evidence packet.
- `change-apply/` — safe writes: twin-proof, propose, stage as
  /system/script, positional run, read back, clear WIP.
- `state-pull/` — capture discipline: redacted export + stripped JSON
  + sha256 manifest, serial-gated, checker-verified before use.
- `incident-response/` — L1 flow: pull-first, compare, reproduce and
  bisect on a twin, fix, verify, close with evidence.
- `usermanager-ops/` — UM inside its bounds: db-path depth rule,
  wedge signature and escape, setup recipe, reboot verify.
- `twin-ops/` — twin lifecycle: build at matching firmware, snapshot
  discipline, prove in cycles, non-disturbance, teardown.
- `work-flag-note/` — /system/note WIP flag: set before, clear after,
  empty means well (coordination, not a lock).
- `vpn-setup/` — tunnel bring-up: pick from the measured matrix,
  twin-proof WireGuard (handshake or it didn't happen), relay rungs,
  deadman production apply, ledger record.
- `evidence-ledger/` — dated command+output ledgers: header, verbatim
  commands, claim labels (observed/collected/inferred/pending),
  anomaly notes, tracker attach.
- `agent-access-bootstrap/` — router accounts: local reader/admin/
  break-glass, custom minimal groups, default-group trap fix,
  show-sensitive verify, revocation bounds.
- `failure-layer-attribution/` — failed-request triage: 401 flavors,
  permission-denied vs retryable, logs-first for auth, egress
  ladder, retry rule verdicts.
- `explain-validate-run/` — command grounding loop: rosetta docs,
  offline explain, live device validation, twin proof, two-endpoint
  read-back agreement.
- `pre-publish-scrub/` — pre-public sweep: runtime state, privacy tiers,
  zero-findings gate, clean-home staging, pair review.
- `capture-drift-hygiene/` — intent vs observation: pull-first,
  checker verdicts, three freshness clocks, drift list discipline.
- `adversarial-review/` — second-agent review: draft to reviewable,
  staffed critic, findings + deltas next to the change, approval
  attachment.
- `cmr-fleet-guard/` — CMR supervision, consumed safely:
  enrollment-only, alerts by webhook/email, own upgrade rule first,
  controller-login guard.
- `bth-file-exchange/` — BackToHome Files rung: LAN-side/human
  drops over the MikroTik relay, append-only HTTP scheme, close
  by removal.
- `mailbox-envelope-exchange/` — async jobs without a live path:
  signed/encrypted envelopes, manifest-last, one writer per folder,
  carrier per environment, poll pickup.
- `deployment-readback-verification/` — deploy proof: separate
  deploy log, reload per target, served-artifact hash read-back,
  never trust the return.
- `service-path-fleet-check/` — fleet health along the path:
  outward-from-main order, per-device outcomes, shared-path
  correlation, hysteresis + recovery discipline.
- `load-bearing-router-bench-prep/` — bench loans without site
  breakage: role inventory, VPN/login unbundle, RAM budget,
  re-prove on that box.
- `network-workspace-bootstrap/` — build a workspace from the
  template: starter layout, writer/sync map, memory + handoff,
  fresh-session takeover test.
- `connector-onboarding-verify/` — onboard connectors safely:
  scaffold doc + allowlist, read-only auth first, harmless
  live-read probe, deliberate escalation.
- `remote-agent-profile-hardening/` — remote centrs profile as
  its own authority: frozen tool set, explicit principal grants,
  immutable request context, isolation tests.
- `first-run-lan-pairing-onboarding/` — LAN bond before any
  cloud door: install-secret host bind, MNDP sweep, CDB seed,
  LAN-only passwords with scope grants.
- `decision-board-lifecycle/` — whiteboards to verdicts:
  author the fragment, discuss on a stable page, link decision
  + work records, retire without losing either.
- `truthful-topology-graphviz/` — topology from observed
  reads: centrs reads to deterministic DOT to SVG, observed
  vs inferred marked, regenerated diffs.
- `anonymized-pattern-extraction/` — private repos to generic
  patterns: shape-not-detail, labeled claims, synthetic
  examples, scrub-gated handoff.
- `friction-reproduction-report/` — friction to upstream
  reports: twin-first repro, command-plus-output transcripts,
  check-before-file, lifelong linkage.
- `workflow/` — lifecycle: buying, setup, configuring,
  troubleshooting, reports + the thin GitHub adapter.

Status: drafts under review with template v1.
