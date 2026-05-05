# Security policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** via email to
`leejpsd@gmail.com`.

Do not file a public GitHub issue for security reports.

You should receive an acknowledgement within 48 hours. If the issue is
confirmed, a patch will be released as soon as practical, and a security
advisory will be published on the GitHub repository.

## Supported versions

Until v1.0.0, only the latest minor receives security patches.

| Version | Supported |
|---|---|
| `0.x.x` (current) | ✅ |
| pre-release (`0.0.0`) | ⚠️ best-effort |

## Dependencies

This package has zero runtime production dependencies. `redis` and
`ioredis` are optional peer dependencies — security policies of the
client you select apply.
