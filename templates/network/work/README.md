# work/ — generated code and projects live here

The well-known spot for agent-built code in this workspace. If an
agent writes a program, a dashboard, a sensor reader, or a one-off
tool for this network, it goes in `work/<name>/` — not scattered
across the root, not inside `observations/`, not in chat.

Parable: the heltec-victron solar monitor. The shelf product was
overkill and mismatched, so the agent built a small ESP32 reader
instead. That build is a `work/` resident until it earns promotion.

## Rules for a work/ resident

1. Own directory, own README. `work/<name>/README.md` says what it
   is, how to run it, and what proves it works. Name == directory.
2. Own deps stay inside. Virtualenvs, `node_modules/`, build output,
   and firmware toolchains live in the resident's directory and are
   git-ignored there. They never leak into network records.
3. Link it where the network can find it. The README names the
   `operations/` proposal or `decisions.md` entry that asked for it.
   A resident with no link is clutter; a link with no resident is a wish.
4. No shadow management. A resident never writes to routers except
   through the workspace skills (`change-apply` + owner approval).
   Readings it produces land as files with source + time, or it says
   plainly that it has no integration surface yet.
5. Status is honest. Start at `spike` (unshaped, no reliance).
   `active` means the owner relies on it. Every resident ends in
   one of two ways: integrate (graduate to a managed skill/surface)
   or retire (note what replaced it). No permanent limbo.

## work/ vs a sidecar

- Small and workspace-local (a script, a report generator, a probe):
  stays in `work/`.
- Grows its own lifecycle, hardware, or release rhythm (the ESP32
  monitor with firmware and a LoRa future): promote it to a sibling
  sidecar directory beside the workspace, per the `sidecar-projects`
  skill, with a `sidecar.toml` manifest. `work/` then keeps only a
  pointer README naming the new home.

## What never lives here

- Router captures (those are `observations/`, read-only evidence).
- Secrets, tokens, or per-device credentials (never committed anywhere).
- The plan itself (`router.toml`/`inventory/` own intent).
