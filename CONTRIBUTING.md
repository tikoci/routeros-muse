# Contributing to routeros-muse

> Owner-facing: **[README.md](./README.md)**. Agent rules: **[AGENTS.md](./AGENTS.md)**.
> Security model: **[SECURITY.md](./SECURITY.md)**.

## Tracking work

Each kind of content has one home:

| Content | Home |
|---------|------|
| The plan of record: tasks, decisions, upstream needs | `records/*.toml` (`make -C records plan`) |
| Reports and proposals from outside, public discussion | [GitHub Issues](https://github.com/tikoci/routeros-muse/issues) |
| How the pieces fit, design notes | `docs/` |
| Narrative history | git history |

An issue that turns into work gets a record (`T…`, or `D…` for a decision), and
the issue names that record. Records stay the source of truth: an issue never
mirrors a record's status. Needs on quickchr, centrs or rosetta are filed as
issues in *those* repos and tracked in `records/needs.toml`.

Issue templates: **Bug report**, **Task**, **Needs a decision**, **Research**.
Every one states a **Done-when**. Security problems go to a
[private advisory](https://github.com/tikoci/routeros-muse/security/advisories/new),
never a public issue.

## Branches and pull requests

- `main` is protected: all changes land by PR. Branch from `main` with a short
  slug (`t166-composer-freetext`, `fix-sse-reconnect`); tool-made branches
  (`t3/…`, `copilot/…`) are fine.
- **Squash-only.** The PR title becomes the commit subject on `main`: imperative,
  short, record ID in parentheses — `Composer answers a pending question as
  freeText (T166)`. Branches auto-delete on merge.
- Keep a PR to one change. Do not fix unrelated things in passing; file them.
- **CI must be green**: lint + records + skills, the test suite, the UI smoke
  (`.github/workflows/ci.yml`, the same stages as `make gate`).
- **Review is part of the gate.** CodeRabbit reviews a PR once, when it is
  marked *ready for review* (drafts are skipped; ask again with an
  `@coderabbitai review` comment). Before merging: wait for the review to
  post, answer every finding (fix it, or reply with evidence for not), and
  **resolve every conversation** — replying does not resolve, and an open
  thread blocks the merge.

## Releasing

Maintainer-triggered from `main` (`.github/workflows/release.yml`):

```sh
gh workflow run release.yml -f dry-run=true      # every gate, publishes nothing
gh workflow run release.yml                      # @next: <base>-next.<run>
gh workflow run release.yml -f channel=latest    # the committed X.Y.Z, tag + GitHub Release
```

`next` needs no commit: the version is computed in the runner. For `latest`,
first land a PR that sets `package.json` to the plain `X.Y.Z`. A `latest`
release moves `next` onto it, so `@next` is never older than `@latest`.
While 0.x, a breaking CLI or workspace-format change bumps the minor version.

## Development

```sh
bun install
bun src/index.ts --help        # run the CLI from source
make gate                      # biome + tsc, skill gate, bun test, UI smoke, TMPDIR leak check
make -C records check          # validate the tracker
```

Requirements: [Bun](https://bun.sh) (version in `.bun-version`); playwright
chromium for the smoke (`bunx playwright install chromium`); QEMU + quickchr
only for live CHR grounding. The suite is hermetic (temp workspace and home,
fake muse provider): it needs no router and no signed-in agent.
