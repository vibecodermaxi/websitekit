## What this changes, and why

<!-- The reasoning is the valuable part. This project keeps it in commit messages and in the docs
     rather than in a tracker, so a PR that explains itself is one that can be reviewed. -->

## Checks

- [ ] `pnpm test` passes (needs `forge` on PATH — the parity tests spawn it)
- [ ] `pnpm test:contracts` passes, if contracts changed
- [ ] `pnpm sizes` — if you touched `SlotSite`, say what the margin is now

## If this touches contracts

`SlotSite` is an EIP-1167 clone of a **non-upgradeable** implementation. A change here is a new
generation that existing boards can never migrate to, not an upgrade — so it needs a reason that
survives being permanent.

- [ ] I ran the standing check on any new entry point: *if this function assigns ownership, credits
      a balance, or confers a right, could the beneficiary ever differ from the party paying gas?*
      If yes, it takes an explicit recipient parameter.
- [ ] Money arithmetic went in `Pricing` or `RentalsLib`, not inline in the site — inline, it is
      reachable only by executing a real purchase against a clone whose economics are frozen.
- [ ] If I added an invariant, I broke the contract on purpose and confirmed it fails. An invariant
      that has never failed has not been shown to test anything.

## If this changes behaviour the client also computes

The SDK carries a TypeScript twin of the on-chain pricing, and the two are held together by a
generated vector grid. If they can now disagree, say so — a silent divergence between them is the
failure mode that harness exists for.
