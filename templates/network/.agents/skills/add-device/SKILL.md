---
name: add-device
description: "Add a RouterOS box to the workspace: check the registry first, open the UI Add-device dialog prefilled with host and user, never touch a password in chat. Use when: the owner asks to add/register/onboard a device, gives you a new host, or asks how to get you a password securely."
topics: [cdb, contact, onboarding]
tested: none
---

# `add-device` skill (check → dialog → verify)

The password never enters chat, prompts, tool calls, or the terminal.
The owner types it in the UI dialog; the server writes `router.toml`
and the CDB record. An agent that asks for the password in chat —
or seeds the CDB from a terminal — is doing it wrong.

## Part 1 — The checklist (check-dialog-verify)

Run top to bottom. Never skip step 1 (a duplicate wastes the
owner's dialog), never ask for a password at any step.

1. Check first: is the host already registered (step 0)?
2. Open the dialog with `ui_add_device`, prefilled (step 1).
3. Tell the owner the dialog is open and wait — do not poll (step 2).
4. Verify afterwards: card plus credential read (step 3).

### 0. Check (duplicate-first, read-only)

- `centrs devices list` on the CLI (seeded shell rules cover
  reads; the MCP `centrs_devices` `op=list` also works but is
  deliberately unseeded — it will ask the owner to approve):
  if the host is already a target, stop and open that card
  instead of adding. Same rule for `router.toml`: a `[device]`
  with that host or id means it is already registered.
- Reads only. No writes, no password prompts, no `devices add`
  from the terminal — the CDB write happens through the UI save
  (step 2), never from your shell.

### 1. Open the dialog (prefilled, password-free)

- Call `ui_add_device` with `host` and `user` (plus `id` only
  when the owner names one; otherwise the server derives the
  slug from the host). This opens the UI Add-device dialog
  with the user prefilled and the host shown read-only.
- NEVER ask for or accept a password in chat — not in prose,
  not in a prompt, not as a tool argument. If the owner offers
  one, refuse it and point at the dialog.
- The call returns `add-device dialog opened for <host>`: that
  means the dialog is OPEN, not that the device was added. The
  owner may cancel. Never claim the device was added.

### 2. Hand off to the owner (then wait)

- Tell the owner the Add device dialog is open for the host,
  that saving adds it to `router.toml` plus creates the CDB
  record, and that typing the password there keeps it out of
  chat and out of process arguments.
- Then wait. Do not poll, do not re-call the tool, do not
  guess whether they saved. The next step runs after they act.

### 3. Verify (card plus credential read)

- After the owner saves: the device list reloads with the new
  card — check it names the host.
- Read back through `centrs_retrieve` with a concrete path,
  e.g. `rosPath=/system/resource` (or `centrs devices
  show <host>`): a working credential read proves the record,
  not the dialog animation.
- If the save failed with an encrypted CDB, say so plainly
  (creation on encrypted CDBs waits on upstream
  `tikoci/centrs#558`) and use the card's Set credentials
  affordance as the recovery — never work around it from the
  terminal.

### Trigger

Load when: the owner asks to add, register, or onboard a box;
gives you a new IP/hostname with a login user; or asks how to
get you a password securely.

### Prereqs

- Served workspace with the UI reachable (the dialog is a UI
  surface; without it, escalate instead of improvising).
- `centrs_devices` MCP readable (or `centrs devices list` on
  the CLI) for the step-0 duplicate check.

### Access

- Read-only until the owner clicks Save: `op=list` and
  `retrieve` only. The CDB write is the owner's click in the
  UI, not your tool call.

### Envs

- None of your own. The dialog POST rides loopback; the record
  password rides centrs argv server-side (documented residual).

### Outputs

- A `[device]` block in `router.toml` (`id`, `host`,
  `cdb = "<host>"`) in workspace mode; a CDB record keyed by
  the host in both modes.

### Verification

- Step 3 every time: new card in the device list plus a
  credential readback. No card, no claim.

### Recovery

- Dialog cancelled: nothing was written; re-offer when ready.
- Save failed on the CDB half: the `router.toml` entry stays;
  recover through the card's Set credentials affordance.
- Duplicate-host refusal: open the existing card instead.

### Limits

- One device per dialog. Bulk import is out of scope.
- Encrypted-CDB creation may fail until `tikoci/centrs#558`
  lands upstream: surface it, do not work around it.
- The dialog cannot fix a wrong host: re-call with the right
  one rather than editing config by hand.
