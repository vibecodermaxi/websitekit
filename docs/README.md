# websitekit

**The issuance and settlement layer for tokenized page inventory.**

A publisher registers regions of a rendered page as discrete, transferable positions. Investors
acquire those positions at issue and trade them in a permissionless secondary market. A holder can
then delegate write access on a position *without surrendering it* — which is the primitive a rental
market for advertising demand plugs into.

That last sentence is the thesis. Conventional ad inventory is rented by the impression and settled
by an intermediary that owns the measurement, the auction and the ledger. websitekit unbundles it: the
publisher sells the **position** once, the market prices it continuously, and the holder retains a
rentable asset. The SDK is the first layer of that stack.

```
pnpm create websitekit my-site
cd my-site && pnpm install && pnpm dev
```

No wallet, no credentials, no API key. The page reads a live board off Robinhood Chain testnet and
renders.

---

## The three-party model

| party | role | primitive | status |
|---|---|---|---|
| **Publisher** | Defines inventory, sets floors, freezes terms of issue. Receives issuance proceeds and a fixed cut of every resale. | `createSite`, `registerSlots`, `setFloor` | **ships** |
| **Holder** | Acquires a position at issue or by displacing an incumbent. Holds a transferable ERC-721 with an income right and a write right. | `buy`, `buyFor`, ERC-721 transfer | **ships** |
| **Tenant** | Rents a position for a fixed term: pays into escrow, holds the write right until it expires. | `listForRent`, `rent`, `extendRental`, `edit` | **ships** |

All three legs are complete and live, including a real rental market — listing, priced terms,
escrowed prepayment, streamed settlement to the holder, and a tenancy that survives the position
changing hands. **What is not built is the demand side above it:** discovery, bidding, measurement
and campaign routing are companion products. Nothing here claims otherwise.

---

## The stack

```
  ┌─────────────────────────────────────────────┐
  │  demand      advertisers, campaigns          │   companion products — not built
  │  exchange    rental auction, measurement     │   companion products — not built
  ├─────────────────────────────────────────────┤
  │  tenancy     rent · escrow · streamed rent   │   SlotSite           ships
  │  secondary   take · reversion · payout       │   SlotSite           ships
  │  issuance    register · floor · claim        │   SlotSite           ships
  │  settlement  pull payments, per-site funds   │   SlotSite           ships
  │  rendering   hash-verified content, SSR      │   @websitekit/react     ships
  └─────────────────────────────────────────────┘
```

Each layer is usable without the ones above it. A publisher can issue inventory and be paid today
with no rental market in existence; a holder who never rents their position still earns on resale.
The upper layers add demand, they are not a prerequisite for the lower ones to settle.

---

## 1. Inventory definition

A slot is identified by a dotted key, hashed client-side:

```
tokenId = uint256(keccak256("hero.headline"))
```

The contract only ever sees a `bytes32`, so it never learns the shape of a page. That is what lets
one audited implementation serve every publisher without a per-site schema.

**Keys are permanent.** Renaming one does not rename a slot — it addresses a different, unregistered
slot and orphans whatever the old key held, along with whoever paid for it. Add and retire keys
freely before issue; treat them as immutable afterwards.

Keys are lowercase alphanumeric segments joined by `.`, `_` or `-`, enforced by the SDK rather than
the contract, so that `Hero.Headline` and `hero.headline ` — which hash to entirely different slots
and are indistinguishable in a screenshot — cannot both end up in one config.

**Inventory is closed by default.** An unregistered key cannot be bought. Without that, anyone
reading a publisher's repository could acquire `hero.headline` at floor the day before launch.

### Which regions to issue

Issue the periphery first. A position left open in the middle of editorial content — a missing
listing row, an empty card — degrades the page and reads as a fault rather than as available
inventory. An open announcement strip, nav link or footer link reads as an offer.

```tsx
<Slot id="announce.bar" fallback="This strip is for sale — 0.00005 ETH, and every reader sees it first." />
```

