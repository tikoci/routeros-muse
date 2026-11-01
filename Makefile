test:
	bun test

# T43 standing gate: every UI slice extends tools/ui-smoke.ts and runs
# this before done. Hermetic (temp workspace/home, echo provider).
smoke:
	bun tools/ui-smoke.ts

# House bar, mirrored from tikoci/centrs: biome (lint+format, tabs) and
# tsc --noEmit under the centrs strict flags. Zero or it is not done.
lint:
	bun run lint

# The full pre-handoff gate: lint + tests + browser smoke.
gate: lint test smoke

# Router captures (tools/pull, folded from pull/Makefile at T14): one
# command captures one router into files under out/ (local-only, never
# committed). check verifies a capture on disk; no router contact.
pull-twin:
	bun tools/pull/pull.ts --quickchr twin1 --out out

pull-host:
	bun tools/pull/pull.ts --host $(host) --name $(name) --out out

check:
	bun tools/pull/checker.ts --device $(device) --out out

check-all:
	bun tools/pull/checker.ts --all --out out

.PHONY: test smoke lint gate pull-twin pull-host check check-all
