# SlotSite v2 — contract spec

**Status:** complete — every parameter decision is closed (§9). **Written 2026-08-18.**
Build against this; changes from here need a recorded reason.

This is the document that gates the audit, and the audit gates mainnet. Everything on-chain lands
in **one implementation, audited once**. `SlotSite` is an EIP-1167 clone of a non-upgradeable
implementation with terms frozen at `createSite` — there is no second chance, and adding any of
this later costs a fresh audit plus every publisher who bought into the old implementation.

**Read first:** [`PIVOT-MAP.md`](./PIVOT-MAP.md) for what the product is and why. The v1 design
record is `../Website/docs/websitekit-sdk-spec.md`, whose eight locked decisions are cited here as
**`v1 §x`** — a bare `§x` always means a section of *this* document;
the rentals design record is `../Website/docs/design-ask-and-rentals.md`. Where this spec
contradicts either, this spec wins and says so.

**Source of truth for the port:** `../Website/packages/contracts/src/TinawSlotsV2.sol` — rentals
are *live on v1 mainnet since 2026-08-12* and have been driven end to end (35 assertions,
`scripts/rental-local.sh`). Port from the shipped contract, not from the design sketch: the sketch
is wrong in three documented places (§2.6).

---

## 0. What changes from v1

| | v1 (deployed, testnet) | v2 |
|---|---|---|
| Settlement | native ETH (`msg.value`) | **one ERC-20 per site, frozen at issue** (`address(0)` = native still legal) |
| Tenancy | `setEditor` only — dies on displacement | **rentals**: term-bound, escrowed, survives displacement |
| Owner exit from a dormant position | none | **the ask** — owner-set reversion base |
| Rental legibility | — | **ERC-4907** views over rental state |
| Publisher revenue | issuance + take spread | **+ rent share** |
| `encumbranceHash` covers | `basePrice`, `registered` | **+ the full rental tuple** |
| Terms after launch | frozen at `createSite`, forever | **three tiers** — free before the first claim, then holder-safe ratchets (§6.1) |
| Naming | `decayBps` / `maxDecayWeeks` | **`reversionBps` / `maxReversionWeeks`** (§6.3) |
| Publisher payout | `withdrawTreasury` is `onlyOwner` | **+ `sweepTreasury()`**, permissionless, always pays `treasury` (§10.4) |

Unchanged and not up for discussion: keyed slots (`tokenId = uint256(keccak256(key))`), frozen
economics with bytecode clamps, `Pricing.sol` imported and never re-implemented, the pull ledger,
`buyFor` / `createSiteFor`, clone-per-site fund isolation, closed-by-default registration.

**Takes are always on.** Settled 2026-08-18. No site may disable them.

---

## 1. Settlement in stablecoins

### 1.1 One token per site, frozen

`SiteConfig` gains `address settlementToken`. Frozen at `initialize()` alongside the economics,
with no setter.

**Why one and not many.** `lastPrice` and `basePrice` are single `uint256` values. A slot priced in
two tokens simultaneously needs an oracle to compare them, which reintroduces the external price
feed the entire design exists without. The publisher picks one at issue and checkout swaps for
buyers holding something else. **On the launch chain there is exactly one option** (§1.5, Finding
6), so the dashboard should not present a chooser until a second token exists.

`address(0)` keeps native settlement legal for crypto-native sites, so the v1 path stays available
rather than being deleted.

### 1.2 What it touches

Every path that moves money grows a branch. This is the widest blast radius in the release and it
lands on the function with the most existing test weight behind it.

| Path | Native (v1) | Token |
|---|---|---|
| `_settleBuy` collection | `msg.value >= charged`, credit change | `safeTransferFrom(msg.sender, this, charged)` — **exact, no change ledger** |
| `_withdrawTo` | `account.call{value:}` | `safeTransfer(account, amount)` |
| `withdrawTreasury` | `treasury.call{value:}` | `safeTransfer(treasury, amount)` |
| rent escrow | native, held in-contract | token, held in-contract |
| `receive()` | accrues to `treasuryBalance` | **reverts** — see below |

**`buy` / `buyFor` stay `payable`, with `if (settlementToken != address(0) && msg.value != 0)
revert`.** One function, one branch. Splitting into `buy` and `buyWithToken` doubles the surface on
the money spine for nothing.

**`receive()` must revert on token sites.** v1 accrues stray ETH to `treasuryBalance` so a
misdirected send is recoverable. On a token site `treasuryBalance` is denominated in the token, so
crediting it with ETH corrupts the accounting the invariant suite checks. Reverting strands nothing
that was ever legitimately sent.

**Use OpenZeppelin `SafeERC20`.** Some tokens (USDT most famously) return no boolean from
`transfer`, and a bare `IERC20` call against them reverts on decode. The launch token USDG is
well-behaved, but the settlement address is per-site config and chain-portable (§11), so the
tolerant path is the only safe one to freeze.

### 1.3 Approvals — no permit machinery in the frozen implementation

A token buy needs an allowance, which is a second transaction.

**Decision: batch at the wallet layer, not in the contract.** EIP-7702 is confirmed live on the
target chain (executed type-4 transaction on 46630, v1 §10.5), so `permit` + `buy` batch
atomically through EIP-5792 `wallet_sendCalls` against a delegated EOA. Wallets without batching
fall back to approve-then-buy. The managed/walletless path is a relayer, which handles it.

**Why not put `permit` params on `buy`.** It grows the money spine's signature permanently, and
every token variant that isn't ERC-2612 needs another one. If a permit path is later wanted, it
belongs in a **periphery router** — and periphery is not frozen, so it can be added at any time.
That asymmetry is the general rule for this release: *anything that can live outside the frozen
implementation should.*

A router pulling from the user then paying the site works today via `buyFor(recipient, …)`, which
is precisely why v1 §10.7 exists.

### 1.4 Decimals

USDG — like USDC and USDT — is 6-decimal. Floors, `maxPrice`, `defaultFloor` and rent rates are all
raw token units,
so nothing in `Pricing.sol` changes — it is decimal-agnostic integer math. But two things do:

- **The SDK's ether-string floors** (`floor: '0.05'`) must parse against the site's token decimals,
  not `parseEther`. This is a silent 10¹²-magnitude bug if missed — and the example boards were
  already deployed a million times underpriced once by exactly this class of error.
- **The dust-floor edge sharpens.** `floor × payoutBps` truncating to principal happens at 1 wei on
  an 18-decimal token; on a 6-decimal token the smallest meaningful unit is $0.000001, so the same
  truncation is reachable at plausible dust floors. Keep the "do not issue at dust floors" guidance
  and add a `MIN_FLOOR` clamp — **per-site or decimals-derived, never an implementation constant**;
  see §11.2.

### 1.5 Settlement token — chain survey, verified 2026-08-18

Resolves §9 item 6. **Method:** enumerated all ERC-20s on RH mainnet 4663 via Blockscout
(6 pages, ~300 tokens), probed candidates by `eth_call` against a funded Alchemy endpoint, resolved
the proxy/facet graph from `FacetUpdate` logs, and reconciled balances against `Transfer` events.
Reproduce with the same queries; nothing here is taken from a label.

**Finding 1 — there is no canonical USDC or USDT on Robinhood Chain.** The only 6-decimal
stablecoin on the entire chain is USDG. Every token *named* USDC or USDT is an impersonator: 18
decimals, a round `1,000,000,000e18` supply, and 44 bytes of bytecode (a minimal-proxy clone of a
scam template). **They also all answer `DOMAIN_SEPARATOR()` and `nonces()`**, so "supports permit"
is not a discriminator and neither is holder count — the fake `usdg` has 143k holders against the
real one's 75k. Symbol, name, and holder count are all forgeable here. Only the address is identity.

**Finding 2 — USDG is real, and it is the settlement token.**

