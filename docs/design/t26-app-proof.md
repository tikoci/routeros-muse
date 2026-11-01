# T26 — /app + container proving runs (twin4 + twin-app, 7.26beta3 x86) [2026-10-29]

Record: T26 active (habitat-c). Lane-1 groundwork: prove what the /app
playbook rests on. All commands ran against lab twins; twins stopped at
the end (prior state restored). twin-app kept as the dirty-work box.
No secrets below.

## Proven green

1. Static YAML validation: minimal node .tikapp.yaml VALID against
   restraml docs/7.26beta3/routeros-app-yaml-schema.json (exact-version
   schema; bun + repo-local ajv; scratch /tmp/t26-validate.mjs).
2. /app/add takes `yaml=` INLINE on 7.26beta3 (NOT the skill's
   `yaml-url=` — probed url/file/yaml/src/path, only `yaml` accepted;
   passing a URL stores it literally, no fetch). Quoting rules found:
   ASCII-only payload (em-dash rejected offline), single-quote YAML
   style (inner double quotes break CLI wrapping). App *68 created,
   read back by name. FINDING for T27: routeros-app-yaml documents
   yaml-url= — drift on current firmware.
3. Fresh-CHR provisioning path: `--add-disk 2G --add-package container
   --device-mode-enable container` at add → first boot verifies
   mode=rose container=yes; container pkg present (fresh CHR ships
   routeros-only — twin-app v1 proved the negative).
4. /app requires a configured install disk: /disk/format + pcie1,
   /app/settings/set disk=pcie1. `disk=system` rejected (needs a real
   /disk entry). Matches container-skill §1 disk-check rule.
5. Plain containers on CHR free: node:alpine pulled (v26.13.0),
   executes JS (`--version` → v26.13.0 exit 0; `-e console.log(42)` →
   42 exit 0). nginx:alpine serves HTTP 200 "Welcome to nginx!",
   read back router-side via /tool/fetch. Networking: veth + bridge +
   masquerade, all via centrs.

## Proven green, part 2: /app RUNS on CHR (correction 2026-10-29)

6. /app RUNS on CHR free — the earlier "blocked" call was the classic
   mistake this playbook must teach. The gate was `use-https=true`
   (default), which needs /ip/cloud DDNS+certs (paid-license
   territory; a trial would NOT help). Testing pattern:
   `/app/set numbers=<id> use-https=no` → app pulls, runs, serves.
   Background (developer): Mikrotik gives /app a unique domain and
   public DNS serves the container's private IP, enabling LAN SSL;
   without cloud, add SSL manually via /ip/reverse-proxy if a public
   IP exists (not the immediate case).
7. End-to-end proof: t26-hello-node (node:alpine, server.js via
   configs:, single-quote YAML) pulled, started, and served HTTP 200
   `t26-ok`, read back router-side via /tool/fetch to the container IP
   172.18.0.2. YAML-with-single-quotes survives the CLI transport
   intact (configs content verified by behavior).
8. Published-port note: /app created the correct dstnat rule
   (10.0.2.15:8080 → 172.18.0.2:80, ui-url recorded), but router-side
   fetch to :8080 is refused — expected, since router-originated
   packets bypass dstnat. Published path verified at RULE level on
   CHR; packet-level check needs hardware or a host forward.
9. Debugging notes: `.about` carries the real error (native-api may
   hide pending/transitory ones — a listen may be needed); first
   `use-https=no` set returned False yet the flow proceeded — always
   verify by read-back, never trust the return alone.

## Quirks documented (playbook material)

- `cmd` is comma-hostile: arrays get mangled (`[,--version,]` passed
  literally → MODULE_NOT_FOUND); multi-arg strings work ONLY via the
  CLI path with zero commas/quotes/braces (single quotes stripped,
  `{` → `,`, REST passes whole-string as one arg). Rule: keep cmd
  comma-free or expect breakage. (Possible centrs/RouterOS edge for
  later upstream filing — Lane 3, not filed.)
- `root-dir` must NOT pre-exist (add creates it).
- Inline `mount=` fails on this build in all probed forms ("cannot
  mount volume on root (/)" — dir/file mounts, both slash styles).
  Suspect beta gap; file-into-container story unresolved — baked
  images or a licensed-box retest are the outs.
- `entrypoint` override works (needed: node:alpine's
  docker-entrypoint.sh chokes under RouterOS exec).
- Container state field is `stopped` (no `.running` on this menu —
  skill says the same).
- `pkill -f` with the pattern in your own command line kills your own
  shell. Use pgrep `[x]attern` or PID files. (Lab hygiene.)

## Pending (not claimed)

- Published-port packet-level check (needs hardware or host forward).
- File-into-container story for PLAIN containers (mounts fail here;
/app configs: proven as the workaround for /app).
- Committed references/test.sh for the container skill (T26 build).
- Upstream filings (skill drift, cmd quirk): drafted, not filed.