`registerSlots` is in the freely-mutable set, so inventory can be expanded at any time. Starting
narrow costs nothing and lets the market price a low-risk position before the publisher commits
their headline.

---

## 2. Primary issuance

An unclaimed position is acquired at its **floor** — the publisher-set reserve. Proceeds split three
ways, and the publisher takes nearly all of it:

| | at issue | on resale |
|---|---|---|
| buyer pays | 1.00× floor | `takeBps` × effective floor |
| displaced holder receives | — | `payoutBps` × effective floor |
| protocol takes | `protocolBps` × effective floor | `protocolBps` × effective floor |
| **publisher receives** | **the remainder — 0.95× floor at default terms** | **`takeBps − payoutBps − protocolBps`** |

The publisher's resale cut is a **frozen parameter**, not a negotiated rate: it is the spread between
what a displacing buyer pays and what the incumbent is owed. At the four reference configurations it
ranges from 0.15× to 0.75× of the floor per resale.

Floors are mutable within a rate limit — ±20% per change, 24 hours apart — so a publisher can track
demand without being able to strand an incumbent with a sudden repricing.

Settlement is **pull, never push**. Proceeds accrue to `pendingWithdrawals` and are claimed with
`withdraw()`. `withdrawFor(account)` is permissionless and always pays the address that is owed
rather than the caller, so funds cannot be stranded by a party that never returns.

---

## 3. The secondary market

Four rules. Everything else is a consequence.

| | |
|---|---|
| **Claim** | An unissued position costs its floor. |
| **Take** | Displacing the incumbent costs `takeBps` × the effective floor — 1.4× by default. |
| **Payout** | The displaced holder receives `payoutBps` × the effective floor — 1.15× by default, and never less than the floor itself. |
| **Reversion** | An untouched position reverts toward its floor at `reversionBps` per week — bounded *below* by the floor, so this is mean reversion of the takeover price, not loss of value. |
| **Net cost** | A position under a live tenancy costs `charged − unaccruedRent`: the buyer inherits the rest of the rent stream. |

### Price discovery

There is no oracle and no external price feed. Discovery is the **ratchet**: each take writes a new
`lastPrice` at `takeBps` above the last, so contested inventory climbs geometrically as buyers
displace one another. Decay is the counterweight, walking an untouched position back toward its
floor so that stale inventory becomes acquirable again rather than being permanently priced at its
last peak.

The consequence worth internalising: **the price tracks trading activity, not traffic.** A position
reverts at the same rate whether one visitor or a million saw the page, because only a transaction
moves the price. Measurement is precisely what the exchange layer is for, and it does not exist yet.

**Reversion is iterative, not closed-form.** `price × reversionᶰ` is a *different number* from what the
chain charges, because integer division truncates once per period. Any client-side quote must use
`computeTakePrice` from `@websitekit/sdk`, which is byte-identical to the Solidity.

### Position economics

**A displaced holder always recovers at least the floor.** That is the invariant, it holds for every
input, and it is enforced by `payoutBps >= 10_000` in the implementation's bytecode.

**It is not a guaranteed profit.** The payout is a multiple of the *current* effective floor, not of
what the holder paid, and reversion separates the two. At the default 0.9/week:

| displaced | recovers |
|---|---|
| within 1 week of acquisition | ~1.035× cost — gain |
| after 2 weeks | ~0.93× — loss |
| after 4 weeks | ~0.75× — loss |
| ever, at any point | at least the floor |

A holder who acquired **at floor** is always made whole, since reversion cannot push the effective floor
below it. A holder who paid a **displacement premium and then held** carries the reversion, and
can be underwater. That carry is the mechanism that prevents indefinite squatting on high-value
inventory, and it is not risk-free capital.

An earlier revision of this document asserted that displacement was always a profit event. It is
not, and the invariant suite found it: **33 of 73 simulated takes credited the displaced holder less
than they paid.**

One boundary condition: at floors small enough that `floor × payoutBps` truncates — a 1 wei floor —
the margin rounds away entirely and the payout is exactly principal. Do not issue at dust floors.

