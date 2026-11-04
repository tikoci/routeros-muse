## What and why

<!-- One paragraph. The PR title becomes the squash commit subject. -->

## Records

- Records: <!-- T___ / D___ / N___, updated in this PR -->
- Closes: <!-- #issue, if any -->

## Validation

<!-- Claim = command + output. Unrun = pending. -->

- [ ] `make gate` green (if a stage is red, name it and why)
- [ ] `make -C records check`
- [ ] UI change: `tools/ui-smoke.ts` extended, screenshots eyeballed, console clean

## Privacy (D1)

- [ ] No credentials, tokens, serials, public IPs, people or locations; nothing from `out/`
