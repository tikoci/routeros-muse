---
name: connector-onboarding-verify
description: "Onboard a service as an agent connector, then verify with harmless live reads before any grant above read-only: scaffold the connector doc, authenticate least-privilege first, print the capability probe, escalate deliberately. Use when: adding an MCP server or API as a connector, onboarding an agent to a new service, reviewing whether a 'connected' connector is actually verified, or re-approving a grant after expiry."
topics: [connector, onboarding, mcp, verification]
tested: none
---

# `connector-onboarding-verify` skill (scaffold → read-only → probe → escalate) [template v1 draft]

Promoted from two live proofs, not a design: a sandboxed T3
Connect MCP onboarding (read-only proof, then a Supervised
hello-world thread) and a sandboxed Cloudflare MCP connector
(`custom.cloudflare`, verified read set, writes explicitly untested).
Core rule, earned twice: "connected" is not verified —
print the capability probe. No secrets below; URLs, tokens, and
identifiers appear as shapes only.

## Part 1 — The checklist (harmless live reads before any wider grant)

Run top to bottom. Stop at the first grant that yields a printed
capability probe. Never approve above read-only before the probe
passes (precedent: both live connectors started read-only and only
escalated after the read set printed).

1. Scaffold the connector (§0): connector doc + helper CLI +
   tool/operation allowlist, before authenticating anything.
2. Authenticate least-privilege first (§1): read-only scopes, OAuth
   on first use, no pasted keys, no IdP passwords.
3. Run the harmless live-read probe and print the banner (§2):
   identity → accounts → inventory → one detail read, in plain
   language, with what is still untested stated alongside.
4. Escalate the grant only after the probe passes (§3): re-approve
   one rung up, re-probe, record the new grant's exact scope.
5. Record the connector doc + pending list (§4): setup, transport
   quirks, verified reads, recovery — unrun halves stay pending.

### 0. Scaffold (doc + helper + allowlist, before auth)

- Connector doc first: a `CONNECTOR.md` naming operations, limits,
  and recovery, plus a small helper CLI under the connector's own
  directory. This is the Muse custom-connector scaffold shape:
  doc + helper, then a harmless live read before trusting it
  (collected: meta tooling explainer custom-connectors flow).
- Tool allowlist is explicit and small: after schema review, list
  each tool by name. Precedent: the Cloudflare wrapper allowlists
  exactly four tools (`whoami`, `search`, `docs`, `execute`) and
  names what each does (collected: the Cloudflare onboarding notes).
- For RouterOS-facing MCP, the allowlist is the CDB: `centrs mcp`
  serves scoped tools gated by the CDB allowlist over stdio
  (observed `centrs mcp --help` 2026-10-29: `--cdb-file`,
  `--cdb-password`, and `--allow-adhoc-targets` as a reserved
  escape hatch — current tools still use CDB-only targets).
- Record the scaffold before auth: connector name, server/resource
  URL shape, auth scheme, allowlisted tools. Auth against an
  unscaffolded connector is how grants sprawl.

### 1. Authenticate (read-only first, OAuth on first use)

- Request read-only scopes to start. Precedent: Cloudflare scopes
  were read-only (`user:read account:read zone.read dns.read
  registrar-domains.read offline_access`); T3's first approval was
  Read only with a read-scope token (collected: the onboarding notes).
- OAuth on first use, no key pasting: dynamic client registration
  (token endpoint auth `none`), PKCE S256, hosted connect page.
  Both live proofs used DCR + PKCE (collected: the onboarding notes:
  DCR 201, PKCE S256, pairing-code approval, token exchange 200).
- T3's approval shape: OAuth sign-in with dynamic discovery (no
  client secret), approval via a pairing code from the host, Read
  only default, Supervised..Full selectable, ~30-day sign-ins
  (collected: the recon notes).
- Never design a step that asks for the user's IdP password: the
  Cloudflare account was Google-SSO-only, the applicant refused the
  vault password prompt, and OAuth issued by the target service was
  the path (collected: the friction log). Detect SSO-only early and
  say so instead of walking into a password wall.
