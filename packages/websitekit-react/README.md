# `@websitekit/react`

React bindings for [websitekit](https://websitekit.org) — render a page whose regions are
individually owned, priced and tradeable on chain.

```bash
npm install @websitekit/react @websitekit/sdk viem react
```

## Rendering a board

```tsx
import { SlotProvider, Slot } from '@websitekit/react';

<SlotProvider config={config} client={client} initialSlots={slots}>
  <h1><Slot id="hero.headline" fallback="Ship faster" /></h1>
  <Slot id="hero.image" as="img" fallback="/hero.png" />
</SlotProvider>
```

A slot with no owner, or no content written, renders its `fallback` — which is the honest state for
a region nobody has bought, not an error. Content is fetched by hash and **verified before it
renders**, so a hostile gateway can cause a blank slot but never a substituted one.

## Buying

`useBuy` returns a quote and builds the transaction from it; `<BuyDialog>` is a thin, unstyled
default over that hook. Both surface the numbers the chain will actually charge, including the net
cost of an encumbered position — a slot under a live tenancy is cheaper than its price by the rent
you inherit with it.

```tsx
const { phase, quote, prepare, buildRequest, buildApproval } = useBuy('hero.headline');
```

Amounts are in the board's own currency — `quote.currency` is read from its settlement token, so a
USDG board shows dollars and a native board shows ETH. On a token board the purchase needs an ERC-20
approval sent first: `buildApproval(request)` returns it (or `null` on a native board), and
`<BuyDialog>` passes it to `onConfirm` as the third argument.

Every export here is a client component or hook.

## Status

Live on Robinhood Chain mainnet and its testnet. Unaudited, experimental.

MIT © websitekit
