---
"@leejpsd/nextjs-cache-handler": minor
---

New `nextjs-cache-handler` CLI (zero-dependency): `init` detects the Next.js
version and Redis client, generates the handler wrapper shims, shows the
next.config keys to add (never edits it), appends env templates, and injects
the agent rules block into CLAUDE.md/AGENTS.md idempotently (`--yes` to
apply, `--skills` to install the agent skill locally). `doctor` verifies
Redis connectivity, inspects cache key namespaces, and runs a write/read
round-trip — the first command an agent should reach for when debugging.
