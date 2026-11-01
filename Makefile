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

# The full pre-handoff gate: lint, then the suite + smoke under a fresh
# private TMPDIR (T94). Fails if anything is left behind in it; the
# checker lists the leftovers. All three stages run even when an early
# one fails, so one gate shows lint/test/smoke/leak signal together.
gate: lint
	@tmpdir=$$(mktemp -d); \
	echo "gate TMPDIR: $$tmpdir"; \
	fail=0; \
	TMPDIR="$$tmpdir" bun test || fail=1; \
	TMPDIR="$$tmpdir" bun tools/ui-smoke.ts || fail=1; \
	bun tools/check-tmpdir.ts "$$tmpdir" || fail=1; \
	rm -rf "$$tmpdir"; \
	exit $$fail

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