- Gotchas actually hit (collected: the onboarding recon notes): pairing
  codes are single-use with a ~14 min TTL; authorization codes
  expire in minutes — feed the callback immediately; browser
  loopback is not sandbox loopback, so hand-carry the callback URL
  fast; the QR-screen code is the add-device kind, not
  agent-approval; where urllib is blocked, use curl.
- Deliver OAuth URLs as raw code blocks, not rendered link cards:
  the card "gets furl'ed" twice; code-block cut-and-paste worked
  first try (collected: the friction log).

### 2. Probe (harmless live reads, printed as a banner)

- The probe is a fixed ladder, cheapest first (Cloudflare shape,
  collected): `whoami` (identity) → accounts list → inventory list
  (zones) → one detail read (DNS records) → empty-state check
  (tunnels: none). T3's read-only rung verified `tools/list`
  (66 tools incl. project/thread tools) and initialize OK
  (collected: the recon notes).
- Print the banner in plain language with evidence: account email
  shape, inventory names + statuses, counts, and what is still
  untested. The platform marks the connector connected the moment
  OAuth completes, with no credential check — the printed probe is
  what makes the setup trustworthy (collected: the friction log).
- State what was NOT proven alongside what was: Cloudflare writes
  through `execute` were explicitly untested whatever the token
  scopes allow; the T3 token was one-shot (process memory only) —
  proof, not a durable connection (collected: the onboarding notes).
- Label every probe claim per evidence-ledger: observed (ran here,
  output in the ledger), collected (cited source), inferred (chain
  shown), pending (named, un-run). A connector verdict without
  labels is a rumor with confidence.
- First-contact parallel: prove auth with a read, not a write
  (first-contact step 3). Transport papercuts are diagnosed once
  and recorded in the connector doc — e.g. the sandbox's urllib
  signature ban (Error 1010) needed curl + a 0600 temp config
  deleted after each call, so no future agent re-diagnoses it or,
  worse, re-registers the credential (collected: the friction log).

### 3. Escalate (one rung, re-probed, re-recorded)

- Escalation is a second approval, not a settings tweak: T3's
  Supervised rung was a fresh OAuth flow (read+operate scopes,
  approval-required runtime), then a hello-world thread on a
  scratch project — run completed, no edits, no tool use, no
  pending approvals (collected: the escalation notes).
- Re-probe after every escalation: the new grant's scope gets its
  own banner showing what the wider grant can now do — and what it
  still cannot. Provider/feature availability can be per-project
  (one provider disabled for the scratch project while another
  worked there), so probe on the project
  you will actually use.
- Sessions needing fresh pairing codes + approval each time (~1
  min) are an acceptable steady state until the durable path is
  understood; tokens are not persisted on the agent side.
  Say so in the doc instead of letting a
  "reconnect" become mystery downtime.
- Never escalate past what the task needs: read-only answers
  read-only questions. A write-shaped need gets its own approval
  rung with its own probe — and writes stay pending until one is
  actually exercised.

### 4. Record (connector doc → ledger → pending)

- The connector doc carries: setup (server shape, auth scheme,
  scopes), transport quirks, the verified read set with outputs
  trimmed to load-bearing fields, recovery steps, and the pending
  list (Cloudflare precedent: CONNECTOR.md with setup + quirk +
  reads + recovery, collected).
- Carry expected-weird states with the connector: a 522 with a
  known-benign cause still costs a diagnosis cycle unless the
  "test router, no web origin by design" fact travels with the zone
  (collected: the friction log). Test twins and test targets get the
  same treatment.
- The evidence ledger points at the probe outputs (command +
  output, trimmed honestly, secrets redacted to shapes); coord
  carries the verdict + pointer + pending list for other sessions.
  Never edit another session's post — append a follow-up citing it.
- Close checks: every allowlisted tool is probed or pending; no
  secrets in the doc (grep token/key/serial patterns); the doc
  states the grant's expiry story (TTL, one-shot vs durable).

