---
"executor": patch
---

Send a default `executor` User-Agent on OpenAPI tool calls. Upstreams such as
GitHub that reject requests without a User-Agent (HTTP 403) now succeed instead
of surfacing the rejection as a credential error. A spec- or connection-provided
User-Agent still takes precedence.
