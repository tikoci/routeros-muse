# twin-run: t28-render v1 + v2 sync drill

Machine: a KVM host. Date: 2026-10-30. Target: a CHR twin (7.26beta3, x86).
Operator: a local CLI agent, inline. No secrets below.

## Pre-state (adopt)

- /app: 103 total, custom=true: *1 t26-hello-node (disabled=false, live)
- /container: *7 node:alpine stopped, *8 nginx:alpine stopped, *9 app-t26-hello-node running
- /file: 19 entries (incl. pcie1/t26/app.js 73 B from an earlier /app drill)
- Residue observed, untouched: duplicate t26 dstnat *4/*5, orphan veth-app-birdnet-go

## Deploy v1 (record hashes first)

```
python3 validate: v1 transport-safe, keys ok, 639 bytes; pyyaml parse ok
v1 root sha256: 0aeeb5cdff68981c 131 B; note sha256: e754a7b1076deb7c 38 B
centrs explain '/app/add yaml="..."' -> verdict: pass (656 bytes)
centrs execute --quickchr <twin> --yes '/app/add yaml="..."' -> *69 (native-api)
centrs execute ... '/app/set numbers=*69 use-https=no' -> ok
centrs execute ... '/app/set numbers=*69 disabled=no' -> ok (after one transient timeout, re-polled)
```

First add attempt failed offline (validation/syntax: bare `'` rejected) —
fix: wrap YAML in RouterOS `"…"` + carry `\\n` in configs content.

## Read-back v1 (served bytes)

```
container *A app-t28-render running, hosts web:172.18.0.4, cmd 'node /app.js'
/tool/fetch url=http://172.18.0.4/ -> 200, t28-v1-root.html
/tool/fetch url=http://172.18.0.4/note.txt -> 200, t28-v1-note.txt
sha256 served: root 0aeeb5cdff68981c 131 B; note e754a7b1076deb7c 38 B — MATCH
dstnat rule-level: 8081 -> 172.18.0.5-class (.4) observed
```

## Sync v2 (recreate path)

```
/app/remove numbers=*69 -> transport/timeout AND succeeded (polled: app + *A gone, cascade clean)
re-add v2 YAML -> *CF (ids not reused); use-https=no; disabled=no
container *B running, hosts web:172.18.0.5
/tool/fetch both paths -> 200
sha256 served: root e732a34105e34b42 131 B; note 622d9eb83f63184f 49 B — MATCH, both differ from v1
```

## Teardown (pre-state)

```
/app/remove numbers=*CF -> transport/timeout AND succeeded (polled clean)
cascade verified: container + veth + dstnat + bridge port removed by app (log lines)
/file/remove x4 fetch files -> all True
final: containers *7/*8/*9; apps 103/1 custom (*1); nat t26-only; files 20 (19 + box-generated autosupout.old.rif)
quickchr stop <twin> -> stopped
```

## Anomaly

23:14:20 `Automatic supout.rif file generated due to service malfunction`
during v1 start-load (same window as transient REST timeouts). Drill
completed hash-exact regardless. Supout stays on the box, local-only.
Upstream filing: left for the /app follow-up work, not filed here.
