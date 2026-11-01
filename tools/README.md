# tools/ — our executables (pinned, tested, zero-dep)

Owner-facing scripts the agent runs against an instantiated network.
Each tool is a Bun script with a co-located `*.test.ts` run by
`bun test`. Referenced from `workspace.toml [pins]` (tool version).

- `check-skills.ts` — skill gate: shape + playbook + tested-references.
  `bun tools/check-skills.ts [skills-root]` (default
  `templates/network/skills`); topic vocab in `skill-topics.txt`.
- `ui-smoke.ts` — hermetic browser smoke for the web UI (T43 standing
  rule): temp workspace + temp muse home, echo provider, real server
  in-process, playwright chromium. Run `make smoke`; screenshots land
  in `out/ui-smoke/`.
- `pull/` — router capture (`pull.ts`) plus capture verifier
  (`checker.ts`) over shared `sanitize.ts` (redact, volatile-strip,
  hash, serial gate). Captures land in `out/` (local-only, never
  committed). Make targets: `pull-twin`, `pull-host`, `check`,
  `check-all`. Details in `pull/README.md`.
