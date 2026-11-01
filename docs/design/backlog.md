# Build backlog — RETIRED as a tracker (2026-10-27)

Live state moved to `../records/` (`tasks.toml`, `decisions.toml`,
`needs.toml`, `concepts.toml`); agents query it with `make plan` /
`make check` in `records/`. Standing rules live in `~/AGENTS.md` and
`../AGENTS.md`. Start at `../NEEDS.md`, not here.

Mapping of this file's old queues into records: queued 1→T2, 2→T20,
3→T12, 4→T14; blocked netinstall→T17, muse-app recipes→T19,
enbeep commit→T11, SAM→T18.

Below: the 2026-10-26 snapshot, kept for provenance. It is history,
not state — several entries are stale (bisection finished, triage
recovered, T3/T6/T10/T16 done; see records/).

--- snapshot 2026-10-26 ---

# Build backlog (live)

Developer reads this instead of prompting. Updated by agents as work lands.
Last: 2026-10-26 — bisection running, centrs-triage in developer-started session.

## Standing rules (developer-set 2026-10-26)

- bigdude: reads free; ANY write asks first. Twins: anything goes.
- Never print/commit/paste creds, tokens, serials, public IPs. Captures stay local.
- Claim = command + output. Unrun = pending. Reproduce locally before generalizing.
- Bun-first TS, zero deps for prototypes; anchor tests; Makefile automation.
- Upstream fixes go upstream as PRs; no forks. Check open issues before filing.

## Done

- orca grounding (toolchain pins, rosetta pre-warm, skills pin verified)
- pull + checker prototypes (16/16 tests green; bigdude full pull ok)
- D1–D4 (direct export, mac-telnet negative → issue, SSH key installed, staged unused)
- twin2 built; UM incident reproduced (verdict GO)
- tikoci-issues.md seeded (8 items); centrs-triage prompt handed off

## Running

- **centrs triage** (developer-started `muse` in ~/Projects/tikoci/centrs).
- Nothing of mine is running — clean handover point (see below).

## Handover state (no restart needed)

- **MCP wiring UNWOUND (developer call 2026-10-26).** Daemon stopped, port 8080
  closed, `settings.json` restored to pre-MCP (backup consumed). Reason:
  DB contention risk with the centrs session's `rosetta@next` (PID 87740,
  left running — not ours). Shell path (`browse --once`) stays the rosetta
  interface until the CLI work below lands.
- **Rosetta CLI triage prompt ready:** `notes/rosetta-cli-prompt.md` — paste
  to an agent rooted in ~/Projects/tikoci/rosetta. Scopes machine-readable
  CLI output, CLI↔MCP parity gaps, --help audit, DB hygiene.
- Successor orientation: this file + `notes/orca-setup.md`; twins
  twin1 (clean) / twin2 (wedged UM) / twin4 (container-tested) running;
  work server on :8471; next queued item is the Rosetta curation probe.

## Recently landed

- **UM bisection DONE**: failure = second disk AND ≥2 levels below mount
  (S2/C2 FAIL, S1/B2/B3 PASS, depth-0 rejected as untestable). Wedged UM is
  fully unmanageable except fresh-dir escape; no self-recovery; deterministic
  across reboots. twin2 left wedged on /pcie1/c1/c2. Version axis (7.25)
  still open. Notes: `notes/twin2-bisection.md`.
- **centrs-as-app feasibility DONE**: Bun-on-bigdude definitively NO
  (64-bit-only, two sources); Node port possible-but-unproven (bounded
  ~12-API port, `bun build --target node` output not runnable today);
  hello-world container PROVEN on twin4; bigdude runs forgejo +
  community-arm32 cloudflared on /disk1, device-mode container=true.
  Notes: `notes/app-feasibility.md`.

## Queued (autonomous-ready)

1. Rosetta CLI surfacing (developer-flagged): machine-readable `browse --once`
   output, auditable --help; matters more than MCP polish (muse-app path)
2. Rosetta curation probe (product/device tables as structured source)
3. Scheduled look-after loop on orca (cron pull + diff + notify)
4. Repo skeleton (local git, Track B only) — light developer review before GitHub

## Blocked on developer

- Netinstall timing for bigdude (backup exists, non-critical — developer schedules)
- muse-app result-return recipes (needs Habitat A / phone-side access)
- enbeep local repo unstaged-commit pending (developer says commit; then ship + IG; repo `~/Projects/tikoci/enbeep`, note `notes/enbeep-bigdude.md`)
- SAM spike (needs Habitat A compute)
