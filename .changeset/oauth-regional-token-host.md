---
"executor": patch
---

Fix OAuth connect for providers that issue authorization codes redeemable only
at a region-specific token host. Executor now redeems the code at the region
returned on the callback rather than the statically advertised token endpoint,
so connecting these providers no longer fails at the token-exchange step.