---

## 4. Tenancy — renting a position without selling it

A holder can sell **temporary use** of a position while keeping the asset:

```ts
buildListForRent(site, 'hero.headline', ratePerDay, maxDurationSecs)   // holder lists
buildRent({ site, key, durationSecs, expectedRatePerDay, … })          // tenant pays
```

Renting is permissionless — anyone may rent a listed position — and the whole term is **prepaid into
escrow**, then streamed to the holder as it accrues. `claimRent` sweeps what has earned; the rest
stays escrowed until it does. The fee is split three ways at payment time: the protocol's cut, the
site's cut, and the remainder to the holder.

For the term's duration the **tenant holds the content gate and the owner is locked out entirely.**
Ask the contract who may write rather than inferring it from ownership:

```ts
await readCanEdit(client, site, 'hero.headline', address)
```

There is also a delegated-editing primitive — `setEditor`, and `setEditorWithSig` verified through
**ERC-1271** so a smart account works and a grant signed offline can be relayed by anyone. Use it to
hand editing to an agency without renting. A grant dies on its own when the position changes hands:
no clearing logic anywhere, so none to forget on a code path added later.

### A tenancy survives the position being sold

This is the part with real consequences for a demand layer. A take clears the **listing** but not an
active **rental**: the new owner does not inherit a rate they never chose, and the tenant keeps their
term. Rent that had already accrued is settled to the *outgoing* owner before ownership moves.

So a rental sold as "30 days of this position" is a **contract guarantee, not a promise underwritten
by the holder** — a tenant cannot be evicted by the position being taken out from under them.

The mirror of that is what a buyer sees. An encumbered position is cheaper than its price by exactly
the rent still to accrue, and the reader surfaces both numbers so a confirm dialog can say it plainly:

| | |
|---|---|
| `charged` | what leaves the buyer's wallet |
| `unaccruedRent` | escrowed rent they inherit over the remaining term |
| `netCost` | `charged − unaccruedRent` — the number to lead with |
| `isFreeCarry` | the inherited stream exceeds the price outright |

Without that, an encumbered position reads as "pay full price for something you cannot use," which is
the opposite of what it is.

The signed variant matters more than it looks. It is verified through **ERC-1271**, so a smart
account works, and it lets a tenant relay a grant the holder signed offline — the mechanic a hosted
booking flow needs in order to settle a rental without the holder sending a transaction.

### Editor grant lifetime

An editor grant — distinct from a tenancy — expires on its own:

- a transfer or marketplace sale moves `owner` away from the grantor → **dead**
- a take moves the position's take count past the grant's stamp → **dead**
- a holder who is displaced and then **re-acquires** does *not* resurrect the old grant; re-granting
  is a deliberate second signature

The EIP-712 domain binds the **clone's** address. Without that, a signature scoped to one site would
replay against every other site cloned from the same bytecode, which is every site on the chain.

---

## 5. Terms of issue

Take economics are freely editable until the **first position is claimed**, and after that they may
only move in the direction that cannot strand a holder. There is no admin key and no timelock — the
ratchet is enforced in bytecode.

| | before the first claim | after |
|---|---|---|
| `takeBps` | any legal value | **may only fall** |
| `payoutBps` | any legal value | **may only rise** |
| `reversionBps` | any legal value | **may only get slower** |
| `maxReversionWeeks` | any legal value | **may only shorten** |
| `cooldownSecs` | any legal value | **may only shorten** |

Clamps hold in both regimes: `takeBps` ≤ 30,000 (3×) and must exceed `payoutBps + protocolBps`;
`payoutBps` ≥ 10,000, so a displaced holder always recovers at least the *floor* — not necessarily
their cost, see above; `maxReversionWeeks` ≤ 52; `cooldownSecs` ≤ 7 days. A configuration that farms
takers — `payoutBps: 0` — cannot be deployed at all.

