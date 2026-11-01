# T30 proof — `bunx routeros-muse` Mode A prototype (2026-11-01)

Landed in `proto/routeros-muse/` (prototype home; T14 staging
promotes it to its own top-level home per T29 §6). Bun-first TS,
`make test`, no new deps. Contract: T29 Final (D20).

## Runs (orca, Bun 1.4.4)

`make test` → 25 pass, 0 fail (workspace validate ×5, conflict
names/walk ×4, git urls ×2, handoff ×2, doctor merge/spec ×4, mode ×1,
router flag ×2, tcp probe ×1, pins ×2, version ×1).

End-to-end on a demo workspace (`/tmp/t30-demo`, pins matching the
orca trilogy 0.5.2 / 0.1.9-next / 0.11.3, one shaped handoff, one
inbox note, one `doctor.local.toml` addition):

- `bun src/index.ts /tmp/t30-demo --print-only` → exit 0, all six
  steps green, `capability mode: full` (doctor ok kvm/tcg, 10 twins
  defined / 0 running, MNDP 1 neighbor), doctor reports all tiers +
  the merged `demo-relay` MISS (helpful, non-blocking), handoff
  listed with owner/status/DoD, `Next: run \`muse\``.
- `bun src/index.ts /home/amm0bot/Work/template --print-only` →
  exit 2 at 4b: `Unpinned [pins] entries block the bootstrap
  ([pins].centrs, [pins].rosetta)` with per-entry TODOs naming the
  installed versions + resume line. Exactly the §6 load-bearing rule.
- `bun src/index.ts file:///tmp/t30-demo.git --print-only` (fresh
  target) → exit 0: `$ git clone ...` echoed, workspace valid, mode
  full. Stray clone removed after.
- `--router 127.0.0.1:18923` against a loopback listener → `lan:
  reachable (MNDP (1 neighbor); --router port 18923 open)`.
  Listener stopped after; port verified closed.
- `--yolo` → `Next: run \`muse --yolo\``; the flag touches only the
  launch line (never installs/sudo).

## Decisions taken inside the contract

- Pins live in the workspace, so step 2 detects installed versions
  and the compare runs at 4b after the workspace opens. Unpinned →
  named-TODO block; mismatch → report, align under the one-yes, or
  stop with fix + resume (D13 fallback).
- One-yes is lazy and asked at most once per run (`--yes`
  grants); non-TTY need stops with a resume line.
- Auth is a heuristic (META_API_KEY, else non-empty
  `~/.config/muse/auth.json`); there is no non-interactive whoami.
  Unauthenticated prints `muse login` flow + resume, then stops.
- twinCapable = `quickchr doctor --json` ok; defined/running counts
  are detail (stopped twins are agent-startable).
- LAN = MNDP count > 0 OR `--router` TCP connect (default ports
  8728/8291/22). Doctor prints counts only, never neighbor addresses.
- Fourth mode `twin-only` (twins yes, LAN no): reported, not folded.
- Doctor runs in the probe (it needs the workspace merge); missing
  `required` blocks after the full report. Workspace additions file
  is `doctor.local.toml`. Conflict patterns: `conflicted copy` /
  `sync-conflict` anywhere, Drive ` (N)` dupes for .md/.toml only.
- `muse` installer encoded from Meta's own install page
  (developer.meta.com/ai/products/muse-code): `curl -fsSL
  https://dev.meta.ai/install.sh | bash` (mac/linux, echoed, under
  the one-yes), `irm ... install.ps1 | iex` print-only on Windows.

## Unrun (pending, needs other machines)

muse-install attempt, trilogy align-install, auth walkthrough,
interactive consent prompt, launch exec, macOS/Windows paths.
`--install-global` deferred to T14. No secrets in the tree.
