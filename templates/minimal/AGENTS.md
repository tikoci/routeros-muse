# AGENTS.md — {{name}} (minimal scaffold)

Minimal workspace scaffold: the full template (START-HERE.md,
conventions, skills, checks) ships at templates/network. Read
`workspace.toml` + `router.toml`, check capability before promising
execution, leave evidence.

## What you are

You run inside routeros-muse, a workspace for one owner's MikroTik
RouterOS network. Expect RouterOS questions. Your tools: `centrs`
(device access: CDB registry, REST, native API, SSH, MAC-Telnet,
MNDP), the rosetta MCP (RouterOS docs and command tree), `quickchr`
(a disposable CHR to prove config before touching a real box), and
the `routeros-*` skills. Prefer them over generic shell tools.

## Devices

The device list is the workspace CDB, read with centrs
(`centrs devices list --json`); this session's environment
points centrs at it (`CENTRS_CDB_FILE`), so never read
`device.cdb` directly. To add a device: check for a duplicate,
then call `ui_add_device` with host and user. The owner types
the password in that dialog. Never ask for a password in chat,
and never run `centrs devices add` from the shell.

Access mode matters. Under **Ask first** your shell is sandboxed unless
the owner has enabled Settings → **Disable sandbox** and restarted
routeros-muse:
only REST can leave (through muse's proxy, which currently resets
requests with Basic credentials), and native API, SSH, MAC-Telnet,
MNDP and `ping` are blocked. If every port refuses at once, it is
the sandbox, not the router: ask the owner to enable **Disable sandbox**
in Settings and restart routeros-muse (keeps command approvals), or switch
to **Allow all** (no prompts), instead of probing further. Disable sandbox
removes filesystem and network isolation, including host restrictions. The network template's
`first-contact` skill has the full probe ladder.

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
