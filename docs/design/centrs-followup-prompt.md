# Handoff prompt: centrs follow-through agent

Paste to a Muse agent whose working root is the centrs checkout
(`~/Projects/tikoci/centrs` on orca). Continues T22 with upstream
comments + issues + small PRs. Parent context:
~/Work/notes/t22-centrs-align.md (13-gap list, split proposal),
~/Work/notes/t9-cdb.md (credential baseline + proposal),
~/Work/notes/t9-decision.md (6 developer rulings — read first),
~/Work/notes/app-feasibility.md §3 (Node-port census + failures).

---

You are working in the tikoci/centrs repo (`~/Projects/tikoci/centrs`).
Read its `AGENTS.md`/`CONTRIBUTING.md` and governing instruction files
first — they rule merges, tests, and review gates; what follows is the
assignment. Prior research (2026-10-28) already mapped the gaps; your
job is filing, commenting, and small PRs, not re-research. Read
`~/Work/notes/t22-centrs-align.md`,
`~/Work/notes/t9-decision.md`, and `~/Work/notes/app-feasibility.md`
§3 fully before acting.

## Work list (in order)

1. **C9 `key=` removal bug → reproduce + file (+ fix if small).**
   `devices set <t> key=` is documented to remove the token but
   stores an empty value. Reproduce on a twin (`--quickchr`), file
   the issue (none existed per 2026-10-28 search), and open a small
   PR if the fix is contained and meets repo gates.
2. **#551 `devices show` redaction → implement or scope.** Already
   filed: redact passwords by default in `show` + mutation
   envelopes, explicit opt-in flag, gate on CDB encryption state.
   Implement if contained; otherwise scope with options.
3. **Encrypt-upgrade gap → pick up #558.** Already filed:
   `devices` add-encryption command (unencrypted → encrypted,
   fresh salt, backup discipline; decrypt/rekey siblings in the
   same design pass). Verified gap: no convert/rekey exists, and
   writing with `--cdb-password` warns `cdb/password-not-needed`
   without upgrading. Implement if contained (include the
   WinBox-shared-CDB interplay); needs-decision if it changes a
   persisted-state contract — report, do not implement unasked.
4. **Account shape + OAuth escalation → scope only.** Developer
   direction (t9-decision rulings 3+6): routeros-muse defaults to
   ONE `robot` account (user picks read or write); centrs =ro/=rw
   should reinforce the actual RouterOS account type; privilege
   escalation should be OAuth-shaped (MCP requests write access
   from a valid account when the CDB is =ro or the account lacks
   perms). Map current =ro/=rw semantics vs actual perms, sketch
   the OAuth flow, report options. No implementation unasked.
5. **T22 comment list (5):** #548 fetch-upload (golden-path
   dependency, offer twin-gated acceptance), #401 session handle
   (dashboard-refresh consumer, ask next vs horizon), #147 overlap
   with C8/C10/C11, #542 creds-vs-inline-env constraint on any
   /app recipe, #150 SKILL.md adjacency. Re-read each issue head
   before commenting; keep comments short with acceptance offers.
6. **T22 file list (dup-check each first, file what is missing):**
   MCP transfer tool, Node runtime track (C12, cite the
   feasibility census), serving-story needs-decision (uploaded
   HTML → live URL: hotspot vs container vs proxy), recursive
   upload, C7 failover, C8 0-byte (reproduce on twin), C10
   naming, C11 timeout surfacing. Smallest viable issue each.

## Ground rules

- Twins are yours for repro (`--quickchr`); never delete twin1 /
  twin2. No bigdude contact without owner go-ahead (reads are
  free; ANY write asks first).
- Check open issues/PRs first; comment, don't duplicate.
- Small PRs that meet repo gates only (tests, review threads
  resolved per CONTRIBUTING); report per item as PR-opened (URL),
  commented (URL), needs-owner-decision, or duplicate-of-X.
- Never print, commit, or paste credentials, tokens, serials, or
  addresses. Treat addresses in ~/Work/notes as unshareable.
- Report back: what you filed/posted (URLs), decision questions
  with options, and anything that blocked.
