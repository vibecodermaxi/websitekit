# Frozen parity reference

`PricingFrozen.sol` is a **pinned copy** of v1's deployed `Pricing.sol`, vendored from
`the v1 codebase` at commit `4938ce9fead7cbb7fbbd2da10695973c8ae88f22`.

Vendored rather than linked on purpose: the point of a reference is that it is frozen, and a
vendored copy is *more* frozen, not less. The parity harness compares this against
`src/Pricing.sol` across 3,024 vectors — see PROTOCOL-SPEC §7.

**Never edit this file.** If v2's pricing diverges from it, that divergence is the thing the
harness exists to catch.

One exception has been taken, on 2026-08-19: the header comments were rewritten to drop a
description of a pre-EVM lineage this project does not have. Comments only — every engineering
claim preserved, the source byte-identical once comments are stripped, and the 3,024-vector parity
harness re-run to prove the arithmetic was untouched. That is the bar for editing anything here: if
the harness cannot prove the change was inert, do not make it.