| | |
|---|---|
| mainnet 4663 | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| testnet 46630 | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| shape | `ERC1967Proxy` → impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F` (`USDG`), verified |
| decimals | **6** |
| mainnet scale | 374.3M supply · 75,255 holders · **49.1M transfers**, live to the second |
| testnet scale | 11.0M supply, same proxy+facet architecture |

A matching testnet deployment with the same architecture is a genuine win: the ERC-20 path can be
built and tested against the contract it will actually meet in production.

**Finding 3 — `permit` is genuinely supported.** Routed to `TokenExtensionsFacet`
(`0x780d30b6…`), confirmed by `getFacet(0xd505accf)`. Note it is **absent from the base
implementation's ABI** — a naive ABI read concludes there is no permit. §1.3's batching plan holds.

**Finding 4 — `balanceOf` does NOT rebase.** This was the one that could have broken the design.
USDG carries `MultiplierMgmtFacet`, `ClaimableRewardsFacet` and `PayoutGroupFacet`, and emits
`MultiplierCreated` / `MultiplierRateScheduled` — which reads exactly like a rebasing token. It is
not: rewards accrue separately and are **claimed** (`availableRewardsOf`, `claimAll`) with opt-in
registration (`AccountRegistered`). Verified empirically across six top holders ($23M–$39M each)
over 5,000 blocks and 5,164 transfers — every balance reconciles **exactly** against `Transfer`
events, including three that moved millions mid-window. Six multipliers are active and none of them
touches `balanceOf`.

Had this gone the other way, escrow accounting and every price denominated in the token would have
been unsound.

**Finding 5 — the issuer can freeze, wipe, and pause. ACCEPTED RISK, with a design consequence.**

`TokenAdminFacet` (`0x58cab81e…`) exposes `freeze(address)`, `wipeFrozenAddress(address)`,
`pause()`. The base implementation additionally has `decreaseSupplyFromAddress(uint256,address)`.
The proxy is upgradeable (`upgradeTo`) and facets are swappable (`setFacet`) behind a role-gated
admin with a delay. `paused()` is currently `false`.

This is the same risk profile as USDC anywhere — Circle can blacklist too — and it is not a reason
to reject USDG. But it forces one rule:

> **Never assert `sum(pendingWithdrawals) + treasuryBalance + totalEscrowedRent == balanceOf(this)`
> on-chain.** An external freeze or wipe would make that assertion permanently false and brick every
> path that checks it. Conservation is a **test-only invariant**, exercised against a well-behaved
> mock. Production code tracks internal accounting and never reconciles against the token's view of
> its own balance.

Second-order, and benign: a frozen *payee* cannot be paid, so `withdraw` / `withdrawFor` revert and
their balance simply waits in `pendingWithdrawals` until they are unfrozen. The pull ledger already
handles "the payee cannot receive right now" — funds are delayed, never lost. A frozen *buyer*
fails at `safeTransferFrom`, which is a clean revert before any state moves.

**Finding 6 — what this changes in the spec.** Decision #2 named "USDC / USDT / USDG". In practice
there is one option today, which is simpler than planned:

- `settlementToken` stays a **per-site frozen address** exactly as specified. It is not narrowed to
  a USDG-only flag — bridged USDC may arrive later, and the field is what lets that happen without
  a new implementation.
- The dashboard's "pick your token" step is **moot for now**: USDG, or native for crypto-native
  sites. Do not build a chooser for one option.
- "Checkout swaps for buyers holding something else" now concretely means **swapping into USDG**.
- The `MIN_FLOOR` clamp question (§1.4, open item #5) gains weight — USDG's 6 decimals mean the
  smallest unit is $0.000001 and the dust-floor truncation edge is reachable at plausible floors.

**Watch item.** USDG is Paxos's Global Dollar and Robinhood is a Global Dollar Network member, so
its position on this chain is strategic rather than incidental. Re-run this survey before mainnet
in case a canonical bridged USDC lands in the interim — the address-not-the-label discipline in
Finding 1 applies to that check too.

---

## 2. Rentals

Delegated edit rights with an expiry. Not a transfer of ownership, not an escrowed sale — the
narrowest thing that puts fresh pixels on a position whose price has stalled.

### 2.1 The load-bearing rule

**Rent is escrowed and streams to whoever owns the position *now*** — never prepaid to the lister.

Prepaying the lister turns a rental into a free takeover shield: an owner rents to themselves at
the minimum rate on a rolling basis forever, and every prospective buyer inherits a position they
cannot edit. Streaming means self-poisoning costs the attacker the entire unaccrued remainder the
moment someone takes the position — **paid directly to the adversary.**

This is the rule everything else in §2 is arranged around. Violating it silently reintroduces the
holdout problem rentals exist to solve.

### 2.2 State

```solidity
// feeBps is SNAPSHOTTED at listForRent time — see §2.5. It is what stops a publisher
// setting 0% to attract listings and raising it before anyone rents.
struct Listing { uint192 ratePerDay; uint64 maxDurationSecs; uint16 feeBps; }  // rate 0 => not listed

struct Rental {
    address tenant;
    uint64  start;
    uint64  expiry;
    uint256 prepaid;              // net of the fee split — what actually streams
    uint256 claimed;
    bytes32 ownerHashSnapshot;    // restored on endRental
}

