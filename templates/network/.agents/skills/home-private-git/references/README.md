# references/ — worked examples with proof

Code here is executed, not just read: the repo's skill gate runs
`test.sh` and fails on nonzero. Docs (`*.md`) need no entrypoint.

- `test.sh` — proves the capture boundary (conventions: raw pulls
  local-only, redacted summaries commit) by building a scratch repo
  from the template `.gitignore` and asserting, per path, what git
  tracks vs ignores. Needs: `sh`, `git`.
