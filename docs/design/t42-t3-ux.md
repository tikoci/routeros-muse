# T42 — t3code research, UX/rendering track (2026-11-01)

Subagent sweep of `https://github.com/pingdotgg/t3code` at commit
`6328c847` (clone at `/tmp/t42-ux`, session scratch). License MIT,
Copyright (c) 2026 T3 Tools Inc, root LICENSE only (no per-file
headers). Full report in the session tool-outputs
(`subagent-1-subagent_result.txt`). Feeds T41.

## Takeaways for our vanilla single-file UI

- Transcript grouping is a 15-row-kind state machine
  (`MessagesTimeline.logic.ts`, pure TS) — port as a grouping spec.
- Markdown runs unified/remark/rehype (all MIT, offline) — too heavy
  to hand-port; take the plugin list as a spec, render via marked or
  a build step. Copy the text-keyed render cache and the two clever
  bits: offset-based task checkboxes, widened ordered-list gutters.
- Code blocks: language header + copy + wrap toggle + conditional
  run button — straight HTML/CSS port.
- No syntax highlighter fits single-file (Pierre needs WASM); skip,
  pre-highlight, or CDN highlight.js. Stable-line streaming pattern
  ports to any tokenizer.
- Mermaid via `pele` (MIT, lighter than mermaid.js) needs a build
  step to inline. Math via KaTeX if wanted.
- Tool rows: icon + truncated label + dedup assembler for the
  expanded body (pure logic, portable); `WorkLogLine` CSS (~25
  lines) worth cloning.
- Collapsibles: native `<details>` or the `0fr→1fr` grid trick;
  keep `hiddenUntilFound` + `beforematch` for find-in-page.
- Diffs: vendor the patch normalization (`toolCallDiff.ts`), write
  our own ~150-line red/green renderer; skip Pierre's viewer.
- Streaming language is shimmer + fade, no caret; animations pause
  off-screen via a shared IntersectionObserver. Pure CSS + one
  zero-dep TS file — take verbatim.
- Tick timers via shared 1s interval writing textContent (no
  re-renders). Skip virtualization; minimap only if transcripts
  get long.

## Vendoring shortlist (all MIT, disclosure = provenance line)

1. `packages/shared/src/terminalOutput.ts` (ANSI spans + palettes,
   take the pure functions only) — highest value.
2. `apps/web/src/lib/visibleAnimation.ts` (~70 lines, whole file).
3. `index.css` shimmer + streaming-fade keyframes (rewrite
   `@utility` as plain classes).
4. `TimelineWorkEntryRow.logic.ts` expanded-body assembler (decouple
   one type from `@t3tools/contracts`).
5. `toolCallDiff.ts` + `getRenderablePatch` (moderate decoupling).

Do not touch: `@pierre/diffs/react`, `@effect/*`,
`@t3tools/client-runtime` state, TanStack Router.
