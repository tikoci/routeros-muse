---
name: add-device
description: "Add a RouterOS box to the workspace: check the registry first, open the UI Add-device dialog prefilled with host and user, never touch a password in chat. Use when: the owner asks to add/register/onboard a device, gives you a new host, or asks how to get you a password securely."
topics: [cdb, contact, onboarding]
tested: none
---

# `add-device` skill (check → dialog → verify)

The password never enters chat, prompts, tool calls, or the terminal.
The owner types it in the UI dialog; the server writes the CDB
record (the only device list) and regenerates `devices.toml`, its
read-only text mirror. An agent that asks for the password in chat —
or seeds the CDB from a terminal — is doing it wrong.

## Part 1 — The checklist (check-dialog-verify)

Run top to bottom. Never skip step 1 (a duplicate wastes the
owner's dialog), never ask for a password at any step.

1. Check first: is the host already registered (step 0)?
2. Open the dialog with `ui_add_device`, prefilled (step 1).
3. Tell the owner the dialog is open and wait — do not poll (step 2).
4. Verify afterwards: card plus credential read (step 3).

### 0. Check (duplicate-first, read-only)

- `centrs devices list --json` on the CLI (routine device
  work goes through the CLI, not MCP tools; it is in the
  seeded read set, so it runs without a prompt): if the host
  is already a target, stop and open that card instead of
  adding. `grep` on `devices.toml` answers the same question
  without a spawn (generated from the CDB; it can lag a change
  made outside the UI until the next device list).
- Reads only. No writes, no password prompts, no `devices add`
  from the terminal — the CDB write happens through the UI save
  (step 2), never from your shell.

### 1. Open the dialog (prefilled, password-free)

- Call `ui_add_device` with `host` and `user`. The device id is
  the host itself (the CDB target); there is no separate slug.
  This opens the UI Add-device dialog
  with the user prefilled and the host shown read-only.
- NEVER ask for or accept a password in chat — not in prose,
  not in a prompt, not as a tool argument. If the owner offers
  one, refuse it and point at the dialog.
- The call returns `add-device dialog opened for <host>`: that
  means the dialog is OPEN, not that the device was added. The
  owner may cancel. Never claim the device was added.

### 2. Hand off to the owner (then wait)

- Tell the owner the Add device dialog is open for the host,
  that saving creates the CDB record, and that typing the password there keeps it out of
  chat and out of process arguments.
- Then wait. Do not poll, do not re-call the tool, do not
  guess whether they saved. The next step runs after they act.

### 3. Verify (card plus credential read)

- After the owner saves: the device list reloads with the new
  card — check it names the host.
- Read back through `centrs retrieve <host>
  /system/resource --json` (or `centrs devices show <host>
  --json`): a working credential read proves the record,
  not the dialog animation.
- If that read fails, the record is fine but the path is not:
  switch to the `first-contact` skill (sandbox check, probe,
  transport select, non-default ports). Do not stop at a failed
  default REST read.
- If the save failed, say so plainly with the reason the
  dialog showed, and use the card's Access button as the
  recovery — never work around it from the terminal.

### Trigger

Load when: the owner asks to add, register, or onboard a box;
gives you a new IP/hostname with a login user; or asks how to
get you a password securely.

### Prereqs

- Served workspace with the UI reachable (the dialog is a UI
  surface; without it, escalate instead of improvising).
- `centrs devices list --json` on the CLI for the step-0
  duplicate check.

### Access

- Read-only until the owner clicks Save: `devices list` /
  `devices show` and `retrieve` reads only. The CDB write is
  the owner's click in the UI, not your tool call.
- After the save, credentials stay UI-only. Non-secret record
  keys (`mac=`, `via=`, `port=`) may be set later with
  `centrs devices set` as part of `first-contact`.

### Envs

- None of your own. The dialog POST rides loopback; the record
  password rides centrs argv server-side (documented residual).

### Outputs

- A CDB record keyed by the host (every mode), and in workspace
  mode a regenerated `devices.toml` (never edit it).
- Optional, yours to write: per-device intent (site, role,
  `[expect]`) in `router.toml` or `inventory/<id>.toml`, linked
  by `cdb = "<host>"`. Never copy credentials there.

### Verification

- Step 3 every time: new card in the device list plus a
  credential readback. No card, no claim.

### Recovery

- Dialog cancelled: nothing was written; re-offer when ready.
- Save failed: nothing usable was written; retry in the
  dialog, or fix an existing record through the card's Access
  button.
- Duplicate-host refusal: open the existing card instead.

### Limits

- One device per dialog. Bulk import is out of scope.
- The dialog cannot fix a wrong host: re-call with the right
  one rather than editing config by hand.