## Part 2 — Skill doc

### Trigger

Load when: adding an MCP server or API as a connector; onboarding
an agent to a new service; reviewing whether a "connected"
connector is actually verified; re-approving a grant after expiry;
"can this agent reach X" questions. (Entry-skill +
capability-probe pattern.)

### Prereqs

- The service's API or MCP server address (shape known; the exact
  URL arrives via the Copy-URL step, never pasted from memory).
- An approval path: someone able to complete the hosted connect
  page or issue a pairing code at approval time.
- The harmless read set identified in advance (identity →
  inventory → one detail); no probe = no onboarding.
- For RouterOS MCP: centrs on PATH, CDB readable (`centrs devices
  list`); for twins, the machine running (`quickchr list`).

### Access

- Reads-first always: identity/inventory reads before any grant
  above read-only, mirroring first-contact's reads-first rule.
- Production connectors: reads free; ANY write-shaped approval
  asks the developer first (the production rule carries over).
- Credentials are surrogated or vaulted — the agent never holds
  raw tokens in chat, notes, or env dumps; local CLIs cannot
  borrow connector OAuth (friction precedent: vault releases
  nothing to a local process).
- Unattended raw-token routes (CI-style env tokens) are a
  different credential with a worse storage story: needs its own
  explicit decision, never a silent fallback.

### Envs

| Name | Use |
|---|---|
| `CENTRS_CDB_FILE` | CDB allowlist path for `centrs mcp` (default under `~/.config/tikoci/`) |
| `CENTRS_CDB_PASSWORD` | Decrypt password for an encrypted CDB |
| `CLOUDFLARE_API_TOKEN` | Documented unattended route — explicitly NOT used in the live proof; needs its own decision |

### Outputs

- Scaffold: connector doc + helper CLI + explicit tool allowlist.
- Proof banner: printed harmless-read results with shapes, plus
  the still-untested list.
- Grant record: scope, approval level, expiry/one-shot-vs-durable
  story, per-project availability notes.
- Pending list: unexercised tools (especially writes) with owners.

### Verification

- OAuth completed AND the probe printed: "connected" alone proves
  nothing (platform marks connected with no credential check).
- Every allowlisted tool is probed-observed or explicitly pending;
  writes are never inferred from scopes.
- Claim audit: each connector claim carries command + output or an
  honest collected/inferred/pending label.
- Secret scan: no tokens, passwords, private keys, serials, or
  identifying addresses in the doc or ledger.

### Recovery

- Approval expired or code consumed → fresh pairing code + re-run
  the same flow (~1 min); codes are single-use, TTL ~14 min.
- Auth-looking failure after valid grant → suspect transport
  before re-registering: check the doc's quirk list (urllib ban →
  curl; loopback mismatch → hand-carry callback).
- Custom-connector card errors → fall back to the manual OAuth
  flow as sandbox client (DCR + PKCE + pairing code) and record
  the card failure as pending-with-owner.
- Wrong-project behavior (tool works here, denied there) →
  re-probe on the target project; availability can be per-project.
- Secret pasted into the doc → delete the value, rotate if live,
  record as an anomaly (evidence-ledger recovery precedent).

### Limits

- The ladder proves what ran, not what is true everywhere: grants
  expire, scopes change, per-project availability shifts — re-run
  beats re-cite.
- Write paths stay pending until exercised: neither live proof
  ran a connector write, and token scopes never imply write
  behavior. Any write claim without a run is pending, full stop.
- The durable T3 connector card path is unresolved (card errored
  twice; manual re-flow is the workaround) — sessions still need
  fresh pairing codes until that is understood.
- `centrs mcp` shapes here are help-verified (`--help` output
  observed), not run-verified: no live stdio session with
  tools/list against a twin is recorded yet.
- Directory distribution (offering a connector to other users) is
  out of scope: separate review path, no published SDK as of the
  collected note — re-verify before quoting externally.
