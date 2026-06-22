---
"executor": patch
---

The execute result envelope now reports how many items a script sent to the user
via `emit()`. A script that only emits (with no return value) is no longer
indistinguishable from one that did nothing: the envelope includes an emitted
count and a `(no return value; N items emitted to the user)` text preview.
