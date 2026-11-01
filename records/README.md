# records — structured tracking (source of truth)

`.md` is for prose. Tracking lives here, in TOML agents can read, diff,
and query. This directory is the project's durable memory: if it is not
in a record, it is not decided, not open, not done.
`notes/*` paths in evidence fields refer to the ~/Work archive unless the file exists under docs/design/.

## Files

- `needs.toml` — what routeros-muse needs from quickchr/centrs/rosetta
  (IDs: `C` centrs, `Q` quickchr, `R` rosetta, `S` shared/design)
- `tasks.toml` — research + build tasks with dependencies (IDs: `T`)
- `decisions.toml` — developer decisions, open and recorded (IDs: `D`)
- `concepts.toml` — system concepts absorbed from the Drive design docs
  (IDs: `K`), each with source doc + which tasks it informs

## Query

```sh
make plan    # open decisions (the G0 gate) + tasks in dependency order (start here)
make needs   # open needs by repo
make tasks   # open tasks
make check   # validate all records (run before claiming an update)
```

`bun records.ts needs --repo centrs --tsv` filters and emits TSV.

## Status values

- needs/tasks: `needed` · `active` (set `agent`) · `landed`/`done` ·
  `blocked` (say by what: `blocked_by` or external note in `detail`) ·
  `dropped` (say why in `detail`, never delete the record)
- decisions: `open` · `decided` (set `decided` date + `outcome`)
- concepts: `adopted` (we practice it) · `proposed` (template input) ·
  `retired` (say why in `statement`, never delete the record)

## Write rules

1. One change updates the record in the same step that does the work.
2. `blocked_by` holds record IDs only (`D1`, `T9`); every ID must exist.
   `S` needs mirror `T` tasks one-to-one (S1↔T8, S2↔T9, S3↔T6, S4↔T5):
   close both records together, never one alone.
3. Keep to the strict TOML subset below so `records.ts` (zero deps)
   keeps parsing: `[[table]]` headers, `key = "one-line string"`,
   `key = ["a", "b"]` one-line arrays, `#` comments. No multiline
   strings, no inline tables, no bare values.
4. After editing: `make check` must pass. Then post status to the coord
   room if another session should know.
