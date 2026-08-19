# Contributing

Thanks for looking. This is early, unaudited software, and the most useful contributions right now
are the ones that find something wrong.

## Getting set up

```bash
pnpm install          # Node 22.13+; the default shell Node is usually too old for pnpm
pnpm test             # all packages — needs `forge` on PATH, because the parity tests spawn it
pnpm test:contracts   # contracts only (~2m30s; the invariant campaigns are most of it)
pnpm sizes            # runtime bytes against the 24,576 limit
```

## Things worth knowing before you change contracts

- **`SlotSite` has ~2.6 KB of headroom** against EIP-170, and `via_ir` is deliberately unavailable —
  it caches the `TIMESTAMP` opcode across external calls, which silently breaks every
  time-dependent test. Size has to come from architecture, not the compiler. Run `pnpm sizes`.
- **`SlotSite` is frozen per clone.** A deployed site keeps its implementation forever, so a change
  here is a new generation, not an upgrade. `SlotReader` is the piece that is *meant* to change.
- **Money arithmetic belongs in `Pricing` or `RentalsLib`, never inline in the site.** Inline, it is
  only reachable by executing a real purchase against a deployed clone whose economics are frozen —
  so sweeping the configuration space would need one site per configuration.
- **`test/reference/PricingFrozen.sol` is vendored and frozen.** If v2's pricing diverges from it,
  that divergence is exactly what the harness exists to catch. Do not edit it.

## Adding an invariant

Break the contract on purpose and confirm your property fails. This is not a formality: of four
deliberate mutations tried against the current suite, one was **not** caught by an invariant that
looked like it should catch it. A property that has never failed has not been tested.

Two mechanical traps, both of which cost real time:

- **Group related checks into one `invariant_` function** that calls `_check*` helpers. Foundry runs
  a separate campaign per `invariant_` function — 21 of them cost 4m39s against a single config.
- **Coverage assertions go in `afterInvariant`**, guarded on a call counter. Foundry evaluates
  invariants once before the first call, so a coverage assertion written as an invariant fails every
  run by construction — and on a shrink replay it fails *first*, replacing the real failure message.

## The trap that has cost the most time

**An external call inside an argument list is evaluated after `vm.prank` / `vm.expectRevert` is
armed, and consumes it.** `site.slotOf(...)`, `site.minFloor()`, even `sha256` — they look like
values and are not. The symptoms mislead in both directions: a consumed prank reverts
`Unauthorized` and reads like a broken access check; a consumed expectation reads like a missing
guard. **Hoist every read into a local first.**

## Pull requests

Explain *why* in the commit message, not just what. Much of this codebase's reasoning lives in its
comments and history on purpose — the parameter that looks arbitrary usually is not, and the next
person needs to know which.
