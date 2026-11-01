---
name: remote-agent-profile-hardening
description: "Harden a centrs remote-agent profile before any remote principal touches it: freeze the tool set, bind principals to explicit grants, resolve every call to immutable context, run the isolation tests. Use when: exposing centrs MCP beyond stdio, reviewing a remote profile for authorization gaps, adding a principal or grant, or auditing why a remote call was allowed or denied."
topics: [security, cdb, mcp]
tested: none
---

# `remote-agent-profile-hardening` skill (freeze → bind → immobilize → isolate → record) [template v1 draft]

Promoted from two source-grounded architecture reviews — Astra #21
(Codex, centrs `414934e`) and the review-of-reviews #22 (Claude,
CHR 7.25 + Bun 1.4.4 + centrs `414934e`) — plus the centrs-as-app
design note, re-verified against centrs `a13729c` (#541 landed)
this session. Backlog #42. App-side complement to #26
(agent-access-bootstrap covers the device accounts; this covers
the agent-facing authority). Core rule, earned in review: the
remote profile is a NEW authorization authority, not the stdio
server on a socket. No secrets below; tokens and addresses appear
as shapes only.

## Part 1 — The checklist (no remote principal before §3 passes)

Run top to bottom. A remote principal goes live only after the
tool set is frozen, every grant is explicit, context is immutable,
and the isolation tests pass.

1. Freeze the remote tool set (§0): drop registration and fleet
   fan-out, freeze schemas, enforce in handlers — UI hiding is
   not a boundary.
2. Bind each principal to explicit grants (§1): four concepts
   kept distinct, intersection rule, RouterOS-login option with
   its vetting caveats.
3. Resolve every call to immutable context (§2): stale plans
   refused, plan/commit bound, or the staged-script default with
   its read-back traps.
4. Isolate and test (§3): precedence audit, per-request auth,
   transport traps, post-#541 error attribution.
5. Record the profile + revocation bounds (§4): audit shape,
   single-secret door credential, day-0 gates, pending list.

### 0. Freeze (the remote profile is a subset, fixed early)

Observed tool set at `a13729c` (`src/mcp/server.ts`, read this
session): `explain`, `validate`, `retrieve`, `execute`,
`devices`, `discover`. No plan/commit, token issuance, watch
registry, or call-audit API — the remote profile must not imply
them (collected: Astra §2, still true).

- The remote profile drops: `devices` add/set/remove (op
  list/show/groups read-only stay), `discover` save, and
  `execute --cmr`. CMR run-script ignores the controller login's
  policy (journaled field run 2026-10-13: a run-script needed
  only read+api) — a read-only principal with `--cmr` could write
  the whole fleet. CMR stays enrollment-only (collected:
  review-of-reviews §6).
- `confirm:true` is caller-supplied, not proof of a human decision
  (collected: Astra §2). The local double-gate (CDB `mcp=rw` +
  `confirm:true`, observed `src/mcp/safety.ts` +
  `src/mcp/tools.ts`) stays as the floor; remote approval needs a
  SEPARATE authenticated human action (§2).
- Freeze the tool list and input schemas by day 2: Muse approves
  tools one at a time after schema review, so every mid-build
  change means re-approval in Habitat A. Keep the list short
  (collected: review-of-reviews §3).
- Hiding a tool in the UI is not a security boundary. Enforce
  authorization in handlers AND filter resources by principal:
  `centrs://devices` currently snapshots the WHOLE allowlist with
  no principal parameter (observed `src/mcp/resources.ts`:
  `buildDevicesResource(config)` iterates all entries) —
  per-principal filtering is a build item, not current behavior.
- The proxy is still a 16-line constant, not a listener
  (observed `src/webproxy.ts`: `WebProxyPlan` interface +
  `webProxyPlan` value). Let the proxy/daemon own the listener
  and authenticate requests, then mount an MCP adapter over
  shared operations — no second independently secured HTTP
  server (collected: Astra §2/§5).

### 1. Bind (explicit grants, four concepts apart)

- Keep four concepts distinct: a CDB group is inventory metadata
  (record identity is `(target, user)`), NOT a RouterOS
  `/user/group`, an Access group, or an OAuth scope. Map policy
  bits, not group names — and matching email text to a username
  is not pairing (collected: Astra §3–§4).
- Choose whose authority executes: same-principal (human login
  bound to that router + account, RouterOS enforces) or delegated
  service execution (human login authorizes an explicit grant to
  an agent; the APP is now an authorization authority — log both
  identities, never claim the router evaluated the human's
  permissions). Smallest slice: one router, one explicit account
  binding, read/validate first (collected: Astra §3).
- Effective permission is an intersection: `authenticated
  principal ∩ explicit app grant ∩ allowed CDB record ∩ mcp
  policy ∩ executing RouterOS account rights ∩ required human
  approval`. Syntax validation is another required execution
  gate, not an authorization term (collected: Astra §3).
- Principal-to-record grants live in app authorization state (a
  small SQLite store for grants/plans/audit is reasonable — not a
  second device inventory, not bearers in comment-kv text). This
  extends the existing MCP boundary (CDB membership); document the
  extension deliberately (collected: Astra §4).
- RouterOS-login option (collected: app-design addendum): the app
  login validates presented credentials with a real local login;
  that RouterOS user IS the principal; scopes derive from groups;
  revocation is disable/delete with short-lived bearers or a
  re-validation cadence. Carried vetting caveats (collected:
  Astra §3): management-login TOTP is UNPROVEN (`otp-secret` is
  hotspot/UM TOTP, not a `/user` REST/native second factor —
  exclude unless an end-to-end test proves the route); the
  `sensitive`-store state idea is deferred (no established
  round-trip/secrecy/deletion/backup contract — use an explicit
  private volume + memory-only expiring sessions; an encrypted
  CDB still needs an unlock secret, document that custody).
- Device half is #26: never the default `read` group (carries
  reboot/sensitive/password/sniff); REST needs `api` + `rest-api`
  before 7.26beta3.

