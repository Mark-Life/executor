---
"executor": patch
---

`connections.list` now returns a lean summary by default, replacing the full
`oauthScope` grant string (which can run to thousands of characters per
connection) with an `oauthScopeCount`. Pass `verbose: true` to get the full
grant back.
