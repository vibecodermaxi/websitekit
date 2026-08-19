# `create-websitekit`

Scaffold a [websitekit](https://websitekit.org) project: an ordinary-looking page whose regions are
individually owned, priced and tradeable on chain.

```bash
npm create websitekit my-site
cd my-site
pnpm install
pnpm dev
```

**No credentials needed for the first run.** With an empty `.env` the page renders a shared demo
board on Robinhood Chain testnet — already claimed across two owners, with slots left open, one
taken twice and one under a live tenancy. An empty board teaches nothing about the mechanic, so the
one you start with is not empty.

## What you get

A Next.js app where every ownable region is a `<Slot>`:

```tsx
<h1><Slot id="hero.headline" fallback="Ship faster" /></h1>
```

`websitekit.config.ts` is the file you edit — the slots, their floors, and where content bytes come
from. `scripts/deploy.ts` ships as readable source inside your project rather than behind a binary,
because deploying a site is a single `createSite` call and the one transaction that matters should
not be the one thing you cannot inspect.

```bash
pnpm deploy:site   # needs a funded testnet key in .env
```

## Two things to know before you deploy

- **Slot keys are permanent.** `keccak256("hero.headline")` is the ERC-721 token id, forever.
  Renaming a key does not rename a slot — it points at a different, unregistered one. Add and retire
  keys freely before you deploy; treat them as frozen afterwards.
- **Some economics are one-way.** Take economics are freely editable until the first position is
  claimed, then ratchet only in the direction that cannot strand a holder. Rent terms stay mutable.
  `deploy.ts` documents which is which at the point you choose them.

Testnet only, unaudited, experimental.

MIT © Puranjay Singh