### 2. Immobilize (stale plans die; approval is separate)

- Resolve authorization and execution to the SAME immutable
  request context: principal, exact record/account, endpoint,
  transport, policy revision. Current MCP checks load the CDB and
  core resolves again — remote approval widens that race. Refuse
  stale plans or execute their explicitly bound snapshot under a
  still-valid grant. Never a mutable array index as a durable
  plan identity (collected: Astra §4).
- Plan/commit done right: the plan binds requester +
  resolved account/targets + exact command bytes + expected
  relevant state + policy revision + expiry. A SEPARATE
  authenticated human action approves that immutable plan; commit
  takes its identifier, not replacement commands. Changed state
  or policy needs renewed review; revalidate through centrs at
  execution time. Two calls where the same agent approves its own
  plan are not human approval (collected: Astra §6).
- Cheaper default write slice: `propose` validates through
  centrs, stages the commands as `/system/script`
  `muse-plan-<id>` (comment holds requester + call id +
  validation result), returns a WebFig deep link — the HUMAN
  approves by running it under their own login, and RouterOS
  checks the runner's rights (verified CHR 7.25: a no-write
  runner is refused `(9)`). Traps, all verified: a creator wider
  than their own policy gets `201 Created` with the policy
  quietly narrowed, `source` EMPTIED, `invalid=true` — read back
  and fail closed; restrict any run action to `muse-plan-*`
  names with `run-count=0`; staged text is visible to router
  readers — never stage secrets. Cost, stated honestly: the
  proposing account needs `write`, so the centrs profile — not
  RouterOS — stops direct writes (dedicated account, no
  policy/sensitive/reboot, `propose` the only writer, under
  test); no automatic rollback (human turns on Safe Mode before
  running); approval happens in RouterOS UI, not Muse
  (collected: review-of-reviews §5 + homework §2).
- Cards vs assurance: Muse per-action approval cards (phone tap)
  are the EXPERIENCE; staged-script / plan-commit is the
  ASSURANCE — the server cannot verify a human clicked a card.
  Card for the experience, staged script for the assurance
  (collected: homework §2).
