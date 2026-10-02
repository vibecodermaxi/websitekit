# Security

## Status, stated plainly

**This software is unaudited and experimental, and it is deployed on Robinhood Chain mainnet, where
it holds real money.** No audit has been performed and none is planned. The same contracts are also
on the Robinhood Chain testnet.

`SlotSite` is an EIP-1167 clone of a **non-upgradeable** implementation, with its settlement token
frozen at `createSite`. There is no protocol admin key, no proxy and no migration path: a deployed
site keeps its implementation forever. Each site's own owner can pause buying, move its treasury
and adjust its terms within the limits the contract enforces — nobody else can. That is a deliberate
property, and it means a vulnerability in the frozen bytecode cannot be patched on a live board —
only avoided by deploying a new generation that existing boards cannot move to.

**Render escrow is different and has an owner.** `EscrowFactory`, `EscrowVault` and `Attestor` sit
beside the frozen core, and one key can change the escrow policy, the token allowlist and the
referee, and withdraw the reserve. Every address is in `packages/websitekit-sdk/src/addresses.ts`,
and the owner is whatever `owner()` on the factory answers.

Put in only what you can afford to lose.

## Reporting a vulnerability

**Please report privately first, through GitHub's private vulnerability reporting** — the *Security*
tab of this repository, "Report a vulnerability". That channel needs no email address and reaches
the maintainer directly.

If the *Security* tab offers no reporting form, private reporting has not been enabled on the
repository. In that case please open an issue that says only *"security issue, please enable private
reporting"* with **no technical detail in it**, and wait. An ordinary public issue is a disclosure,
and for frozen bytecode a disclosure is permanent.

Useful things to include, in rough order of value:

- the property you believe is violated, stated as an invariant — this repository is organised around
  them, so "a displaced owner can receive less than the floor" is worth more than a stack trace;
- a failing test, ideally a Foundry one against `packages/websitekit-contracts`;
- the commit or deployed address you were looking at;
- whether it is reachable from a clone's frozen bytecode, from `SlotReader` (which is redeployable),
  or from off-chain code.

## What to expect

One maintainer, working on this in the open. There is no response-time commitment, because one that
could not be kept would be worse than none. What is promised is narrower and can be honoured:

- a reply acknowledging the report;
- a decision on whether it is a real issue, said plainly either way;
- credit in the fix if you want it, and none if you do not.

**There is no bug bounty and no payment of any kind.** This is one maintainer with no budget for
one, and a reward that might not be paid would be worse than saying so.

## Scope

In scope:

- `packages/websitekit-contracts` — `SlotSite`, `RentalsLib`, `TermsLib`, `SlotReader`,
  `SlotFactory`, the pricing library, and the escrow contracts (`EscrowFactory`, `EscrowVault`,
  `Attestor`).
- `packages/websitekit-sdk` and `packages/websitekit-react` — anything where the client's arithmetic
  disagrees with the contract's, which is a class this repository takes seriously enough to keep a
  two-language parity harness for.
- The loader, where it is published — unverified bytes reaching a render path, or anything escaping
  onto a page the publisher controls.

Out of scope:

- Testnet funds, which have no value. The same bug on mainnet is in scope.
- The public RPC and the block explorer, which belong to the chain and not to this project.
- Anything requiring a compromised private key. Losing a key is not a vulnerability in this code.
- Reports produced by a scanner with no accompanying analysis. They are welcome with one.

## Known and accepted

These are design decisions rather than oversights, and reporting them is not necessary:

- **No protocol admin key and no upgrade on `SlotSite`.** Deliberate; see above.
- **The escrow referee is trusted.** Whether a page has gone dark is decided off chain and reported
  by the key `Attestor` names; a dishonest or compromised referee can mark a board dark or fail to.
  It also sees one copy of the page, so a page served differently to it than to visitors fools it.
- **A publisher can remove the snippet after selling a slot.** Render attestation is what prices
  that risk, not a contract guarantee, and it was always going to be the case.
- **The settlement token's issuer may be able to freeze or pause transfers.** That is a property of
  the token a site was configured with, chosen per site and frozen at issue.
- **A slot key is permanent once registered.** Renaming addresses a different, unregistered slot.
