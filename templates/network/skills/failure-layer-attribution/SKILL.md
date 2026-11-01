---
name: failure-layer-attribution
description: "Attribute a failure to its layer from response shape: 401 flavors, permission-denied vs retryable, logs-first for auth, egress-vs-relay-vs-router for tunnels. Use when: a request failed and the cause is unclear, triaging retry vs fix vs escalate, or deciding whether the router, the relay, or the local sandbox is at fault."
topics: [errors, attribution, diagnosis]
tested: none
---

# `failure-layer-attribution` skill (shape → layer → logs → verdict) [template v1 draft]

Promoted from a twin denial-shape proof, an
earlier 401/500(9) matrix (VERIFIED), the
merged centrs attribution fix (tikoci/centrs#541), and a sandbox
egress matrix. No secrets below; no
credentials are needed to read an error.

## Part 1 — The checklist (never retry what refuses)

Run top to bottom. The output of every step is a named layer, not a
feeling — "the network is down" is never a verdict.

1. Read the response shape (§0–§1): status + headers + body + the
   centrs code name the layer before you touch anything else.
2. Check the router log for the auth layer (§2): login failures
   log, permission denials don't — absence is also attribution.
3. Walk the egress ladder for reachability failures (§3): local
   policy → proxy → relay → router, each with its measured shape.
4. Deliver the verdict with the retry rule (§4): retryable,
   fixable-here, or refused — and what would change the answer.

### 0. Auth shapes (401 flavors + centrs codes)

Re-verified 2026-10-29 on a CHR twin, 7.26beta3, curl + centrs
0.1.9-next. RouterOS REST 401s:

| Shape | Meaning |
|---|---|
| `401` + `WWW-Authenticate: Basic`, body `{"error":401,"message":"Unauthorized"}` | No credentials were sent |
| Bare `401` (zero `WWW-Authenticate` headers), same body | Credentials sent and rejected |
| centrs `transport/auth-failed` ("rejected the REST credentials") | The bad-credential case through the envelope |

Edge shapes (collected and VERIFIED in earlier runs; no Access
edge on the test bench, so not re-run): Cloudflare Access's 401 carries
`WWW-Authenticate: Bearer … resource_metadata=`, and its Basic
rejection is a `403`. So: Bearer-challenge or 403 = "rejected
BEFORE RouterOS" from response shape alone. Post-#541 centrs gives
edge rejections their own codes (PR title: "REST permission
refusals and edge auth rejections get their own codes") — read the
code, not the status.

First-contact corollary (first-contact): any `/rest/*` answering
401 means RouterOS v7 REST is alive but password-gated — a 401 is a
successful probe, not a failure, in that context.

### 1. Denial shapes (500 with (9) is a refusal, never a glitch)

RouterOS REST reports a policy denial as HTTP 500 with detail
`... (9)`. Pre-#541 centrs mapped every 5xx to
`transport/connection-closed` ("Retry the request") and a denied
write became `transport/write-outcome-unknown` — a group lacking
`write` got "retry, maybe it applied". That bug is fixed upstream
(#541 MERGED 2026-10-28) and the fixed behavior is proven live on
the twin:

```
code: routeros/permission-denied
summary: RouterOS refused the command for lack of permission: not enough permissions (9)
remediation: Grant the missing policy ... Retrying will not help.
context: {detail: "not enough permissions (9)", httpStatus: 500}
```

Both transports now agree: native API reports
`routeros/permission-denied` too (previously `routeros/api-trap`).
The remediation even names the version trap: "If every REST request
fails with `not allowed (9)`, the group has `rest-api` without
`api`; before RouterOS 7.26beta3, REST needs both."

Rules that fall out:

- `(9)` anywhere in the detail = permission, not transport. Never
  retry, never treat as success: the twin read-back proved the
  denied write did not apply (identity still `CHR`).
- `not allowed (9)` on EVERY request (not just writes) = the
  transport-policy gap: add `api` to the group (or move to
  7.26beta3+). This is the single most common "REST is broken"
  misdiagnosis on older firmware.
- A centrs older than the fix still says `transport/*` for these:
  check `centrs --version` before believing a retryable code on a
  500. The code names the centrs behavior, the `(9)` names the
  RouterOS truth — when they disagree, `(9)` wins.
- The misreported-as-retryable issue is fixed upstream;
  its evidence now points at the merged PR + this twin proof.

### 2. Logs first — for the AUTH layer only

"Logs first" is half-right, and the twin run drew the exact line
(`/log` tail after bad-pw + denial probes):

- Login failures ARE logged: `system,error,critical login failure
  for user <name> from <addr> via rest-api` — one line per bad
  attempt. Auth-layer attribution starts here: named user + source
  + transport, no guessing.
- Permission denials leave NO log lines. The log around a denied
  write shows only the surrounding login/logout records. The policy
  layer comes from the error code (§1), never the log — absence of
  a log line for a failed request IS the attribution (auth would
  have logged).
- Successful logins log too (`logged in/out ... via api`), which
  bounds session questions: who was in, over what transport, when.

So the order is: shape names the candidate layer (§0–§1), the log
confirms or redirects for auth, and a silent log on a failed
request convicts the policy layer. Escalate to packet capture only
when shape + log disagree — they rarely do.

### 3. Reachability ladder (policy → proxy → relay → router)

For "cannot reach it at all" failures, walk outward from the
caller. Every rung below was measured live from a sandboxed
agent environment 2026-10-28, with the LAN-workstation
side proven working the same week (vpn-setup §0):

| Rung | Failing shape (measured) | Verdict |
|---|---|---|
| Local syscall filter | UDP `sendto` → EPERM | Sandbox denies it; no transport choice fixes this |
| Platform policy | Direct TCP gets a plaintext banner (`other_tcp ... Deny`) | Policy gate, NOT a network fault; TLS dies with `WRONG_VERSION_NUMBER` because the "peer" sent text |
| Proxy traversal | cloudflared `tls: first record does not look like a TLS handshake` (quick AND http2) | Binary doesn't traverse the CONNECT proxy; direct call hit the banner — fallback can't save it |
| Relay refusal | TCP connects, relay closes before any HTTP response (curl/Python/Chromium alike) | Egress refused by the relay (`routingthecloud.net` from that sandbox); works from residential nets |
| Working rungs | HTTPS via proxy 200s, WSS 101 upgrade, MCP token exchange 200 | Plain HTTPS/WSS is the viable client shape from here |

Attribution discipline: name the rung, quote the shape, stop. The
original error in that investigation was treating cloudflared as
something the CONNECTING side runs — it sits on the far side,
dialing out; the client side is ordinary HTTPS/WSS. Most tunnel
"mysteries" are this category error, not transport faults. (Open
boundary: the Access-admission and
diagnosis halves folded here may move to the /app playbook — this
skill keeps the shape table regardless.)

### 4. Verdict (retryable / fixable / refused)

Deliver every attribution in one breath: layer + shape + rule.

- **Retryable**: genuine transport glitches (reset mid-request,
  timeout with unknown outcome on an IDEMPOTENT read). Retry with a
  bound and a backoff; writes retry only when the pre-state
  read-back proves non-application.
- **Fixable here**: wrong credentials (fix the secret, check the
  log line), missing group policy (grant + re-prove per
  agent-access-bootstrap), wrong transport for the environment (re-pick
  per vpn-setup §0), stale firmware row (add `api`, or upgrade).
- **Refused**: `(9)` denials, bare-401-after-fix attempts,
  sandbox EPERM, relay refusals. Retrying is the bug. Change the
  layer (different account, different transport, different
  environment), not the attempt count.
- Record it (evidence-ledger): the shape quoted verbatim, the
  layer named, the log lines or their absence, what would change
  the verdict. The next agent with the same shape should find your
  verdict, not re-derive it.

## Part 2 — Skill doc

### Trigger

Load when: any request to a router, relay, or edge failed and the
cause is unclear; deciding retry vs fix vs escalate; "is it the
router or the network" questions; 401/403/500s from REST, API, or a
tunnel; login failures in the log. (Entry-skill +
capability-probe pattern.)

### Prereqs

- The failure captured verbatim: status, headers, body, centrs
  code + remediation. A paraphrased error is unattributable — go
  back and get the bytes.
- centrs version known (`centrs --version`): pre/post-#541 codes
  differ, and the version decides which table row applies.
- For log confirmation: a working admin read path to `/log`
  (first-contact / agent-access-bootstrap if that's missing too).

### Access

- Attribution is read-mostly: failed requests + log reads. No
  approval needed for reads on any box (production included).
- Confirmation probes that WRITE (reproducing a denial) go to a
  twin, or ride an approved change — never probe-write production
  to satisfy curiosity.
- Quoted shapes in notes/handoff notes carry no credentials by
  construction; keep it that way (strip `Authorization` headers
  before pasting, always).

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Credentialed re-probes without secrets in argv |
| `CENTRS_TIMEOUT` | Raise before calling a slow failure a dead one |

### Outputs

- The verdict: layer + quoted shape + retry rule, one breath.
- The evidence: verbatim error, log lines or their noted absence,
  centrs version, environment + date.
- The fix or the escalation: what changes the verdict, and who
  owns it (account owner, network owner, vendor issue).

### Verification

- 401s: header presence/absence checked, not assumed (the twin
  curls are the template: `-sI` + grep count).
- Denials: read-back proves non-application before any "safe to
  retry the fix" claim.
- Log check performed and recorded either way (lines found, or
  "silent — policy layer").
- Egress verdicts name the rung + shape; environment-dated (policies
  change — the 2026-10-28 rows are not timeless).

### Recovery

- Misattributed to network, actually policy: grant the policy,
  re-prove, and correct the ledger entry (downgrades are honorable).
- Misattributed to policy, actually edge: the Bearer/403 shapes
  (§0) — fix the edge grant (Access policy, pairing, token scope),
  not the RouterOS group.
- Shape matches nothing in the tables: new shape — capture it
  fully, attribute by elimination (auth? policy? egress? relay?),
  and extend this skill. Unknown shapes are skill fuel, not dust.
- Flapping (works, fails, works): suspect timeouts/concurrency,
  not policy — policy doesn't flap. Check `Bun.serve` 10s drops
  and Cloudflare 524s (known transport traps) before re-picking.

### Limits

- CHR proof only (7.26beta3, local users): Cloudflare Access
  shapes collected-not-rerun; pre-#541 code paths described from
  the merged diff, observed only via the version gate.
- The egress ladder is environment-dated (sandbox 2026-10-28): proxy
  policies and relay behavior move; re-probe per environment.
- Log silence convicts policy ONLY for authenticated requests —
  an unauthenticated request that logs nothing may never have
  reached RouterOS (check the nearer rungs first).
- Boundary open: Access-admission/diagnosis halves may migrate
  to the /app playbook; the shape tables stay here either way.
