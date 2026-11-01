---
name: webfig-handoff
description: "Hand a human the router's own UI: build verified WebFig deep links with a check to run, confirm the serving layer, never guess fragments. Use when: asking an owner to review state, linking firewall/routes/interfaces/CMR views, embedding WebFig in an app, or debugging why a link shows the wrong view."
topics: [reports, webfig]
tested: none
---

# `webfig-handoff` skill (confirm serving → build link → state the check → verify render) [template v1 draft]

Promoted from the WebFig serving checks on twin1/7.26beta3
(t28-adopt-proof.md: service + webserver toggles, 200 +
`X-Frame-Options: sameorigin`, 528 KB master bundle carrying
the fragment machinery). Consumes the `routeros-webfig` DOMAIN
skill (fragment grammar, view catalog, login flow, embed
rules — browser-grounded on 7.24.5/7.26beta1) and adds OUR
procedure: confirm the serving layer on the TARGET release,
build links from the catalog (never from CLI paths), attach
the human's check, and verify the RENDER — never the HTTP
code. Render checks on 7.26beta3 need a browser and are NOT
claimed here. Build-tracker references (T/K IDs, notes paths)
are pointers pending staging scrub. No secrets below.

## Part 1 — The checklist (a link without a check is a shrug)

Run top to bottom. Every handoff is a link PLUS the sentence
that says what the human should see there.

1. Confirm the serving layer: `www`/`www-ssl` ports from
   `/ip/service`, `webfig-plain`/`webfig-secure` from
   `/ip/service/webserver`, `/webfig/` fetchable (step 0).
2. Build the link from the catalog: origin + `/webfig/` +
   catalog fragment. Never derive fragments from CLI paths
   (step 1).
3. State the human's check: one sentence — view + expected
   state + what "wrong" looks like (step 2).
4. Verify the render (browser): title + selected tab match
   the fragment. HTTP 200 proves nothing about fragments
   (step 3).
5. Send plain URL, no creds: login + any password change are
   human steps; token reuse is their browser's business (step 4).

### 0. Confirm the serving layer (reads + one fetch)

```sh
centrs execute --quickchr <twin> '/ip/service/print where name="www"'
# -> www port 80 (host-forward port goes in the URL, not the guest port)
centrs execute --quickchr <twin> '/ip/service/webserver/print'
# -> {"webfig-plain":"true",...,"webfig-secure":"true",...} on 7.26beta3
curl -s -o /dev/null -w "%{http_code}\n" http://<host-fwd>/webfig/
# -> 200 (the login app shell; ~26 KB HTML, <title>RouterOS</title>)
```

- Grounded (t28-adopt-proof.md): `/ip/service/webserver`
  EXISTS on 7.26beta3 with independent `webfig-plain` /
  `webfig-secure` toggles — WebFig can be off while REST
  answers. A working REST endpoint does NOT prove WebFig
  is served; check the toggles AND fetch `/webfig/`.
- `X-Frame-Options: sameorigin` confirmed on `/webfig/`
  (7.26beta3): a cross-origin iframe in a web dashboard
  is BLOCKED. The embed path is a native top-level
  WebView on the router origin (domain skill) — promise
  nothing else without testing the target engine.
- Fragment machinery confirmed in the served bundle:
  `master-*.js` (528 KB) contains `normalize` (25x),
  `findContainer`, `selectService`, `updateContent`,
  `doAuth` — the same functions the domain skill's
  grammar rests on. (`openWebFig` absent: renamed or
  inlined since 7.24.5 — login flow, not fragments.)

### 1. Build from the catalog, never from CLI paths

```text
https://<router-origin>/webfig/#IP:Firewall.Filter_Rules
https://<router-origin>/webfig/#IP:Addresses
https://<router-origin>/webfig/#Bridge.VLANs
```

- Grammar (domain skill): `#`[`group`:`]`service`[`.`container`],
  case-sensitive, whitespace/dots in names → underscores
  (`Filter Rules` → `Filter_Rules`). CLI paths are NOT
  fragments: `/ip/address` → `#IP:Addresses`, never `#ip:address`.
- View catalog is the domain skill's table (Connections,
  Addresses, Routes, Filter_Rules, NAT, Interface, VLAN,
  Bridge/Pors/VLANs, Users, CMR trio) — browser-opened on
  7.24.5/7.26beta1. For views outside the catalog, copy the
  URL from the target UI; menu availability varies by
  version, packages, hardware, policy, and skins.
- Object links (`...Filter_Rules.17`) are router-local
  identifiers: copy the UI-generated fragment, never append
  a REST `.id` like `*1` (domain skill). Unverifiable
  without the UI — say so when guessing.

### 2. State the human's check (the sentence that matters)

- Shape: "Review <view> for <expected>: <link>. Wrong looks
  like <concrete mismatch>." Example: "Review the bridge's
  tagged/untagged VLAN membership — ether3 should be tagged
  on 99 only: <link>. Wrong looks like an untagged row."
