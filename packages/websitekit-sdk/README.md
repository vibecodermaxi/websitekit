# `@websitekit/sdk`

Reads, writes and pricing for **websitekit** — an issuance and settlement layer for tokenized page
inventory. A publisher marks regions of their page as slots; anyone buys one and becomes its
effective owner, able to write its content, trade it as an ERC-721, or rent it to an advertiser.

```bash
npm install @websitekit/sdk viem
```

`viem` is a peer dependency: this package takes *your* client, so there is one copy of viem and one
set of types.

## Reading a board

Every read goes through `SlotReader`, a deliberately replaceable deployment — so reads take a
`SiteRef` (`{ site, reader }`) rather than a bare address.

```ts
import { createPublicClient, http } from 'viem';
import { readSlots, readSiteTerms, ROBINHOOD_TESTNET, DEMO_SITE } from '@websitekit/sdk';

const client = createPublicClient({ chain, transport: http() });
const ref = { site: DEMO_SITE, reader: ROBINHOOD_TESTNET.reader! };

const terms = await readSiteTerms(client, ref);
const slots = await readSlots(client, ref, ['hero.headline', 'hero.image']);
```

Each slot carries what a page needs to render *and* what a buyer needs to decide: `charged` (what
this buyer pays — the floor on a claim, the take price on a take), `unaccruedRent` and `netCost` for
an encumbered position, and `isAvailable` for the publisher's listing toggle.

## Buying

Never assemble a `buy` by hand. `readBuyContext` pins the quote, the encumbrance hash and the
**chain's** clock to one block, and `buildBuyFrom` builds from exactly that:

```ts
import { readBuyContext, buildBuyFrom } from '@websitekit/sdk';

const context = await readBuyContext(client, ref, 'hero.headline');
const request = buildBuyFrom(ref.site, context, terms.settlementToken);
await walletClient.writeContract(request);
```

This SDK never holds a key. Every `build*` returns a request object your wallet layer sends.

## Three rules worth knowing up front

- **`settlementToken` is required on every builder that moves money.** There is no default: a
  native-shaped call against a token site reverts, and the same call is correct on a native site —
  so a default is silently right half the time.
- **Never `parseEther` a floor.** `minFloor` derives from the settlement token's decimals, so 18 is
  wrong by 1e12 against 6-decimal USDG. Use `parseFloor(amount, decimals)`.
- **Deadlines and liveness use `block.timestamp`, not `Date.now()`.** The helpers here read the
  chain's clock for you; wall-clock answers are confidently wrong on a lagging L2.

## Status

Testnet only, unaudited, and the contracts are **not upgradeable** — a site is a clone frozen to the
implementation it was created from. Experimental software.

MIT © Puranjay Singh
