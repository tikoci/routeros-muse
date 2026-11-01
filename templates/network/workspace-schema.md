# workspace.toml schema (v1)

`workspace.toml` defines what an owner setup is: which home this is,
what built it, how it is protected, and where it syncs. One file, read
by every session before anything else.

## [home]

- `type`: one of `private-git`, `router-container`, `router-disk`,
  `single-copy`. Matches exactly one skill under `skills/`.
- `repo`: clone URL of the canonical repo (git homes) or `local`
  with a path note (non-git homes).
- `canonical`: `true` on exactly one copy. Every other copy sets
  `false` and carries an age manifest instead of pretending.

## [pins]

Tool versions this setup was built and verified against. Unpinned
entries are TODOs, not defaults — pin before trusting a fresh
machine's output against old observations.

Resolution is driven by the routeros-muse package.json (D26), not by
these pins: the bootstrap and server front the package's own tool
bundle on PATH, so the UI, the CLI, and agent shells all resolve the
identical builds. [pins] records what this setup was verified
against; when the running bundle differs, the bootstrap stops and
asks you to refresh the bundle or re-verify and bump the pins.

A pin of `"next"` is a channel pin: it tracks the `@next` dist-tag
instead of a fixed version, resolving through the registry at
bootstrap. During preview the chat tools (quickchr, centrs) ride the
channel; a release build running where the channel is pinned is a
mismatch and the bootstrap stops with refresh-or-bump remedies.

## [backup]

- `location` + `cadence`: the owner's choice of mechanism and rhythm.
- `restore_tested`: date of the last TESTED restore, or `never`.
  Required from day one on serverless homes; good hygiene everywhere.

## [upstreams]

Each entry names ONE sync relationship and its single allowed
direction. Legal directions: `push/pull` (git remote, main only),
`pull only` (router-owned dirs), `deploy + read-back` (served
artifacts). There is no entry whose direction is "both ways" — that
shape is forbidden, not merely discouraged.

## Growth

Second site, second repo, or a split home: extend `[upstreams]`, never
duplicate this file. If two files both claim `canonical = true`, stop
and reconcile before any other work.