- Retry/idempotency: durable operation id before dispatch; a
  repeated commit must not execute twice; a lost response after
  dispatch is OUTCOME UNKNOWN until reconciled, not "failed,
  retry" — a call id alone is not idempotency. Expiring
  in-memory plans are acceptable with enough dispatch evidence to
  avoid post-restart double-write. Never promise distributed
  exactly-once; "disconnect cannot strand a half-applied config"
  is too strong (scheduler undo is compensation, Safe Mode has
  constraints — separate tests each) (collected: Astra §6).

### 3. Isolate (audit precedence, cap transports, attribute errors)

- Credential precedence audit: environment values and
  `__default__` are local conveniences that must NEVER override
  a remote identity silently. Isolate request auth from
  process-global environment and connection pools:
  `CentrsMcpConfig.env` is not a multi-user isolation contract
  (observed `src/mcp/config.ts`; retrieve's handler does not pass
  it the way execute does — collected: Astra §4). Test handler
  reuse for multiple principals BEFORE sharing them.
- Per-request auth: authenticate every request, bind any
  transport session to its principal, restrict Host/Origin,
  limit request size/concurrency/time, close expired sessions.
  The public listener must not reach enrollment or approval
  routes. The LAN UI still needs authentication, TLS for password
  entry, and CSRF protection — "LAN only" is reachability, not
  trust (collected: Astra §5).
- Transport traps, each verified (collected: review-of-reviews
  §3, all pending re-proof on the build host): Bun.serve drops
  requests still pending at 10 s — set `idleTimeout` (max 255 s)
  or per-request `server.timeout(req, 0)`; Cloudflare cuts
  proxied responses with 524 ~100 s — cap server-side waits ~60 s
  and return "still waiting" + condition; the MCP SDK 406s when
  `Accept` lacks `text/event-stream` even in JSON-response mode
  (SDK 1.32.1) — confirm the wrapper sends both types or the
  server adds the missing one; use stateless mode with JSON
  responses (`sessionIdGenerator: undefined`, fresh transport per
  request — no sessions to lose across runs, curl-able); the
  vault never gives the secret to a sandbox process, so the HTTP
  call must go through the injecting connector — if the wrapper
  CLI cannot do remote-URL + injected auth, offer a plain JSON
  route too (day-0 ASK MUSE item).
