# A site where every element is separately owned

This is an ordinary-looking product page. Every visible part of it — the logo, each nav link, the
headline, the hero image, each feature — is a slot someone can buy, edit, and be paid for when
somebody takes it from them.

```
pnpm install
pnpm dev
```

That works with no credentials and no wallet. The page reads its board from the chain and renders.

## The mechanic, in four lines

- An unclaimed slot costs its **floor**.
- Taking one from its current owner costs **1.4×** the effective floor.
- The displaced owner is paid **1.15× the effective floor** — always at least the floor itself.
- A slot nobody has touched **reverts** toward its floor, 3% a week, so a stale slot gets cheaper.

The effective floor is what the holder paid, reverted by the weeks since — never below the floor.
So the payout is 1.15× the *current* effective floor, not 1.15× what you paid: taken in the first
week you get 1.15× back; after five weeks of reversion it is ~0.99×, a little under what you paid.
The guarantee that survives every case is that a displaced owner gets at least the floor. Holding
has a carrying cost — that is what stops one buyer parking on the good real estate forever.

These are the numbers in `scripts/deploy.ts`. Your board can use different ones.

## Which network, and what it costs

This project runs against **Robinhood Chain mainnet** by default. Prices are in **USDG**, a real
dollar stablecoin, and every purchase is real money. Set `NEXT_PUBLIC_WEBSITEKIT_CHAIN_ID=46630` in
`.env` to use the testnet instead, where boards settle in **tUSD**, a stand-in dollar anybody can
mint for free. Floors in `websitekit.config.ts` are written in dollars and mean the same on both.

Buying on a USDG board takes two wallet prompts: an approval letting the board spend up to the
quoted price (plus a small margin), then the purchase. `<BuyDialog>` says so and hands your code
both requests in order.

## Why the page is full of copy nobody wrote

Every `<Slot>` has a `fallback`. It renders whenever there is no verified content — which on day one
is almost every slot. That is deliberate: an empty grid teaches nobody anything, and the page has to
be genuinely mistakable for a real product before the joke lands.

`fallback` is also the failure mode for everything else. Gateway down, bytes that don't match the
on-chain hash, content written by a newer SDK than yours — all of it falls back. A site whose
storage has gone entirely dark still looks finished.

## Editing the board

`websitekit.config.ts` is the whole surface. A slot key is a permanent on-chain identity —
`keccak256("hero.headline")` is the ERC-721 token id, forever. Renaming a key doesn't rename a slot;
it points at a different, unregistered one and orphans whatever the old key holds. Add and retire
keys freely before you deploy, and treat them as frozen afterwards.

## Deploying your own site

```
cp .env.example .env    # a key with enough ETH for gas; on mainnet, real ETH
pnpm deploy:site        # one transaction
```

Read `scripts/deploy.ts` before running it. It is short and it decides things you cannot fully take
back:

- **The settlement token is frozen.** USDG on mainnet, tUSD on testnet. There is no setter — changing
  it would orphan every balance on the board.
- **The take economics are nearly one-way.** `takeBps`, `payoutBps`, `reversionBps`,
  `maxReversionWeeks` and `cooldownSecs` can be edited freely until the first slot is claimed. After
  that they may only move in the direction that cannot strand a holder: takes cheaper, payouts
  higher, reversion slower, cooldowns shorter.
- **Rental terms stay editable both ways**, because rent binds nobody: an owner who dislikes a rate
  simply does not list.

What you can always change: the treasury, the pause switch, metadata, which slots are registered,
and each slot's floor (±20% per change, a day apart).

## Things worth knowing before you launch

- **Slots are closed by default.** Nobody can buy a key you haven't registered. Without that, anyone
  reading your repo could buy `hero.headline` at floor before you launch.
- **Writes need somewhere to put bytes.** Reads are backend-free; the render path needs no server.
  Storing content does — a pinning gateway, your own R2 bucket, or a hosted tier. A hash on-chain
  whose bytes were never uploaded is a permanently blank slot.
- **Slots are ERC-721 and marketplace-listable.** A slot sold on a marketplace is still takeable at
  its on-chain price the same minute. That spread is arbitrageable, and the arb is the mechanic
  working as designed.
- **The mechanic needs contested attention.** Twelve slots on a site with a few hundred visitors sit
  at floor forever, and a market with no takes reads as broken rather than as calm.