- The check names the VERDICT the human brings (intent,
  "that VLAN shouldn't be there") — never asks them to
  verify agent mechanics ("confirm the rule applied" is
  the agent's read-back job, #8 step 5).
- WebFig can EDIT: opening the UI is not approval of agent
  changes, and the handoff must not imply it. Machine
  config rides centrs (#8/change-apply); the human's UI is
  for inspection. Say which side each change is on.

### 3. Verify the render, never the HTTP code (browser step)

- Fragments are NEVER sent to the server (browsers strip
  `#...`; curl does too) — so no fetch, no 200, no header
  check can validate a fragment. Validity is a render
  property only (t28-adopt-proof.md, load-bearing negative).
- Unknown services/containers can SILENTLY fall back to
  another view while leaving the requested hash in the
  address bar (domain skill: `#CMR` fell back to
  Interfaces on 7.26beta1). Verify the rendered TITLE +
  selected TAB, not the URL.
- Do NOT bulk-open generated fragments: menu definitions
  include action containers, and some `doit` containers
  dispatch an operation when opened (domain skill). One
  link, one render check, by a human or a browser run.
- 7.26beta3 render checks are OPEN: the serving layer is
  confirmed here, but no browser opened these fragments
  on 7.26beta3. The first browser pass updates this skill.

### 4. Send plain URLs; login is a human step (domain flow)

- Send the URL with no password or token. Unauthenticated
  `/webfig/#...` redirects to the login view with the hash
  intact; successful login returns to the requested view;
  returning browsers reuse a `localStorage` token scoped to
  scheme/host/port (domain skill, 7.24.5 flow).
- An expired password can open `#System:Password.Change_Now`
  instead — treat login + password change as human steps,
  not agent debuggable. Default-config and first-boot flows
  may also take precedence.
- Origin discipline for handoffs: changing HTTP→HTTPS,
  changing the port, or another browser profile can force a
  fresh login. Send the EXACT origin the human should keep
  using (host-forward port for lab, stable hostname + TLS
  for deployed).

## Part 2 — Skill doc

### Trigger

Load when: asking an owner to review router state; linking
any WebFig view (firewall, routes, addresses, VLANs,
bridges, users, CMR); embedding WebFig in an app; a link
"shows the wrong view" (fallback debugging); skins/handoff
UX questions.

### Prereqs

- The `routeros-webfig` domain skill for grammar, catalog,
  login, and embed reference (this skill is procedure).
- Target reachable from the HUMAN's browser or view (agent
  loopback URLs don't transfer — check their path separately).
- Know which release serves the UI: toggles and bundle
  confirmed per release (7.26beta3 done here; others open).

### Access

- All serving checks are reads; handoff links are URLs.
  No router writes in this skill's core path.
- Skin assignment (`/user/group set skin=`) is a WRITE:
  bigdude rule — reads free, ANY write asks first.
- Never send passwords or tokens in a handoff, even to
  the owner (their login, their browser, their secret).

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |

### Outputs

- Serving record: ports, webserver toggles, `/webfig/`
  fetch result, bundle-machinery confirmation.
- Handoff: plain URL + the check sentence (view +
  expected + wrong-shape).
- Render verification: title + tab confirmed (browser),
  or explicitly OPEN with the fallback warning.
- Embed note (when asked): native-WebView constraints +
  untested-engine caveats.

### Verification

- `/webfig/` fetches 200 with the app shell on the target
  release; toggles allow the plane (plain/secure) in use.
- Fragment copied from the catalog or the live UI — never
  derived from a CLI path, never a REST `.id` suffix.
- Render: title + selected tab match (browser), or the
  handoff states render-UNVERIFIED with the fallback rule.
- The check sentence names a human verdict, not an agent
  mechanics confirmation.

### Recovery

- Link shows the wrong view → silent fallback: re-copy
  the fragment from the live UI, check version/package/
  skin differences, never re-guess the grammar.
- `/webfig/` unreachable but REST works → check
  `webfig-plain`/`webfig-secure` toggles (independent of
  REST since the webserver menu exists).
- Embed blocked/refused → `X-Frame-Options: sameorigin`:
  switch to native top-level WebView, same router origin
  for `/`, `/webfig/`, `/assets/`, `/jsproxy`.
- Login loop / token lost → origin changed (scheme, port,
  profile): re-send the exact origin, human logs in again.

### Limits

- 7.26beta3 RENDER checks are open (browser work, not done
  here); serving layer only is confirmed on this release.
- Domain catalog is 7.24.5/7.26beta1 browser work: version
  deltas (menus, skins, CMR package) need per-release eyes.
- Object-link suffixes are router-local: portable across
  neither boxes nor time. Copy, don't construct.
- Skins are UX, not a security boundary (group policies
  still govern via CLI/other tools) — domain skill.