**Rent terms are different, and deliberately so.** `siteRentBps`, `maxRentalTerm` and `minRentBps`
stay freely mutable for the site's whole life, in both directions. The asymmetry is the design: take
economics bind a holder who cannot exit, while rent binds nobody involuntarily — an owner who
dislikes a rate simply does not list. That recourse is what take economics lack.

| | |
|---|---|
| `settlementToken` | **Frozen forever, no setter.** Changing it would orphan every balance on the ledger. It also fixes `minFloor`, derived as `10^(decimals−4)`. |
| per-slot floor | Mutable, **±20% per change, 24h apart**. |
| per-slot availability | Freely mutable — a registered slot can be withdrawn from sale and put back. |
| treasury, pause, metadata, royalty, slot registration | Freely mutable. |
| `protocolBps` | Set in the implementation. A clone cannot strip it. |

This is what makes a position **underwritable**. An investor reads the terms once and knows they can
only move in their favour afterwards — no rate change against them, no unilateral repricing, no
governance action.

The cost is that a site is a clone frozen to its implementation. A change to the contracts is a new
generation, not an upgrade: existing sites keep the behaviour they were created with, permanently.

---

## Architecture

```
SlotFactory  ──createSite()──▶  a clone of SlotSite      ◀──delegatecall──  RentalsLib
                                 its own ERC-721 collection                  (tenancy state,
                                 its own funds, its own inventory             never touches money)
                                 tokenId = uint256(keccak256("hero.headline"))
                                      │
                     writes (wallet)  │  reads ──▶ SlotReader  (all views, redeployable)
                                      ▼
                          @websitekit/react in the publisher's app
                          hash-verifies bytes before render
                                      │  fetch by hash
                                      ▼
                          content-addressed storage
```

**Four contracts, because one does not fit under EIP-170.** `SlotSite` is the sole custodian of
funds and is frozen. `RentalsLib` is delegatecalled and *never moves money* — it validates, mutates
tenancy state, and returns amounts the site books. `TermsLib` is inlined policy. `SlotReader` holds
every convenience view and is deliberately **not** frozen: the read surface can improve without
redeploying a single site, which is why reads take a `SiteRef` (`{ site, reader }`) rather than a
bare address.

**Every site is its own contract.** Not a row in a shared registry — an EIP-1167 clone with its own
address, its own ERC-721 collection and its own funds. A defect in one site's treasury cannot reach
another's, because they are different contracts. This is also what makes the publisher's position
custodially clean: nobody else's inventory shares a balance with theirs.

**A whole page is one RPC call.** `readSlots(client, ref, keys)` returns every position at once, and
`readSlotsMulti` does the same across *many sites* — the directory read a monolithic on-site view
cannot do at all. No indexer, no database and no socket in the read path.

**Settlement is native or ERC-20, fixed per site.** `settlementToken` is frozen at deploy, so every
builder that moves money takes it explicitly. There is no default, because a default is silently
right for one kind of site and wrong for the other — and the bug would only appear on the first
token-settled deployment.

---

## Settlement of content

The chain stores a 32-byte hash. The bytes live off-chain:

```
object      = [schemeVersion:u8][kind:u8][payload…]
contentHash = sha256(object)
```

`payload` is opaque. Structure it however the application needs — the framework hashes bytes and
never learns the vocabulary, which is what stops a framework-wide content schema from accreting
fields it can never remove.

sha256 rather than keccak, so the hash **is** an IPFS CIDv1 raw address. A client holding nothing but
the on-chain hash can construct a gateway URL. No storage adapter, no mapping table, no backend on
the read path.

### Three operational facts

**Reads are backend-free; writes are not.** Something has to place the bytes somewhere retrievable by
hash. A hash committed on-chain whose bytes were never uploaded is a permanently blank position that
looks exactly like an SDK defect. Three tiers: a public pinning gateway (adequate for text), the
publisher's own upload route, or a hosted service.

