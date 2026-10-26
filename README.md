# websitekit

[![CI](https://github.com/vibecodermaxi/websitekit/actions/workflows/ci.yml/badge.svg)](https://github.com/vibecodermaxi/websitekit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@websitekit/sdk?label=%40websitekit%2Fsdk)](https://www.npmjs.com/package/@websitekit/sdk)

**Turn regions of your page into ownable, tradeable inventory.**

A publisher marks parts of a page as *slots*. Anyone can buy one and become its effective owner —
able to write its content, trade it as an ERC-721, or rent it to an advertiser without giving up the
asset. Each site is its own contract, so one publisher's inventory and funds are structurally
isolated from everyone else's.

```tsx
<h1><Slot id="hero.headline" fallback="Ship faster" /></h1>
```

That headline now has an owner, a price, and a payout when somebody takes it.

The second kind of inventory is an **image board**: one picture, sold as rectangular blocks of its
squares, each block an ERC-721 that its owner fills with their own picture. See
[Image boards](#image-boards).

> **Live on Robinhood Chain mainnet. Experimental and unaudited.**
> The contracts are not upgradeable — a site is a clone frozen to the implementation it was created
> from. Prices are real dollars (USDG). Do not put in money you would mind losing.

## Quick start

```bash
npm create websitekit my-site
cd my-site && pnpm install && pnpm dev
```

The first run needs **no credentials**. It renders a shared demo board on Robinhood Chain mainnet:
already claimed across two owners, with slots open, some taken, one under a live tenancy, and one
withdrawn from sale. An empty board teaches nothing about the mechanic, so the one you start with is
not empty. Set `NEXT_PUBLIC_WEBSITEKIT_CHAIN_ID=46630` to work on the free testnet instead.

## How the market works

| | |
|---|---|
| **Claim** | An unowned slot sells at its floor. |
| **Take** | An owned slot sells at `takeBps` of its effective floor — 1.4× on the demo board. The displaced owner is paid `payoutBps` of that same floor. |
| **Reversion** | The takeover price reverts weekly toward the floor, bounded below by it. This is mean reversion of the *takeover price*, not loss of value — it is the handler for a position nobody is tending. |
| **Rent** | An owner can sell temporary use without giving up the asset. Rent streams to them; the tenant holds the content gate for the term. |

**One correction worth stating plainly**, because an earlier version of this documentation got it
wrong: being taken is *not* guaranteed to be a profit event. The payout tracks the slot's **current**
effective floor, not what the displaced holder paid, and reversion separates the two. In a
128,000-call invariant campaign, 33 of 73 takes credited the displaced owner less than they paid.
The guarantee that survives every input is narrower and worth trusting: **a displaced owner always
receives at least the floor.**

## Image boards

A seller uploads one picture; buyers buy rectangular blocks of its square cells and put their own
pictures in them. Each board is a token in a shared Boards collection, and the board itself is an
ERC-721 whose tokens are its blocks, tradable anywhere. Metadata is built on chain and pictures are
addressed by their hash on IPFS, so a board needs no particular host.

| | |
|---|---|
| **Buy** | Any rectangle of squares, priced by the board and its zones. A price of zero keeps squares out of sale for good. |
| **Take** | A sold square can be bought from its owner at its price times the board's take multiple, crediting the owner a payout, except in its cooldown. The take is a new block on top. |
| **Resell** | An owner lists a whole block at their own price inside the board, or sells the token anywhere. |
| **Rent** | An owner rents a block by the day to a named tenant, whose picture shows until the term ends. |

Whoever holds the board's own token is paid for each square sold and a share of every resale, take
and rental, and may lower the price of unsold squares but never raise it. The take terms are chosen
when the board is created and never change. The client is `@websitekit/sdk/image-boards`; the
rules are [`docs/IMAGE-BOARD-SPEC.md`](docs/IMAGE-BOARD-SPEC.md).

## Packages

| | |
|---|---|
| [`@websitekit/sdk`](packages/websitekit-sdk) | Reads, writes, pricing. Takes your viem client. Image boards are `@websitekit/sdk/image-boards`. |
| [`@websitekit/react`](packages/websitekit-react) | `<Slot>`, `useSlot`, `useBuy`, `<BuyDialog>`. |
| [`create-websitekit`](packages/create-websitekit) | Scaffold and its Next.js template. |
| [`packages/websitekit-contracts`](packages/websitekit-contracts) | `SlotSite`, `SlotFactory`, `SlotReader`, `RentalsLib`, render escrow, and the image-board contracts. |

## Contracts

Four, because one does not fit under EIP-170. `SlotSite` is the sole custodian of funds and is
**frozen** — every site is an EIP-1167 clone of it. `RentalsLib` is delegatecalled and never touches
money. `SlotReader` holds every convenience view and is deliberately **not** frozen, so the read
surface can improve without redeploying a single site.

Three more sit beside them and are not frozen: **render escrow**. `EscrowFactory` creates a board
whose publisher revenue is held in an `EscrowVault` for a window and paid out to slot holders if the
page goes dark; `Attestor` names the referee that reports it. They have an owner — see
[`SECURITY.md`](SECURITY.md).

Image boards are four more, outside the frozen core too: `ImageBoard`, the implementation every
board clones; `ImageBoardExtension`, which runs set-up and rentals by delegatecall so the board fits
under EIP-170; `ImageBoardRenderer`, which builds every metadata string; and `ImageBoardCollection`.
A board keeps the implementation it was created from. The collection's owner can point new boards
at a later one and choose the tokens they settle in, and can never reach a board that exists.

Deployed on **Robinhood Chain mainnet (4663)**, settling in USDG, and on the testnet (46630). Every
mainnet contract is verified on [Sourcify](https://sourcify.dev) as an exact match. Every
address is in [`packages/websitekit-sdk/src/addresses.ts`](packages/websitekit-sdk/src/addresses.ts),
and image boards' in [`image-boards.ts`](packages/websitekit-sdk/src/image-boards.ts)
(`imageBoardDeploymentFor`).

## Testing

Four layers, each catching what the one below cannot:

1. **Unit** — the SDK against its own assumptions.
2. **Parity** — a TypeScript pricing twin compared against real Solidity across 3,024 take-price
   vectors and 690 ask/rent vectors, and the image-board grid twin against the 4,338 answers its
   contract writes. Both languages can be wrong the same way, so property tests check the
   arithmetic separately from the agreement.
3. **End-to-end** — real bytecode on anvil, driven through the SDK. This is the layer that caught a
   wall-clock deadline bug and a helper treating a reverted transaction as success.
4. **Invariant** — four configuration campaigns sweeping combinations, not one config per feature,
   and **mutation-tested**: deliberate breaks are introduced to confirm the properties catch them.
   One of the first four did not get caught, which is why that discipline exists. Image boards
   have a campaign of their own, which checks the board against its model cell by cell after
   every call.

```bash
pnpm install
pnpm test            # every package; needs `forge` on PATH
pnpm test:contracts   # forge only
```

Requires Node 22.13+ and [Foundry](https://getfoundry.sh).

## Documentation

- [`docs/README.md`](docs/README.md) — the guide: the model, every mechanism, and the traps.
- [`docs/PROTOCOL-SPEC.md`](docs/PROTOCOL-SPEC.md) — the contract spec, and what the `§` references
  scattered through the source point at. Every parameter decision, with its reasoning.
- [`docs/IMAGE-BOARD-SPEC.md`](docs/IMAGE-BOARD-SPEC.md) — the image-board contracts, rule by rule.

The API reference is the TypeScript types and each package's README. There is deliberately no
hand-maintained function list: the one this repo used to have went a full release describing an API
that had already changed, because it was the only document with no compiler behind it.

## License

MIT © websitekit
