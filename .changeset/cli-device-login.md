---
"executor": patch
---

Add `executor login` (plus `logout` and `whoami`) for signing the CLI into a
hosted or self-hosted Executor server using the OAuth 2.0 Device Authorization
Grant (RFC 8628), instead of manually creating and pasting an API key. `login`
prints a code and verification URL, opens the browser, and polls; afterwards the
CLI authenticates with a bearer token. Works against both cloud (WorkOS) and
self-host (Better Auth) servers.