- Error attribution, post-#541 (observed `src/protocols/
  adapter.ts` at `a13729c`): RouterOS policy refusals surface as
  `routeros/permission-denied` (the old "every 5xx is
  `transport/connection-closed`, retry" mapping is fixed — a
  denied write no longer reads as a network glitch); edge vs
  router denials split into `transport/edge-auth-failed` vs
  `transport/auth-failed` via shape inspection. 401 shapes
  (verified CHR + Access): bare `401` = RouterOS rejected
  credentials; `401` + `WWW-Authenticate: Basic` = none sent;
  `401` + `Bearer ... resource_metadata=` = rejected before
  RouterOS; Access Basic rejection is a `403`. `CF-RAY` proves
  Cloudflare was on the path, not that it denied — an origin 401
  passes through it; an edge rejection cannot contain an
  app-generated envelope if the app never ran (collected:
  review-of-reviews §2/§6 + Astra §5).

### 4. Record (audit shape, door credential, day-0 gates)

- Audit records decision, validation, and execution SEPARATELY,
  with secret-safe command handling: command text and returned
  configuration can themselves contain credentials (collected:
  Astra §6).
- Single-secret Cloudflare door credential (if the Cloudflare
  door is used): on a self-hosted Access app set
  `read_service_tokens_from_header: "Authorization"` — one header
  value, admitted as a service token. It avoids the broken DCR
  connect page AND the daily re-paste (Managed OAuth tokens
  follow the 24 h session; service tokens carry a chosen
  duration and revoke cleanly). The origin still validates the
  signed `Cf-Access-Jwt-Assertion` (issuer, audience, signature,
  time validity — never decode the opaque Bearer [REDACTED] or trust
  an email header) and maps that ONE service token to ONE
  principal: the delegated model, stated honestly. Door
  independence begins AFTER credential verification — normalize
  into an internal principal/grant context with distinct
  validators per issuer/token type; one admission path for the
  build, app-OAuth-server deferred (collected:
  review-of-reviews §4 + Astra §5).
- Day-0 gates (collected: review-of-reviews §7 + Astra §7): host
  is arm64/x86 (Bun ships no 32-bit ARM — the arm64 L009
  container precedent does not settle any other box; verify the
  selected device); vault test of the single-header token; one
  agent call through wrapper-to-remote-URL with injected auth to
  an echo endpoint (header + assertion shown, no secrets in the
  transcript); a no-header request gets the Access challenge,
  never the app.
- Pending list stays explicit: CMR enrollment seam (beta3
  re-check parked); cursor watches (ownership, retention,
  overflow/gap signaling, TTLs, cancellation, restart — deferred
  unless a demo requires them; reuse core wait/until first);
  raw streams; federation (one call, many apps — deferred, CDB
  fan-out covers the lab case).

## Part 2 — Skill doc

### Trigger

Load when: exposing centrs MCP beyond stdio; reviewing a remote
profile for authorization gaps; adding a principal, grant, or
door; auditing why a remote call was allowed or denied; "is this
token shape safe" questions. (Entry-skill +
capability-probe pattern: K22.)

### Prereqs

- centrs checkout at a known commit (reviews cite `414934e`;
  re-verified here at `a13729c`) + the two reviews + app-design
  note readable.
- The arm64/x86 host decision made (Bun platform gate).
- Device accounts already bootstrapped per #26 (custom minimal
  groups exist before grants reference them).
- A twin or disposable CHR for the isolation tests (never the
  first proof on a load-bearing box).

### Access

- Reads-first: source + help-shape reads before any profile
  change; twin proofs before production grants.
- Production grants: reads free; ANY grant widening asks the
  developer first (bigdude rule carries over).
- Never test revocation timing or credential precedence on a
  box the site depends on — twins take the reboot/retymology
  cycles.
- Pairing/grant state is never pasted between sessions — point
  at the store, cite shapes.

### Envs

| Name | Use |
|---|---|
| `CENTRS_CDB_FILE` | CDB allowlist path under review (default under `~/.config/tikoci/`) |
| `CENTRS_CDB_PASSWORD` | Decrypt password for an encrypted CDB |
| `CENTRS_*` | Precedence-audit subjects: any of these overriding a remote identity is the bug §3 hunts |

No bearer tokens, service-token pairs, or CDB passwords in env
for profile purposes. Door credentials live in the vault or the
LAN UI's store, never in the repo.

### Outputs

- Frozen remote tool list + input schemas (dated, commit-pinned).
- Grant table: principal → record → policy → approval requirement.
- Isolation test transcript: precedence, session binding,
  transport caps, error shapes — each observed or pending.
- Revocation bounds + audit shape + pending list.

### Verification

- `devices` add/set/remove, `discover` save, and `--cmr` are
  unreachable remotely — attempted calls fail closed (observed,
  not inferred from UI).
- Every grant names its principal, record, policy bit source,
  and approval path; no name-match pairing anywhere.
- A stale plan (changed record/policy between approve and
  commit) refuses; a retried commit does not double-execute.
- Error shapes attributed per §3 on the build firmware — no
  "retry" verdict on a deterministic denial.
- Claim audit: each hardening claim carries command + output or
  an honest collected/pending label.

### Recovery

- Suspected grant overreach → disable the RouterOS principal
  first (immediate where bearers are short-lived), then remove
  the app grant; record both with timestamps.
- Double-execution scare → reconcile via op-id dispatch log
  before any retry; outcome-unknown stays unknown until the
  read-back settles it.
- Transport failure after valid grant → suspect caps/headers
  before re-issuing credentials (§3 trap list, in order).
- Secret in the audit log → delete the value, rotate if live,
  record as an anomaly (evidence-ledger recovery precedent).

### Limits

- The reviews are source-grounded, not deployment proofs: no
  remote profile has been built and attacked yet. Every §3 test
  is pending until it runs against the real listener.
- Post-#541 code shapes here are read-verified at `a13729c`,
  not run-verified against a twin in this session.
- TOTP-for-management-login and `sensitive`-store state remain
  unproven by design decision — excluded until end-to-end tests
  establish their exact routes.
- Cursor watches, raw streams, and federation are deferred
  scope — quoted as pending, never as available.
- The single-header service token is documented Cloudflare
  behavior + review reasoning, not a live vault test — the day-0
  vault test still owns it.
