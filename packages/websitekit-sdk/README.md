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
import { readSlots, readSiteTerms, deploymentFor } from '@websitekit/sdk';

const client = createPublicClient({ chain, transport: http() });
// 4663 is Robinhood Chain mainnet; 46630 is its testnet. `deploymentFor` throws for any other id.
const ref = { site: '0xYourBoard', reader: deploymentFor(4663).reader! };

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

## Escrow

Optional, and deployed nowhere yet. A site created through `EscrowFactory` has its `treasury`
pinned to an `EscrowVault`; the publisher's cut waits a window there, and a slot holder on a page
that goes dark can hand the slot back for what they paid.

```ts
import {
  buildCreateEscrowedSite, // the factory names the OWNER; treasury and pinTreasury are not options
  buildBook, buildRelease, buildVaultWithdrawFor, // permissionless — each pays a recorded party
  buildApproveVault, buildClaim,                  // the holder's: approve the vault, then surrender
  readVault, readDeposits, readClaimable, readEscrowBind,
} from '@websitekit/sdk';

const bind = await readEscrowBind(client, site, vault);
bind.escrowed; // treasury == vault AND pinned AND vault.site() == site — check BOTH directions
```

`buildClaim` moves the holder's token into the vault before a unit is credited, so `buildApproveVault`
has to land first, on the site. `readClaimable` is the vault's own verdict and folds every refusal
into a zero; `readVault` carries the clock and the ledger. `buildMarkDark`/`buildClearDark` are the
attestor's and accepted from nobody else.

## Three rules worth knowing up front

- **`settlementToken` is required on every builder that moves money.** There is no default: a
  native-shaped call against a token site reverts, and the same call is correct on a native site —
  so a default is silently right half the time.
- **Never `parseEther` a floor.** `minFloor` derives from the settlement token's decimals, so 18 is
  wrong by 1e12 against 6-decimal USDG. Use `parseFloor(amount, decimals)`.
- **Deadlines and liveness use `block.timestamp`, not `Date.now()`.** The helpers here read the
  chain's clock for you; wall-clock answers are confidently wrong on a lagging L2.

## Status

Live on Robinhood Chain mainnet, where boards settle in USDG and the money is real, and on its
testnet. Unaudited, and the contracts are **not upgradeable** — a site is a clone frozen to the
implementation it was created from. Experimental software.

MIT © websitekit
