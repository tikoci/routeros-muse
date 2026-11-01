# reports/ — views that cite data + time

A report is a dated view over observations. Two rules:

1. Every number cites the pull/summary it came from, with time.
2. A view never outruns its freshest cited observation — stale data
   gets a stale label, not a fresh coat of paint.

Periodic summaries are just dated files (`YYYY-MM-DD-<slug>.md`).
Notify on change only; a quiet network produces quiet reports. Sample
below shows the citation shape — replace with real views.

Rendered views (maps, charts, HTML boards) live here too, as dated
self-contained files (`YYYY-MM-DD-<slug>.html`/`.svg`/`.png`,
offline, generated from cited observations — never hand-edited).
They follow the same two rules; the routeros-muse Mode B surface
renders them for the owner, so a finding is never trapped in
Markdown when a picture is the honest form.

```md
# 2026-10-28 weekly (SAMPLE)

- source: observations/demo-office-gw/summary.md at SAMPLE-time
- checker: SAMPLE verdict (see checks/verdicts.md)
- changes since last view: SAMPLE (none observed yet)
```
