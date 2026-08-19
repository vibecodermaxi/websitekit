# Pinned dependencies

Copied from `the v1 codebase` `packages/contracts/lib/` at the repo split
(2026-08-18), rather than `forge install`ed, so the versions are **byte-identical to the ones the
3,024-vector parity harness was validated against**. That matters more here than update
ergonomics: the whole point of the harness is that the reference has not moved.

| dependency | version |
|---|---|
| forge-std | `3c84118` |
| solady | `v0.1.26` |
| openzeppelin-contracts | `v5.6.1` |

Converting these to submodules is fine later; re-pin to these exact refs if you do, and re-run the
parity harness after.