mapping(bytes32 => Listing) public listings;
mapping(bytes32 => Rental)  public rentals;
uint256 public totalEscrowedRent;
```

Keyed by `bytes32` rather than v1's `uint32` — the only mechanical change.

`accruedRent(key) = prepaid × (min(now, expiry) − start) / (expiry − start)`, linear, no segment
history.

### 2.3 Entry points

| | |
|---|---|
| `listForRent(key, ratePerDay, maxDurationSecs)` | owner only; `ratePerDay == 0` delists |
| `rent(key, durationSecs, expectedRatePerDay)` | prepays into escrow; requires no *uncleared* rental |
| `extendRental(key, durationSecs, expectedRatePerDay)` | current tenant, live term only |
| `claimRent(key)` | permissionless; always credits the current owner |
| `endRental(key)` | permissionless once lapsed; restores content, clears the rental |

Rules carried from the shipped contract, each of which closes a specific hole:

- **The rate floor is validated in `listForRent` only**, never re-checked in `rent`. Between listing
  and renting the floor can only fall — reversion only reduces it, and the one event that raises it
  (a purchase) clears the listing anyway. A second ≤52-iteration reversion loop on the hot path buys
  nothing.
- **`expectedRatePerDay` on both `rent` and `extendRental`**, reverting `RateChanged`. Without it an
  owner front-runs a rental by raising the rate — exactly what `maxPrice` guards on `buy`.
- **The term cap applies to the remaining window, not the total.** Cap the total and a tenant
  extends repeatedly in one block and holds a year. Expressed this way the safety property holds
  exactly: *no buyer ever inherits more than `maxRentalTerm` of encumbrance, however many extensions
  preceded it.*
- **Extension is settle-then-restart** at the **current** listed rate: flush what is earned, roll
  the unaccrued remainder forward, `start = now`, `claimed = 0`. One linear formula. Charging the
  originally-paid rate would let an incumbent lock in a cheap rate forever.
- **`edit` locks the owner out for the term.** Otherwise the owner overwrites the tenant's content
  the moment it is paid for and the product is unsellable. `canEdit` becomes: live rental → tenant
  only; else owner or live editor-grant.
- **`endRental` restores `ownerHashSnapshot` and bumps `version`.** Doing the restore on-chain keeps
  *"content only renders against a matching on-chain hash"* literally true, and the version bump
  makes the restore flow through the same content gate as an edit.
- **`paused` gates `rent` and `extendRental`** (value transfers) but not `claimRent` (already-earned
  money) and not `listForRent`.
- **Rentals are not gated by `cooldownSecs`.** That throttles takes, not content.

### 2.4 What `buy` does to a rental

```
_buy: … → _settleRent(key) → delete listings[key] → mint/transfer
```

- **Settle rent to the outgoing owner before ownership moves.** Otherwise everything
  accrued-but-unclaimed silently transfers to the buyer, and an owner who is taken mid-term forfeits
  rent they had already earned — which they cannot avoid, since they do not choose when they are
  taken. A no-op cold read for the overwhelming majority of positions, which have never been rented.
- **The listing dies; the rental survives.** The new owner should not be renting out at a rate they
  never chose, and the tenant should not be ruggable mid-term. Side effect, and a good one: an
  inherited tenant cannot extend until the new owner actively re-lists.
- The anti-poison property is unchanged: what a self-poisoning owner forfeits is the *unaccrued*
  remainder.

### 2.4.1 Why anyone buys an encumbered position

The obvious objection: if a tenant holds a long term, why would anyone buy the position? Recorded
because the answer is not self-evident and the mechanism depends on it.

**A buyer inherits an income stream, not empty pixels.** The unaccrued rent streams to whoever owns
the position *now*, so the honest arithmetic is:

```
effective cost = take price − unaccrued rent inherited
```

A position with 300 days left at $10/day carries $3,000 of inherited income and may be takeable at
$14 because the floor has reverted. That is not unattractive — it is free money, someone takes it
immediately, the ladder ratchets, and the publisher earns their spread on every take in the sequence.

**The two-layer split is what resolves it.** A rented position is off the *advertiser* market and
still fully on the *investor* market. An advertiser wanting to place creative should rent the next
term, not buy. An investor buying for stream and residual does not care about edit rights at all.
Position-as-financial-asset, tenancy-as-attention-product — the same division the whole design rests
on.

**Why the tenancy cannot simply die on a take.** If it did, any advertiser's placement could be
destroyed by anyone willing to pay the take price. No advertiser would ever rent, and the tenancy
layer — the cash-flow layer, and the publisher's primary revenue story — would be worthless.
Survival is what makes a tenancy sellable, not a courtesy to tenants.

**The self-poison case improves with term length**, against intuition. An owner self-renting for a
year to block takes must prepay ~91% of the effective floor into escrow (at 0.25%/day), and the
unaccrued remainder goes to whoever takes them. A longer poison is a bigger bounty for the person who
breaks it.

**Three things that remain genuinely wrong:**

1. **The formula price is blind to the lease.** The contract cannot price an encumbrance, so an
   encumbered position trades only once reversion walks the take price below stream-plus-residual
   value. That works, but reversion is doing a job it was not designed for — slow and crude next to a
   market that prices leases directly. No contract fix; noted so it is not mistaken for an oversight.
2. **Nothing surfaces the net** — see §2.4.2. This is most of the objection and it is fixable.
3. **The ceiling and the reversion horizon interact** — see §8.

### 2.4.2 The buy path must surface inherited rent

**Required, and the reason the objection above lands at all.** Today a buyer sees "pay $14" and
"rented until March" as two unrelated facts and must do the arithmetic themselves, so it *reads* as
"buy a position you cannot use".

- `readBuyContext` returns the **unaccrued rent** alongside the quote, pinned at the same block as
  everything else (the torn-read rule in `sdk.md` applies unchanged).
- The buy dialog states all three numbers: **"you pay $14 · you inherit $3,000 of rent · net
  −$2,986"**.
- The same figure belongs on the directory listing for any encumbered position.

SDK and UI only — no contract change. `encumbranceHash` already covers `prepaid` and `claimed`, so
the data is on-chain and pinned.

### 2.5 The fee split — SETTLED 2026-08-18

v1 takes `rentFeeBps` (3,500) wholly to `treasuryBalance`, correct there because the site owner
*is* the protocol. Under multi-tenancy it splits:

```
cost            = ratePerDay × durationSecs / 86400
protocolCut     = cost × protocolRentBps        → pendingWithdrawals[protocolTreasury]
siteCut         = cost × listing.feeBps         → treasuryBalance
net (streams)   = cost − protocolCut − siteCut  → escrow, streams to the position owner
```

| | value | placement |
|---|---|---|
| `protocolRentBps` | **500 (5%)** | **implementation `immutable`** — mirrors `protocolBps` on buys |
| `siteRentBps` | publisher's dial, 5–35% | **freely mutable**, snapshotted into each `Listing` |
| `MIN_RENT_FEE_BPS` | **1000 (10%)** | implementation constant |
| `MAX_RENT_FEE_BPS` | **4000 (40%)** | implementation constant |

Total (`siteRentBps + protocolRentBps`) is clamped to the band at `listForRent` time.

**Why 5% for the protocol.** It matches the buy path, so the whole pitch is one sentence — *the
protocol takes 5% of everything* — and being a percentage rather than a calibrated number, it
survives any demand regime: if the ad network makes rent 10× larger, 5% scales with it. The regret
is also asymmetric. Raising it later is cheap (a new implementation; existing sites keep theirs and
nobody is stranded); lowering it is impossible without abandoning every publisher who bought in.

### 2.5.1 Why rent economics are NOT frozen

This is a deliberate departure from §6.1's tiering, and the reasoning is what justifies it.

**Take economics must be frozen because they bind a holder who cannot exit** — their only escape is
being taken, which they cannot force. That is the entire §6.1 argument, and a timelock does not fix
it because notice without recourse is not protection.

**Rent fees bind nobody involuntarily.** The fee is taken at `rent()` time and the remainder
escrowed, so a change *cannot touch an active tenancy*. It affects only rentals not yet created —
and an owner who dislikes the new rate simply does not list. That is real recourse, and it is why
`siteRentBps` and `maxRentalTerm` can be freely mutable without breaking the trust model.

**The one hole, and its fix.** A publisher could set 0% to attract listings, then raise it before
anyone rents. So `Listing` **snapshots `feeBps` at `listForRent` time** and `rent`/`extendRental`
charge the snapshot. Publisher changes apply only to new listings. Listings already clear on sale,
so a new owner re-lists at the current rate.

### 2.5.2 The fair-rent anchor does not survive an ad network

**Correction to the v1-derived reasoning, recorded because it is load-bearing.**

`design-ask-and-rentals.md` derives fair rent as the owner's weekly reversion carry. That is a
**supply-side** derivation, valid only while the owner's alternative is holding and waiting to be
taken. In an ad network rent is priced by **advertiser demand**, which can exceed carry by an order
of magnitude — and every parameter calibrated against the carry anchor inherits that error. Rotation
may also get much faster (advertisers flipping inventory) or much longer (negotiated placements);
neither shape is what v1's 7-day, whole-day, single-site parameters were built for.

Two consequences:

1. **`MIN_RENT_FEE_BPS` does not structurally prevent entrenchment.** Once rent substantially
   exceeds carry, the owner is reversion-immune *at any fee percentage* — 30% of 10× carry still
   clears carry. The floor is a guard for the **low-demand regime every site starts in**, blocking
   the rate-0 self-poison. It is not a general property, and it should not be described as one.
2. **What actually corrects the high-demand case is the take ladder.** A position yielding $100/week
   whose floor has reverted to $10 gets taken at $14, then $19.60, then $27.44, until the take price
   reflects the income. Arbitrage reprices it, and the publisher earns their spread on every take in
   that sequence. The mechanism survives; only the calibration was wrong.

This is why the band is wide (10–40%) and the publisher's dial is mutable: the correct number is not
knowable in advance, so the design must let it be found rather than guessed.

### 2.5.3 Duration granularity

`rent(key, numDays, …)` cannot express "six hours", which rules out the fast-rotation regime.
**Take `durationSecs` and keep `ratePerDay` as the stored rate:**

```
cost = ratePerDay × durationSecs / 86400
```

Storing a per-second rate instead would truncate to zero on a 6-decimal token for any cheap position
($0.001/day ÷ 86400 → 0 units). Keeping the rate per-day preserves precision, allows arbitrary
duration, and matches `accruedRent`, which is already per-second. A `MIN_RENTAL_DURATION`
implementation constant (1 hour) prevents dust rentals.

### 2.5.4 `MAX_RENTAL_TERM_CEILING` = 365 days — SETTLED 2026-08-18

With `maxRentalTerm` now freely mutable per site (§2.5.1), the ceiling is the only frozen part of it.
It is not "how long should a rental be" but "what is the longest a publisher may ever allow".

**It is not a safety mechanism, and should not be reasoned about as one.** `encumbranceHash` already
carries the live rental's actual expiry, so a buyer sees any tenancy and can refuse — they are
protected by the guard, not the ceiling. Extension applies the cap to the **remaining** window, so a
tenant can perpetually top back up to it; the owner's control is delisting, which blocks extension
at the term boundary.

**365 days** because the regret is asymmetric and points up: too low makes negotiated annual
placements impossible and is fixable only by a new implementation, while too high merely lets
publishers create illiquid positions — their own choice, on their own dial, with buyers guarded.
Mechanically free: no loop over the term, no `uint64` overflow risk.

**Accepted risk:** a long tenancy locks a correspondingly long prepayment in escrow, which is
capital exposed to an issuer freeze or wipe (§1.5, Finding 5). Mitigated in practice because tenants
prefer short terms plus extension, which the mechanism already supports.

### 2.6 Three places the design sketch is wrong

`design-ask-and-rentals.md` predates the shipped contract. Port from the contract:

1. **`buy()` DOES touch the rental.** The sketch says it does not. `_buy` calls `_settleRent` before
   ownership moves and deletes the listing.
2. **Expired is not ended.** `rent()` reverts `RentalActive` on a lapsed-but-uncleared term, so a
   new tenant cannot simply take over — someone must call `endRental` first. This makes the keeper
   load-bearing for the *mechanism*, not just for content hygiene: an uncleared term takes the
   position off the rental market entirely, for everyone, indefinitely.
3. **A term cannot be shorter than one day** *in v1*: `rent` takes `numDays` and multiplies by
   `1 days`. **v2 changes this** — see §2.5.3.

And one reachable state the UI must handle: **a tenant may take the position they rent**, ending up
owning and renting it simultaneously. `owner == tenant` is legal, not an edge case to exclude.

### 2.7 The keeper becomes multi-tenant

`endRental` is permissionless and spends only gas. v1 runs it as an indexer sibling
(`rental-ender.ts`) over 165 known slots. Here it must walk **every site in the directory**, which
makes it directory-dependent infrastructure rather than a per-site script.

Two carried lessons: **`rentalExpiry == 0` means no rental** (the opposite convention to v1's
upgrade fields, which sit adjacent in the same view), and **the keeper must read the chain's clock,
not the machine's.**

---

## 3. The ask

Reopens v1 §10.6, which cut owner-set pricing for the crypto-builder audience. It comes back because
the failure it fixes — *the most valuable position prices itself into dormancy* — is the **default
state** on third-party sites, not the edge case, and because v2's owner pricing was well received on
v1.

### 3.1 The shape

The owner posts a number that replaces `lastPrice` as the **base the reversion loop runs on**. It
does not replace the reversion **clock**, and it is not the price the buyer pays.

```
reversionBase  = slot.askFloor != 0 ? slot.askFloor : slot.lastPrice
effectiveFloor = max(basePrice, reversionBase × reversionBps^periods)    // periods from lastPurchaseTs
charged        = effectiveFloor × takeBps / 10_000                 // unchanged
```

**`Pricing.computeTakePrice` is untouched.** We change what gets passed as its first argument and
nothing else, so all 3,024 parity vectors stay valid and the new logic lives entirely outside the
parity-critical loop.

The split stays keyed to `effectiveFloor`. If the ask were the *list price* instead of the floor,
`siteCut = charged − payout − protocolCut` underflows for any ask below `(payoutBps + protocolBps)`
and the position becomes unbuyable. As a floor it is always positive at any ask.

### 3.2 Two load-bearing rules

1. **The reversion clock never resets.** Reversion is measured from `lastPurchaseTs`; setting an ask does
   not touch it. If it did, an owner re-posts the same ask every six days and the price never
   revert — the holdout scenario fully restored, with extra steps. Consequence: an ask posted three
   weeks into a tenure is immediately discounted by `reversionBps³`. The posted number is a pre-reversion
   base, not a live price, and the UI has to say so.

2. **The cap anchors to `lastPrice`**, which only changes on a sale and is therefore frozen for the
   whole of an owner's tenure:
   ```
   askFloor ∈ [ basePrice , maxAskBps × max(lastPrice, basePrice) / 10_000 ]
   ```
   Anchoring to `effectiveFloor` instead creates an unbounded ratchet: post at 4× the current floor,
   which raises the floor, post again at 4× the new floor, repeat.

Reject `askFloor < basePrice` at write time rather than letting `max()` clamp it silently — the
owner should get an error, not a no-op the UI has to explain. `askFloor` is cleared on sale: a new
owner inherits no ask. Not gated by `paused` or `cooldownSecs` — lowering your own price is never
the thing to throttle.

### 3.3 Placement — SETTLED 2026-08-18

**`maxAskBps` → per-site config**, default **40_000 (4×)**, clamped **`≥ 10_000`**. Tier-1 free and
Tier-2 down-only per §6.1–6.2. An earlier draft made it an implementation constant; §6.2 supersedes.

**The markup-vs-down-only question dissolves into the default.** The bound is
`askFloor ∈ [basePrice, maxAskBps × max(lastPrice, basePrice) / 10_000]`, so setting
`maxAskBps = 10_000` collapses the cap to `lastPrice` and the range becomes `[basePrice, lastPrice]`
— which **is** down-only. One knob expresses both regimes; there is no either/or to implement. The
`≥ 10_000` clamp exists because below it an owner could not post an ask at their own purchase price.

**Why markup is the default.** Two reasons, the second specific to the ad-network direction:

1. **Markup is self-limiting.** An ask reverts from `lastPurchaseTs`, and setting one never resets
   that clock (§3.2, rule 1). A 4× markup at week 0 is ~1.4× by week 10 at 0.9/week, and re-posting
   the same number does not help — it reverts from the same origin. The abuse case is bounded with no
   extra mechanism.
2. **An ad network needs a fast repricing path.** A position yielding $100/week whose floor has
   reverted to $10 is takeable at $14. Without markup the only route to a correct price is the take
   ladder — roughly ten successive takes, each requiring someone to pay a premium. With markup the
   owner states the number. Since rentals are the cash-flow layer, income-generating positions must
   be repriceable by their holder, not only by contested takes.

**The v1 §10.6 objection that survives** is the support burden — *"I set a price, came back, it is
lower"* — which is real for a non-crypto audience. That is an ask panel showing three points on the
curve (buyer pays X now, Y in 7 days, Z in 30), not a reason to cut the feature. The *subtler* §10.6
trap does not apply at all: that one was a multiplier applied to the wrong side of the reversion
loop, and the ask is the reversion **base**, so the ordering hazard never arises.

**Incentive alignment worth not breaking.** Markup raises the publisher's take cut, since their
spread is a multiple of the effective floor. Publisher and owner interests point the same way here —
rare in this design.

**Interaction:** the ask feeds `effectiveFloor`, which is also what the rent floor is computed from.
An owner marking down lowers their own rent floor and makes self-poisoning cheaper — but a
marked-down position is also cheap to *take*, which defeats the holdout they would be poisoning to
protect. The attacker cannot have both. And a dormant position pays the publisher nothing, so the
exit valve serves the publisher too.

## 4. ERC-4907 — SETTLED 2026-08-18

Expose the rental as the standard rentable-NFT interface so wallets and marketplaces render
"rented until X" without knowing anything about us:

```solidity
function userOf(uint256 id) external view returns (address);      // live tenant, else address(0)
function userExpires(uint256 id) external view returns (uint256); // rental.expiry
function setUser(uint256, address, uint64) external;              // reverts — TenancyViaRentOnly
```

**Maps to rentals only, never to editor grants.** A grant has no expiry — it dies on take or
transfer, not on time — so `userExpires` for a grant would have to lie (`0` or max, both wrong). A
time-bounded user is exactly what a tenancy is and nothing else here is.

**`setUser` reverts with a named custom error**, and the interface is **still declared**. The read
path is the valuable one and discoverability requires the declaration: an integrator gating on
`supportsInterface(0xad092b5c)` sees nothing without it, which would defeat adding ERC-4907 at all.
Disclose the restriction in `tokenURI` metadata alongside the takeability disclosure.

The cost, accepted: declaring an interface whose write function reverts is technically a false
claim, and a rental marketplace attempting to list a position would fail. That failure is **loud** —
it reverts at simulation, and any competent integrator simulates before listing. No ERC-4907 rental
marketplace exists on the launch chain today, so the mis-integration risk is theoretical at launch;
this is on the list only because it is frozen bytecode.

**Rejected: `setUser` as a free, time-bound tenancy that dies on displacement** (effectively
`setEditor` with an expiry). Coherent and poison-free — a take kills it, so it cannot become a
takeover shield — but it introduces a *third* tenancy concept alongside editor grants and rentals,
forces `userOf` to report two different mechanisms, and spends frozen bytecode doing it. Contract
size is the top risk in §8.

## 5. Encumbrance

v1: `keccak256(abi.encode(slot.basePrice, slot.registered))`.

v2 adds the rental tuple:

```solidity
function encumbranceHash(bytes32 key) public view returns (bytes32) {
    Rental storage r = rentals[key];
    return keccak256(abi.encode(
        slot.basePrice, slot.registered,
        r.tenant, r.expiry, r.prepaid, r.claimed
    ));
}
```

**No `maxRentalExpiry` parameter on `buy`.** v1 settled this as D-09 and shipped it: a generic
guard replaces what would otherwise be a growing list of buy parameters — `maxRentalExpiry`, then
one per future encumbrance, each a signature change on the function with the most test weight behind
it. `SlotSite` already has `encumbranceHash`; extending its preimage is free and the buy signature
never moves.

The behaviour is what a buyer needs: a rental appearing, extending, or accruing between quote and
submit reverts as `TermsChanged`. `readBuyContext` already pins quote + encumbrance + chain clock at
one block, so the SDK ordering rule carries unchanged.

**Deliberately excluded:** `contentHash` and `version` (content is not an encumbrance; including it
would make every buy race every edit), and `askFloor` (it moves price, and `maxPrice` already guards
price — same reasoning v1 applies to `priceMultiplierBps`).

---

## 6. The knob table

Every new value, and where it lives. This is the table the audit reads.

| knob | placement | bound |
|---|---|---|
| `settlementToken` | **frozen per site** | any ERC-20, or `address(0)` for native |
| `siteRentBps` | **freely mutable** (§2.5.1) | snapshotted per `Listing`; with `protocolRentBps` within `[MIN, MAX]_RENT_FEE_BPS` |
| `maxRentalTerm` | **freely mutable** (§2.5.1) | `≥ MIN_RENTAL_DURATION`, `≤ MAX_RENTAL_TERM_CEILING`; buyers guarded by `encumbranceHash` |
| `MAX_RENTAL_TERM_CEILING` | **implementation constant** | **365 days** — see below |
| `protocolRentBps` | **implementation `immutable`** | **500 (5%)**, mirrors `protocolBps` |
| `MIN`/`MAX_RENT_FEE_BPS` | **implementation constants** | **1000 / 4000** |
| `MIN_RENTAL_DURATION` | **implementation constant** | 1 hour (§2.5.3) |
| `minRentBps` | **frozen per site** (§6.2) | anti-poison floor, ~25 bps of `effectiveFloor`/day; implementation floor beneath it |
| `maxAskBps` | **frozen per site** (§6.2) | default **40_000** (4×), clamped **≥ 10_000**; `10_000` = down-only |
| `MIN_FLOOR` | **frozen per site**, or derived from `decimals()` (§11.2) | never an implementation constant |
| `listings[key]` | freely mutable by owner | cleared on sale |
| `askFloor` | mutable by owner | cleared on sale; `[basePrice, maxAskBps × anchor]` |

Carried from v1: `takeBps` / `payoutBps` / `reversionBps` / `maxReversionWeeks` / `cooldownSecs`
per-site (renamed per §6.3, and now tiered rather than frozen outright — see §6.1); per-slot floor mutable at ±20%/24h; treasury, pause, metadata, royalty, registration freely
mutable; `protocolBps` immutable in the implementation.

**Why `maxRentalTerm` is per-site rather than a constant:** a conference site wants 3 days, an
ecosystem page wants 30. It is frozen, so it cannot move under a buyer, which is why it does not
need to be in `encumbranceHash`.

---

### 6.1 Three tiers of mutability

v1 is binary — frozen at `initialize()` or freely mutable — and that is too blunt for an audience of
*all* publishers. Locking a newsletter and a job board into the same take multiple is exactly the
thing this product should not do.

The constraint that actually matters is narrower than "frozen forever":

> **Terms only need protecting once someone's money is in a position.** A site with zero claimed
> positions can change anything and harm nobody.

**Tier 1 — before the first claim: freely mutable.** The publisher installs the snippet, watches
their page, adjusts the take multiple and reversion rate, re-prices floors, changes their mind
repeatedly. Implemented as one `bool termsLocked`, set on the first mint ever in `_buy` — one SSTORE
on the first claim in a site's life, one SLOAD per terms change. Once locked, always locked; a
position cannot be un-minted.

**SETTLED 2026-08-18: the window is claim-boxed, not time-boxed.** The alternative considered was
"free until the first claim *or* N days, whichever is later", so that a publisher whose first
position sells within minutes still gets room to experiment. Rejected: it means anyone buying in
those first N days holds a position whose terms can still move under them, which is precisely the
guarantee the whole model exists to make. A publisher who wants to experiment does it on **testnet
via a dashboard dry-run** — free, unlimited, and it costs no buyer anything.

**Tier 2 — after the first claim: ratchets, in the holder-safe direction.** v1 §10.3 already deferred
ratchets to v2 (`payoutBps` up-only, `takeBps` down-only), so this is a planned door.

| knob | direction | why that direction is the safe one |
|---|---|---|
| `takeBps` | **down-only** | cheaper to displace = more liquidity, and payout is unaffected. Raising it freezes the market and strands holders, whose only exit is being taken by someone else. |
| `payoutBps` | **up-only** | pays displaced holders more. Lowering it takes money directly from current holders. |
| `reversionBps` | **up-only** (slower) | protects the payout a holder is owed. Faster reversion cuts what a premium buyer recovers. |
| `maxReversionWeeks` | **down-only** | less total reversion; same property as above. |
| `cooldownSecs` | **down-only** | shorter = more liquid. Raising it is how an owner makes their own inventory permanently un-takeable — the original reason it was frozen. |
| `siteRentBps` | **down-only**, bounded by `MIN_RENT_FEE_BPS` | publisher takes less of the rent; landlords net more. |
| `maxRentalTerm` | **down-only** | shorter encumbrance for an inheriting buyer. |
| per-slot floor | ±20%/24h, unchanged | already rate-limited in both directions. |

Two properties fall out, both good:

- **The ratchet is self-limiting.** `takeBps` falling and `payoutBps` rising converge on the existing
  `takeBps > payoutBps + protocolBps` clamp and stop. No unbounded drift, no timelock needed.
- **The publisher's revenue lever stays open in both directions.** The per-slot floor is already
  rate-limited at ±20%/24h, and raising it raises the *holder's* payout too, so it is not adversarial
  — see `PIVOT-MAP.md` §Q3a, where floor ratcheting is the largest uncaptured revenue lever.

**Tier 3 — never: `settlementToken`.** Changing it mid-life orphans every balance denominated in the
old token.

**Why not a timelock.** v1 §4 rejected one and the reasoning still holds: `expectedTerms` protects a
*transaction*, not a *holding period*, and a position holder's only exit is being taken by someone
else, which they cannot force. Notice without recourse is not protection. Ratchets need no notice
because there is no unsafe direction to give notice about.

### 6.2 Knobs promoted from constant to per-site

v1 constants carried into v2 that should become publisher config — Tier-1 free, Tier-2 ratcheted:

| | v1 | direction after lock |
|---|---|---|
| floor change limit (`MAX_FLOOR_DELTA_BPS`, ±20%) | constant | down-only (tighter) |
| floor change cooldown (24h) | constant | up-only (slower) |
| max ask markup (`maxAskBps`, 4×) | constant | down-only |
| min rent rate (`minRentBps`, 25) | constant | up-only, with an implementation floor |

**Staying hardcoded, deliberately:** `protocolBps` and `protocolRentBps` (protocol revenue — a clone
must not be able to strip them), `MAX_TAKE_BPS`, `MAX_REVERSION_WEEKS_CEILING`, `MAX_COOLDOWN_SECS`,
`MAX_ROYALTY_BPS`, `MIN`/`MAX_RENT_FEE_BPS`. These are the guardrails that let a buyer trust a site
they have never heard of without reading its config, and they are the reason one audited
implementation can serve every publisher.

**Cost, and it is not free:** four more config fields plus ratchet validation is real bytecode, and
contract size is the top risk in §8. This reinforces step 1 of the build order — measure the
skeleton before writing tests.

### 6.3 Naming — "decay" becomes "reversion"

`decayBps` / `maxDecayWeeks` are renamed **`reversionBps` / `maxReversionWeeks`** across the contract
surface, the SDK, and all documentation.

The old name is inaccurate and it costs sales. The mechanism is bounded below by `basePrice`
(`effectiveFloor = max(basePrice, …)`), so nothing evaporates — it is **mean reversion of the
takeover price toward a publisher-set floor**. Ownership never lapses; a holder only loses the
position if someone pays them at least the floor.

- Contract / SDK: `reversionBps`, `maxReversionWeeks`.
- Publisher-facing: *"how fast the takeover price returns to your floor."*

**SETTLED 2026-08-18.** "Cooling rate" and "settling rate" were the alternatives; `reversion` wins
on precision — it is the standard term for exactly this behaviour, and it carries no implication of
loss. The rename must land before the SDK is published, after which it is a breaking public-API
change.

The vendored `Pricing.sol` is renamed to match. The parity harness compares **values, not
identifiers**, so all 3,024 vectors remain valid across the rename.

### 6.4 Surface: profiles, not raw bps — SETTLED 2026-08-18

Full configurability makes every site a different market, which is bad for buyers reasoning across
inventory and bad for the directory. The contract takes raw config; the **dashboard offers four
named profiles plus an advanced mode**. Flexibility in bytecode, legibility on the surface.

| profile | take | reversion | horizon | premium persists | for |
|---|---|---|---|---|---|
| **Standard** — *default* | 1.4× | 0.97/wk | 52 wk | ~11 wk | blogs, most sites |
| High-traffic | 1.3× | 0.93/wk | 13 wk | ~4 wk | news, fast turnover |
| Long-dated | 1.6× | 0.98/wk | 52 wk | ~17 wk | ecosystem pages, partner listings |
| Dated / event | 2.0× | 0.90/wk | 8 wk | ~3 wk | conferences, campaigns |

Common to all: `payoutBps` 11500, `siteRentBps` 2500, `maxRentalTerm` 30 days, `maxAskBps` 40000.
The **Standard** default in full: `takeBps` 14000, `payoutBps` 11500, `reversionBps` 9700,
`maxReversionWeeks` 52, `cooldownSecs` 900.

**Why 0.97/week and not v1's 0.90.** At 0.90 a take's premium unwinds in **3.2 weeks** — correct
for a single hot page where inventory should recycle fast, wrong for a publisher whose inventory
trades quarterly, because discovery is erased before the next trade. Every trade then starts from
the floor, no ladder forms, and the publisher's cut stays pinned at `0.20 × basePrice` forever.
Solving for persistence gives the rate directly: ~8 weeks → 0.96, ~11 weeks → 0.97, ~17 weeks → 0.98.

**The counter-pressure that stops it going slower still:** reversion is the **abandonment handler**
(the ask only helps a rational, present owner — §3). `maxReversionWeeks` bounds it: at 0.97 over 52
weeks a position reverts to ~20% of `lastPrice`, so an abandoned position resolves within a year.

**What de-risks the whole choice:** per §6.1 terms are freely mutable until the first claim, so a
publisher who takes a bad default can still fix it. A wrong default costs a conversation, not a site.

The `high-traffic` profile deliberately carries the *lowest* take multiple: friction suppresses
turnover, and on fast inventory turnover is the objective. This inverts the intuition that busier
inventory should cost more to displace.

## 7. Downstream

**SDK.** New builders (`buildListForRent`, `buildRent`, `buildExtendRental`, `buildClaimRent`,
`buildEndRental`, `buildSetAsk`) and reads (`readRental`, `readListing`, `readAccruedRent`). Two
pure helpers mirrored in Solidity: `resolveReversionBase` and `accruedRent`. Neither enters the
reversion loop. Plus the decimals fix in §1.4, and `buildSetBaseTokenURI`, which v1 never had.

`readBuyContext` must additionally return the **unaccrued rent** so the buy path can show net cost
(§2.4.2) — the single highest-value SDK change in this release for making encumbered positions
tradeable.

**Test layers — all four survive, each grows:**

1. **Parity harness.** New vectors for `resolveReversionBase`, the ask bounds, and rent accrual. Existing
   take-price vectors are unaffected *by construction* — that is the point of §3.1.
2. **Anvil e2e.** The full rental lifecycle against a real EVM, plus an ERC-20 path with a
   6-decimal mock. This layer is what caught the wall-clock deadline bug.
3. **Invariant suite.** The conservation invariant becomes
   `sum(pendingWithdrawals) + treasuryBalance + totalEscrowedRent == token balance` (or ETH balance
   for native sites). New invariants: a rental never outlives `maxRentalTerm` from any starting
   point; `claimed ≤ prepaid`; `endRental` always drains escrow to zero; a position's owner always
   recovers ≥ floor **including** rent settled on the take path.
4. **Unit tests.**

**Test parameter *combinations*, not just features.** `MAX_RENTAL_TERM_CEILING` (365 days) and the
Standard reversion horizon (52 weeks) were each chosen soundly and only conflict together (§8) —
that class of defect is invisible to per-feature tests. The suite must sweep admissible config
combinations, not one config per feature.

**The trap that cost the most time writing the v2 suite**, and it is the one v1 already documented:
an external call inside an argument list is evaluated *after* `vm.prank`/`vm.expectRevert` is armed,
so it consumes the prank or the expectation. It surfaced **six times** in one sitting —
`site.slotOf(...)`, `site.minFloor()`, `_listedRate()` and `_fairRatePerDay()` all read as ordinary
values and are not. Symptoms are misleading in both directions: a consumed prank reverts
`Unauthorized`/`NotSlotOwner` and reads like a broken access check; a consumed expectation reports
"next call did not revert as expected" and reads like a missing guard. **Hoist every read into a
local before arming a cheatcode.**

Second, related: overfunding a revert test from an account that has already spent produces a bare
`EvmError` with no custom error — indistinguishable from an out-of-funds CALL. If the revert fires
before collection, send no value at all. The token variant hides this, because there the value is 0.

Foundry traps that cost time in v1 and will again: invariant failures are cached (`rm -rf
cache/invariant`); coverage assertions must be `afterInvariant`; an external call in an argument
list eats `vm.prank` — including `sha256`, which is a precompile.

**Off-chain, none of it gating the audit:** the `endRental` keeper as directory-wide infrastructure
(§2.7); rental and ask panels; the ERC-721 metadata routes, which 404 today while every board's
`baseTokenURI` points at them; floor-ratcheting guidance in the dashboard (`PIVOT-MAP.md` §Q3a —
the single largest uncaptured publisher revenue lever, and it needs no contract work at all).

---

## 8. Risks

**Contract size.** v1's runtime is 15,305 bytes against the 24,576 limit. Rentals are roughly a
doubling of the state machine, plus ERC-20 branches, plus the ask, plus ERC-4907. **This is the
risk most likely to force a structural decision late.** `via_ir = false` is deliberate — the same
`Pricing` reversion loop is the core of this package — so the escape routes are library extraction and
trimming, not a compiler flag. Measure early: build a skeleton with all four features stubbed and
check the size *before* writing the tests.

**Three mechanisms on one release, all touching `buy` and `edit`.** Rentals, the ask, and token
settlement land together because they must all precede one audit. The design record has worked out
most of the interactions, but the invariant suite has to cover the *composition*, not just each
feature.

**The money spine changes shape.** ERC-20 settlement rewrites collection and payout on the function
with the most test weight behind it. Every existing money test needs a token variant.

**Escrow is a second money path** alongside the pull ledger. It must credit `pendingWithdrawals`
for every payout and never call out directly.

**`SiteConfig` is getting wide.** Each field is a lever that can be set to a value breaking an
assumption elsewhere. `_validateConfig` grows with it, not around it.

**A stablecoin depeg would break the floor mechanism**, and no contract change fixes it: floors move
only ±20%/24h, so a publisher cannot chase a depeg even if they notice. Low probability, but it is
the same failure shape that ruled out native ETH settlement (§10.7).

**`MAX_RENTAL_TERM_CEILING` (365 days) can span the entire reversion horizon** (Standard is 52
weeks = 364 days). A maximally-encumbered position can therefore be locked for the whole discovery
cycle, reverting to floor while its owner has no control. Reachable, and it was not checked when the
two numbers were set independently. **Mitigated by the default, not by the ceiling:** the Standard
profile sets `maxRentalTerm` to 30 days, so 365 is something a publisher opts into and can reverse
(§2.5.1, freely mutable). Buyers consent via `encumbranceHash` in every case.

The dashboard must state the trade in plain words, because it is counterintuitive: **longer rental
terms mean fewer takes, which means less take revenue.** The publisher is trading spread income for
rent income and should be told so rather than discovering it.

**Custody drift.** The full-custody option (§10.5) is materially easier to build at every single
step, and it destroys the trust proposition the whole design exists to make. It is the kind of
decision that gets made by accident, one convenience at a time, rather than on purpose.

---

## 9. Parameter decisions — all closed 2026-08-18

Every parameter that gated the audit is now settled. Kept as a record of what was asked and where
the answer lives, because each was reopened at least once and the reasoning matters more than the
number.

| | question |
|---|---|
| ~~1~~ | ~~Rent split and fee band~~ — **RESOLVED 2026-08-18, see §2.5.** `protocolRentBps` 500; band 1000–4000; `siteRentBps` freely mutable and snapshotted per listing. |
| ~~2~~ | ~~`MAX_RENTAL_TERM_CEILING`~~ — **RESOLVED 2026-08-18: 365 days**, see §2.5.4. |
| ~~3~~ | ~~Ask: markup or down-only~~ — **RESOLVED 2026-08-18, see §3.3.** Question dissolves: `maxAskBps` is per-site, `10_000` = down-only. Default 40_000, clamped ≥ 10_000. |
| ~~4~~ | ~~ERC-4907 `setUser`~~ — **RESOLVED 2026-08-18, see §4.** Declare the interface; `setUser` reverts; maps to rentals only. |
| ~~5~~ | ~~`MIN_FLOOR` clamp for 6-decimal tokens~~ — **RESOLVED 2026-08-18, see §11.2.** Needed, and it must be per-site or decimals-derived, never an implementation constant. |
| ~~6~~ | ~~Stablecoin availability + `permit` on RH Chain~~ — **RESOLVED 2026-08-18, see §1.5.** USDG only; `permit` works; no rebase; issuer can freeze/wipe/pause. |
| ~~7~~ | ~~Per-profile defaults~~ — **RESOLVED 2026-08-18, see §6.4.** Four profiles + advanced; Standard (1.4× / 0.97wk / 52wk) is the default. |
| ~~8~~ | ~~Custody default~~ — **RESOLVED 2026-08-18, see §10.5.** Delegated, with a day-one export path. |

---

**Nothing on this list is open.** The two things still genuinely undecided are outside it: whether
the runtime fits under 24,576 bytes (§8, and step 1 of the build order exists to find out), and the
per-slot floor ladder each publisher picks at issue, which is theirs and not ours.

---

## 10. The managed path — a publisher who never sees a token

The target publisher is not crypto-native. They must be able to think in **dollars**, set a floor of
`$0.50`, watch `$47.20` accrue, and have it land in their bank — without ever meeting the word
"USDG". This section records how far that abstraction goes, what it costs, and precisely where it
leaks.

The headline result: **almost none of it is a contract problem.** It separates into three layers
that abstract very differently.

### 10.1 Display — fully abstractable, zero contract work

The contract stores raw integer units. USDG is 1:1 USD-backed and 6-decimal, so the dashboard
divides by 10⁶ and prints dollars. Floors are entered in dollars, revenue is shown in dollars, the
token symbol never has to appear in the publisher UI. A formatting concern, nothing more.

### 10.2 Settlement — not abstractable, and deliberately so

One token per site stays (§1.1). The swap happens at the **edge, never in the contract**: a buyer
pays by card, USDC or ETH → checkout swaps → the contract receives the site's single token. Every
pricing invariant holds because the contract only ever sees one denomination.

Two rejected alternatives, recorded so they are not re-proposed:

- **Multi-token inside the contract.** `lastPrice` / `basePrice` are single `uint256` values;
  comparing two denominations needs an oracle, which reintroduces the external price feed this
  design exists without.
- **A basket-backed "USD" wrapper.** That is issuing a stablecoin — a regulated product and a
  different company.

### 10.3 Payout — the part that decides whether this feels like AdSense

**The primitive already exists.** `withdrawFor(address)` is permissionless and always pays the
address that is **owed**, never the caller. It was written to stop funds being stranded by owners
who never return; it happens to be exactly what a managed payout needs:

1. The site accrues to `pendingWithdrawals[publisherAccount]`.
2. The dashboard shows "$47.20 available".
3. The publisher taps *cash out* → our relayer calls `withdrawFor(...)` and pays the gas.
4. An offramp pulls from their account → ACH to their bank.

The publisher never sees a token symbol, never holds gas, never signs a transaction they do not
understand. The buy side is already symmetric: `buyFor(recipient, …)` separates payer from owner, so
card → checkout → position needs no contract change, and `createSiteFor` means they own their site
having signed nothing.

Three decisions taken for unrelated reasons — stranded funds, sponsored buys, sponsored onboarding —
compose into exactly the non-crypto path. That is v1 §7.12's standing check paying off.

### 10.4 `sweepTreasury()` — the one contract change this requires

There is an inconsistency that bites precisely this audience. Position-holder payouts are
permissionless (`withdrawFor`), but **publisher revenue is not**: `withdrawTreasury(uint256)` is
`onlyOwner`. For a product whose central pitch is publisher revenue, that is backwards — the
publisher must personally sign every payout.

`withdrawTreasury` already always pays `treasury` and never the caller, so making the path
permissionless **grants no new authority**. Identical reasoning to `withdrawFor`.

```solidity
/// @notice Permissionless. Sweeps the full treasury balance to `treasury` — never to the caller.
/// Full-sweep rather than a caller-chosen amount so nobody can grief with dust transfers.
function sweepTreasury() external nonReentrant;
```

`withdrawTreasury(amount)` stays for owners who want partial control. This is the difference between
"log in and click withdraw" and "money arrives every Friday", and it is on-chain, so it lands before
the audit.

### 10.5 Custody — the decision underneath

A spectrum, and a business-shape choice more than an engineering one:

| | publisher friction | what we are |
|---|---|---|
| Self-custody — they hold the site key | high | software |
| **Delegated — they own the site; smart account with recovery; we relay** | low | software |
| Full custody — we own the site, they are a database row | none | a custodian |

**SETTLED 2026-08-18: delegated.** The publisher owns their site and holds it through a
passkey-backed smart account with recovery; we relay and pay gas. `SiteCreated.creator` still
records that we paid for the deploy, so a directory can tell it from a self-made site.

**The export path is part of the deliverable, not a later nice-to-have.** A publisher must be able to
transfer ownership to an address they hold outright, from the dashboard, without asking us. If that
path does not exist from day one, delegated custody is full custody with better branding and nobody
can verify the difference.

The bottom row is tempting and it quietly destroys the trust proposition — the publisher no longer
owns their inventory, we do. Legal is out of scope by explicit decision (`PIVOT-MAP.md`), but noting
that the bottom row is where the money-transmitter question lives, so we should not drift into it by
accident.

### 10.6 Floor ratcheting — the dashboard recommends it — SETTLED 2026-08-18

`effectiveFloor = max(basePrice, reverted lastPrice)`. So everything the market discovers about a
position **evaporates** when trading stops: reversion unwinds the ladder all the way back to
`basePrice`, and the publisher's cut drops back to `0.20 × basePrice` per take. Ratcheting the floor
up while a position is hot converts discovered value into a permanent revenue floor — worth ~2.5× the
long-run take revenue in the worked example in `PIVOT-MAP.md` §Q3a. The lever already exists in
`setFloor`. No publisher would ever find it unaided.

**Level chosen: recommend, with scheduling.** The dashboard computes a target from observed market
price and offers it in one click. Because `setFloor` is capped at ±20% per 24h, capturing a large
move takes ~13 consecutive daily changes — so one click must mean *schedule the ratchet*, not *raise
it once*. Surfacing alone would leave most of the value unclaimed precisely because the manual path
is tedious.

**Not automated by default.** Ratcheting on a publisher's behalf is a lot of authority to assume over
economic parameters, even rate-limited ones. Opt-in automation is a later question.

**Not adversarial to holders**, which is what makes recommending it defensible: raising the floor
raises what a taker pays *and* raises the current holder's payout (`payoutBps × effectiveFloor`).
It costs prospective buyers only, and the ±20%/24h limit is what stops it being used to strand
anyone. Requires no contract change.

### 10.7 Where the abstraction leaks

Recorded because these are what "it's just dollars" cannot cover:

- **They own a contract.** Site ownership is an address. Lose the key, lose the site. A
  passkey-backed smart account with recovery makes this survivable, not absent.
- **A depeg breaks the floor mechanism.** If USDG moves off $1, the publisher's "$0.50" floor and
  their actual 0.5 USDG floor diverge — and the ±20%/24h rate limit means they **cannot chase it**.
  Same argument that ruled out ETH settlement, at much lower probability but identical shape.
- **Currency abstraction is the easy half.** The genuinely novel thing a publisher must understand is
  that *someone can buy their headline and change it, and a stranger can take it from them at a
  formula price*. No amount of dollar-formatting makes that familiar, and it is the real onboarding
  problem.

---

## 11. Adding a chain

Sites are clones with no cross-chain state, so adding a chain is **one implementation deploy plus an
address in the SDK** — the same audited bytecode with a different `settlementToken` in each site's
config. USDG is a per-chain default, **not an architectural commitment**: on Base you would pass
USDC's address and change no code.

What is genuinely frozen is narrower than it looks:

| scope | locked? |
|---|---|
| per site | **yes, permanently** — `settlementToken` has no setter |
| per implementation | **no** — the token is a config field; no token appears in the bytecode |
| per chain | **no** — one deploy plus an SDK address |

Per-site permanence is deliberate: a mutable settlement token would let a publisher switch
denomination under existing holders and orphan every balance in the old one. **The hedge belongs at
the deployment level, where it already is.** Do not make `settlementToken` mutable to buy
flexibility that the deployment layer already provides.

### 11.1 Settlement-token qualification checklist

Produced by the USDG survey (§1.5) and generalised. Any settlement token on any chain must clear all
six before it is configured on a live site:

1. **`balanceOf` does not rebase** — verified **empirically against real holders across a block
   range**, never inferred from the ABI. This was the near-miss on USDG, which carries multiplier and
   rewards facets and reads exactly like a rebasing token while not being one.
2. **Decimals read dynamically** at `initialize()` and in the SDK — never hardcoded. USDG and USDC
   are both 6, which is exactly the coincidence that hides this assumption until a chain with an
   18-decimal stablecoin breaks it.
3. **EIP-2612 `permit`** — or accept the two-transaction approve flow. Check the **facet/proxy
   routing**, not just the base ABI: USDG's `permit` is absent from its implementation ABI and a
   naive read concludes there is none.
4. **`SafeERC20`-compatible** — tolerates non-standard return values (USDT returns no boolean).
5. **Identity confirmed by address, not symbol or holder count.** Both are forgeable. On RH Chain the
   fake `usdg` outranked the real one on holders, and every impersonator answered
   `DOMAIN_SEPARATOR()` and `nonces()`.
6. **Issuer control surface documented and accepted** — freeze, wipe, pause. Circle can blacklist
   too, so this generalises rather than being a USDG quirk, and it is why conservation stays a
   **test-only** invariant (§1.5, Finding 5).

### 11.2 `MIN_FLOOR` cannot be an implementation constant

Resolves open item #5. A `MIN_FLOOR` tuned for 6 decimals is wrong by 10¹² against an 18-decimal
token, and the implementation is frozen. It must be **per-site config, or derived from the token's
own `decimals()` at `initialize()`**. The same rule governs the SDK's floor parsing (§1.4).

### 11.3 What Base would actually cost

Mostly re-verification — §11.1 pointed at a different chain — with **one genuine behaviour change**:

**Seaport is live on Base.** v1 §10.4's stale-listing hazard is dormant today *only* because RH Chain
has no marketplace. On Base it is live on day one: a position listed at 5 ETH stays takeable at its
formula price the same minute. The SDK's re-acquisition warning — checking `isApprovedForAll`
against known marketplace operators — is deferred today and **must ship before a Base launch**. It
is periphery, not bytecode, so it does not reopen the audit.

Also re-verify: USDC's canonical address **by address, not label**; `permit` support; and EIP-7702
availability, which §1.3's approval-batching plan depends on.

---

## 11.4 Splitting the implementation — VERIFIED ON-CHAIN 2026-08-18

§0's "one implementation, audited once" means **one audit**, not one contract. Auditing a set of
contracts is the same audit. The monolith was an unexamined assumption and the size skeleton
disproved it: v2 in one contract is 24,341 B against 24,576 — a 235 B margin, which is not a fit.

### What actually constrains the split

Narrower than it looks:

- The **clone** must stay canonical EIP-1167 bytecode — that is what gives every site a readable
  page. Says nothing about whether the *implementation* is monolithic.
- The ERC-721 needs one stable address, because that is what wallets and marketplaces index.
- Funds stay per-site, so the site is the custodian.
- Rental logic reads and writes slot state and the pull ledger, so it wants `delegatecall`, not
  cross-contract calls.

### The architecture — BUILT AND MEASURED 2026-08-18

| | frozen? | runtime | role |
|---|---|---|---|
| **`SlotSite`** — clone target | yes | **21,444 B, 3,132 margin (12.7%)** | ERC-721, slot state, buy/edit, funds, pull ledger. Sole custodian. |
| **`RentalsLib`** — external library | yes | 2,453 B at its own address | Tenancy state machine, delegatecalled. **Never touches money.** |
| **`TermsLib`** — `internal` | n/a | inlined | Tiered-mutability policy. Code organization, not a deployment. |
| **`SlotReader`** — periphery | **no** | 6,303 B | `readTerms`, enriched `readSlots`, `readSlotsMulti`. Redeployable. |

From 235 B of margin to **3,132**. Not the 18% projected — see below.

**`RentalsLib` never touches money, and that is the load-bearing rule of the split.** It validates,
mutates tenancy state, and *returns* the amounts the site must book. Every credit, debit, escrow
adjustment and transfer stays in `SlotSite`. A delegatecalled library that could move funds would
widen the audit surface for nothing; one that only computes cannot.

**`SlotReader` is the part that matters more than the bytes.** It is an ordinary redeployable
deployment, so §2.4.2's net-cost surfacing and any future demand-side view can change without
touching frozen bytecode — this spec's own §1.3 rule, finally applied to the views. It also batches
across **multiple sites** in one call (`readSlotsMulti`), which a monolithic on-site `getSlots` cannot
do at all, and which is what the directory needs.

### What the measurement corrected — twice

Two size projections in this document were wrong, both for the same reason, and the rule is worth
keeping:

> **Extraction saves `moved_bytes − stub_cost`, and stub cost scales with call-site count TIMES
> argument size.**

- First cut of `RentalsLib` moved 2,977 B of logic out across **twelve** `public` call sites and
  saved **473 B net**. Fixed by coarsening: only the four large validators stay `public`; the small
  helpers (`accrued`, `unaccrued`, `currentTenant`, `claim`) are `internal` and inline, and the site
  writes its own storage rather than paying a delegatecall to have the library write one field. Four
  call sites, ~974 B saved.
- `TermsLib` as an external library saved only **83 B** more than inlining it, because its functions
  take two five-field structs and encoding those across the boundary costs about what the logic saved.
  Kept `internal`: 83 bytes does not justify another deployment, link reference and audit surface.
  Its real justification is deduplication — `initialize` and the setters now share one definition of a
  legal configuration.

**12.7% is workable, not comfortable.** If audit feedback needs more room, the measured next levers
are `setEditorWithSig` + its EIP-712 machinery (884 B, few call sites, small args — a good candidate)
and grouping economics into a storage struct so `TermsLib` could take one storage pointer instead of
two memory structs.

### Verified, not assumed

`test/architecture/LibraryStorage.t.sol` proves a delegatecalled library can mutate the host's
mapping-of-struct storage and pull ledger, that `msg.sender` inside it is the **original caller** (so
tenant attribution is correct), and that its **events are attributed to the host's address** (so
indexers see them on the site).

Then the question that actually gated the architecture — *does a library-linked implementation still
give every clone a readable page?* — was settled by deploying it on testnet 46630:

| | address |
|---|---|
| `ProbeLib` | `0x8D07470265F04e273F7D125b6B4e29ce1aF7b085` |
| `ProbeImpl` (linked) | `0x539db9f6964912A86e2f71c7f351529480Ff564e` |
| `ProbeFactory` | `0x06AE71346BC1BA89527016d130b56641cd79334D` |
| clone | `0x1f85b30d88a499f767c1f5f69952f772b30e76e7` |

Results. The clone's runtime is the canonical 45-byte EIP-1167 pattern; `bump()` works end to end
through clone → implementation → linked library. Blockscout reports the implementation
**`is_fully_verified: true`** (not partially) with `external_libraries` correctly recording the
library address, and the clone auto-detects as **`proxy_type: eip1167`** resolving to it.

Against the v1 demo-site clone as a control, the clone's reported shape is **identical** —
`proxy_type: eip1167`, `implementations` resolving, `abi: 0` on the clone itself, which is simply how
Blockscout models a proxy rather than a defect. **Library linking costs nothing in the verification
story.**

The probe sources were deleted after the run; the deployments remain on testnet as evidence.

### Two costs this introduces

1. **A deploy-time failure mode.** The library address is linked into the implementation's bytecode.
   A wrong address means arbitrary behaviour with no revert. The deploy script must assert the
   library's **codehash**, not just that an address is present.
2. **The SDK's read path moves.** `readSiteTerms` targets the reader rather than the site. "A whole
   page is one RPC call" still holds — it is just a different address.

---

## 12. Build order

0. **Repo setup.** `git init` here; carry the four packages across from `../Website`;
   `forge install` the Foundry deps and drop `libs = ["../contracts/lib"]`; vendor a **pinned** copy
   of v1's frozen `Pricing.sol` as the parity reference (more frozen, not less — that is the
   point of a reference); fresh `CLAUDE.md`; delete the stray
   `packages/websitekit-sdk/packages/slotkit-react/`. Generate **fresh testnet keys** — today's are
   shared with v1's, and v1's testnet deployer *is* a board owner.
1. ~~**Size skeleton.**~~ **DONE 2026-08-18.** One contract is 24,341 B — a 235 B margin, not a
   fit. `via_ir` is not the escape hatch (see `foundry.toml`). **Split the implementation** per
   §11.4: `SlotSite` + `RentalsLib` + `SlotReader`, projecting ~18% margin. Blockscout verification
   of a library-linked implementation is verified on-chain.
2. **Token settlement**, plus **`sweepTreasury()`** (§10.4) and the `MIN_FLOOR` clamp (§11.2). The
   money spine first, because everything else settles through it.
3. **Rentals.** The largest piece. Port from `TinawSlotsV2.sol`, not the sketch (§2.6).
4. **The ask.** Small, and deliberately after rentals so the composition is tested against a
   finished mechanism rather than a moving one.
5. **ERC-4907 + `encumbranceHash` extension.** Both are thin once §3 and §2 exist.
6. ~~**Test layers**, growing all four (§7).~~ **Contract layer DONE 2026-08-18: 231 tests pass**
   (v1's 126 + 100 v2 + 5 architecture). Every money assertion runs twice, native and 6-decimal
   ERC-20, because the token branch touches every money path. **Still outstanding:** new parity
   vectors for `resolveReversionBase` and rent accrual, the v2 invariant suite (including config
   *combinations* — see §8), and the anvil e2e once the SDK is updated.
7. **Redeploy the reference boards** on testnet. All five existing boards are superseded by a new
   implementation — migrate nothing, redeploy from the seeders, which already emit the right domain.
8. **Audit.** Calendar, not effort. Nothing on-chain changes after this.

Everything off-chain — loader, dashboard, checkout, directory, hosted content tier — parallelizes
freely from step 2 onward and does not gate the audit. That includes the whole managed path in §10
beyond `sweepTreasury`: dollar-denominated UI, embedded smart accounts with recovery, the offramp
integration, and the edge swap. The SDK's marketplace re-acquisition warning (§11.3) is also
periphery, and is only urgent if a chain with a live marketplace is targeted.