The scaffold ships the middle tier — `app/api/content/[cid]/route.ts` serves files from `content/`,
so `pnpm dev` renders real content with no credentials. Swap `contentUrl` in `websitekit.config.ts` when
there is somewhere durable to put bytes.

**Resolve content server-side where possible.** `<Slot>` fetches on the client by default, so the
first paint is `fallback` and the real content appears after hydration — a visible flash, and a
crawler that only ever sees the placeholder. On a page whose premise is that the content belongs to
somebody, serving the placeholder to indexers is the wrong output. The scaffold resolves and verifies
in the Server Component and passes `<SlotProvider initialContent>`.

**Availability is not guaranteed by the chain.** A position can report as held and priced while its
content 404s. `<Slot>` degrades to `fallback` on any failure and never renders unverified bytes —
including images, which go through fetch-and-verify rather than `<img src={gateway}>`, because a
browser painting unchecked bytes defeats the verification entirely.

Payloads are capped at 1 MiB, enforced at encode time so it fails before signing.

---

## The `fallback` prop

```tsx
<Slot id="hero.headline" as="h1" className="text-6xl" fallback="Ship faster." />
```

`fallback` renders whenever there is no verified content — unissued, never edited, gateway down, hash
mismatch, or written by a newer scheme version than the client knows. At launch that is *most of the
board*.

This is what makes a page look finished before any inventory has sold, and it is the difference
between a product and a grid of empty boxes. Write real copy into it. A site whose storage has gone
entirely dark should still look like the thing it is pretending to be.

For open inventory, quote the price in the fallback. An open position that advertises its own floor
converts; one that renders blank reads as breakage.

---

## Reference deployments

Robinhood Chain testnet (46630). One chain at v1, deliberately — every chain needs its own
implementation deploy, its own audit sign-off and its own address, and multi-chain is a support
surface rather than a feature.

The current addresses live in
[`packages/websitekit-sdk/src/addresses.ts`](../packages/websitekit-sdk/src/addresses.ts) and are
exported as `ROBINHOOD_TESTNET` — read them from there rather than copying them, because a contract
change means a new generation and this document will not be the thing that gets updated first.

All four contracts are verified. Because every site is a canonical EIP-1167 clone, Blockscout
auto-detects the proxy — verifying the implementation once gives *every* site cloned from it a
readable contract page, permanently. A clone reporting `abi: 0` is how Blockscout models a proxy,
not a failure.

**Nothing here has been audited**, and the contracts are not upgradeable. Treat it as experimental.

---

## Reference inventory configurations

Four boards, live on testnet, cloned from the same implementation. They differ in the dimensions
that actually vary between publishers: **what is carved into inventory**, **the take economics**, and
**the rent economics**. Their reversion windows span 4 to 52 weeks — the full range the contract
permits — and their rent fees span 15% to 40% over terms from 14 to 365 days. Addresses are in
`addresses.ts` as `EXAMPLE_SITES`.

### The Weekly Dispatch — a newsletter archive

`take 1.4× · payout 1.15× · reversion 0.95/week over 26 weeks · rent fee 25%, terms to 90 days`

```
announce.bar  nav.link.1
masthead.title  masthead.tagline  sponsor.primary
issue.latest.sponsor  issue.prev.sponsor
recommended.1  recommended.2  recommended.3   footer.credit  footer.link.1
```

Sponsorship is already the revenue model; this makes the position tradable. The slowest reversion
of the four, because archive inventory retains value long after publication — a holder of
`sponsor.primary` keeps most of their position for months.

### DevConf Autumn — a conference site

`take 2× · payout 1.2× · reversion 0.9/week over 4 weeks · rent fee 40%, terms to 14 days`

```
announce.bar  nav.link.1
sponsor.headline
sponsor.gold.1  sponsor.gold.2  sponsor.gold.3
sponsor.silver.1  sponsor.silver.2   booth.1  booth.2   schedule.note  footer.link.1
```

