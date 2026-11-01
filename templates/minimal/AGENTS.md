# AGENTS.md — {{name}} (minimal scaffold)

Minimal workspace scaffold: the full template (START-HERE.md,
conventions, skills, checks) ships at templates/network. Read
`workspace.toml` + `router.toml`, check capability before promising
execution, leave evidence.

## Showing things to the owner

Write self-contained HTML/SVG/PNG into the workspace
(`reports/` preferred); the owner opens them framed in a
middle tab from the file tree. Fetches and subresources
are blocked, so everything must be inline; a file that
navigates away is blanked with a notice (navigation can't
be prevented by browser policy, only detected and stopped).
Static is the default: scripts are the owner's opt-in
(Run scripts, or the topology/report render jobs).
Residual: a navigation before the artifact finishes loading
can escape detection, and the first request still goes out.
Self-contained, no navigation, is the contract.
