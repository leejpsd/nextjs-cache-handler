# @leejpsd/nextjs-cache-handler-mcp

MCP (Model Context Protocol) server for
[`@leejpsd/nextjs-cache-handler`](https://www.npmjs.com/package/@leejpsd/nextjs-cache-handler)
Redis caches. Lets AI agents (Claude Code, Cursor, …) inspect and operate a
running deployment's Next.js cache: *"why isn't this page updating?"*
becomes a `tag_state` call instead of guesswork.

## Setup

Project `.mcp.json` (Claude Code picks this up automatically):

```json
{
  "mcpServers": {
    "nextjs-cache": {
      "command": "npx",
      "args": ["-y", "@leejpsd/nextjs-cache-handler-mcp"],
      "env": {
        "REDIS_URL": "redis://127.0.0.1:6379",
        "DEPLOYMENT_VERSION": "your-deploy-id"
      }
    }
  }
}
```

Runs locally over stdio and connects to YOUR Redis — nothing is hosted.

> **AWS/ElastiCache note**: ElastiCache is VPC-internal, so a locally
> running MCP server needs an SSH tunnel/bastion (point REDIS_URL at the
> tunnel). Agents running inside the VPC (CI, in-cluster) connect directly.
> Pair with the AWS agent skills/MCP: they handle the infrastructure, this
> server handles cache semantics.

## Tools

| Tool | What it answers | Writes? |
|---|---|---|
| `cache_health` | Is Redis up? What's cached, per layer/kind? | no |
| `cache_search` | Which keys match this pattern? | no |
| `cache_inspect` | Decode one entry: kind, age, tags, TTL, compression, sizes | no |
| `tag_state` | Is this tag invalidated right now, on BOTH cache layers? | no |
| `explain_key` | Parse a raw Redis key into layer/kind/namespace/key | no |
| `simulate_swr` | Would this entry be fresh / stale / expired, and what happens on read? | no |
| `invalidate_tag` | Soft (SWR) or hard invalidation — **dry-run unless `confirm: true`** | gated |

Env: `REDIS_URL` (required), `DEPLOYMENT_VERSION` (recommended — scopes
namespace-aware tools), `CACHE_KEY_PREFIX` / `ISR_KEY_PREFIX` (only when the
handlers use custom prefixes).
