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
- A slot nobody has touched **decays** back toward its floor, ~10% a week, so a stale slot gets
  cheap again.

The payout is 1.15× the *current* floor, not 1.15× what you paid. Taken within a week you profit
(~1.035×); after two weeks of decay you are down (~0.93×). A claimer at the floor is always made
whole; a taker who paid above the floor and then held can end up underwater. Holding has a carrying
cost — that is what stops one buyer parking on the good real estate forever.

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
cp .env.example .env    # a funded testnet key + the factory address
pnpm deploy:site        # one transaction
```

Read `scripts/deploy.ts` before running it. It is thirty lines and it decides things you cannot
change afterwards:

**`takeBps`, `payoutBps`, `decayBps`, `maxDecayWeeks` and `cooldownSecs` are written once and have
no setter.** That is the deal websitekit offers a buyer — they read the terms once and know the terms
cannot move — and it means those numbers are a decision, not a default to revisit. Getting them
wrong means cloning a fresh site and abandoning whoever bought into the old one.

What you *can* still change: the treasury, the pause switch, metadata, which slots are registered,
and each slot's floor (±20% per change, 24h apart).

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