Sponsor tiers are an auction conducted over email; this runs it on-chain. The steepest displacement
premium of the four — **2×**, so the publisher retains the widest spread on every contested upgrade
— and a 4-week window, because dated inventory has no use for a year-long reversion tail.

### Remote Roles — a job board

`take 1.3× · payout 1.1× · reversion 0.85/week over 8 weeks · rent fee 15%, terms to 30 days`

```
nav.link.1
banner.top
featured.1 … featured.5
category.design.sponsor  category.eng.sponsor   footer.link.1  footer.link.2
```

Listings churn, and stale featured inventory is worse than empty inventory. The lowest displacement
premium — friction suppresses turnover, and turnover is the objective — and the fastest reversion:
unrefreshed inventory returns to floor within two months and reopens.

### Vaultline — a DeFi protocol

`take 1.6× · payout 1.2× · reversion 0.9/week over 52 weeks · rent fee 30%, terms to 365 days`

```
announce.bar  nav.link.1
hero.headline  hero.sub  hero.cta
integration.1 … integration.4
ecosystem.1  ecosystem.2  ecosystem.3   audit.note  footer.link.1  footer.link.2
```

The configuration whose off-chain analogue is *already* a market: ecosystem placement, launch-partner
rows and integration listings are bought and sold today through business development, at
business-development latency. This runs the same trade at market latency. The full 52-week window,
because ecosystem positions are long-dated.

Note what is deliberately **not** inventory: the TVL and volume figures. A protocol that sold its own
metrics would be selling the right to misstate them. Issue attention; never issue facts.

| | address |
|---|---|
| The Weekly Dispatch | [`0x895Fb4Ba710b0f495983A582b5c9013ccC33736c`](https://explorer.testnet.chain.robinhood.com/address/0x895Fb4Ba710b0f495983A582b5c9013ccC33736c) |
| DevConf Autumn | [`0xA7f8Dba26F82cc1deD9a63F28932eC87128834F0`](https://explorer.testnet.chain.robinhood.com/address/0xA7f8Dba26F82cc1deD9a63F28932eC87128834F0) |
| Remote Roles | [`0x8c0d776ece615Ba01bE5038b95aA9Df5F3411f99`](https://explorer.testnet.chain.robinhood.com/address/0x8c0d776ece615Ba01bE5038b95aA9Df5F3411f99) |
| Vaultline | [`0xE41addf32313915F98b6cE5c63B6db8d0D6B092e`](https://explorer.testnet.chain.robinhood.com/address/0xE41addf32313915F98b6cE5c63B6db8d0D6B092e) |

Exported as `EXAMPLE_SITES` from `@websitekit/sdk` and rendered as live pages by `apps/websitekit-site`,
with per-position revenue computed through `computeSplit` from each board's on-chain terms.

---

## Operational notes

- **Positions are ERC-721 and marketplace-listable.** A position sold on a marketplace for 5 ETH
  remains takeable at its on-chain price of 0.4 the same minute. That spread is permanently
  arbitrageable and the arbitrage is the mechanism functioning as designed — but a buyer arriving
  from a marketplace will not know it. Disclose it in `tokenURI` metadata.
- **A transfer moves `owner` and nothing else.** `lastPrice` and `lastPurchaseTs` survive untouched,
  so a wash trade cannot launder a cost basis downward or reset the reversion clock.
- **Liquidity requires contested attention.** Inventory in front of a few hundred visitors sits at
  floor indefinitely, and a market with no displacement reads as broken rather than as calm. This is
  the single largest determinant of whether a deployment works, and no amount of contract correctness
  substitutes for it. It is also the specific problem the exchange layer exists to solve, by routing
  external demand into inventory that would otherwise be idle.

---

## Reference

- [Protocol spec](./PROTOCOL-SPEC.md) — every parameter decision and its reasoning. This is what
  the `§` references scattered through the source point at.
- **API reference: the TypeScript types**, plus the README in each package. There is deliberately no
  hand-maintained function list — the one this repo used to have spent a full release describing an
  API that had already changed, because it was the only document with no compiler behind it.
