/**
 * `<Slot>`'s contract, in one sentence: **content renders only when it has been verified against
 * the on-chain hash, and everything else paints `fallback`.**
 *
 * Most of this file is that second clause. The fallback path is not an error branch — it is the
 * normal state of most slots on most pages, and it is what makes a site look finished on day one.
 * Every route into it is tested separately, because a route that silently paints an empty box
 * instead looks like a styling bug and gets diagnosed as one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { sha256, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import {
  ContentKind,
  SCHEME_VERSION,
  defineSite,
  encodeText,
  slotKey,
  type SlotState,
} from '@websitekit/sdk';

import { SlotProvider } from './context';
import { Slot } from './Slot';

const SITE = '0x1111111111111111111111111111111111111111' as const;

const READER = '0x2222222222222222222222222222222222222222' as const;

const config = defineSite({
  address: SITE,
  reader: READER,
  chain: foundry,
  slots: {
    'hero.headline': { kind: 'text', floor: '0.01' },
    'nav.link.1': { kind: 'link', floor: '0.005' },
    'hero.image': { kind: 'image', floor: '0.05' },
  },
  contentUrl: (cid) => `https://gateway.test/${cid}`,
});

function slotState(key: string, overrides: Partial<SlotState> = {}): SlotState {
  return {
    key,
    keyHash: slotKey(key),
    owner: null,
    contentHash: null,
    floor: 10n,
    effectiveFloor: 10n,
    lastPrice: 0n,
    askFloor: 0n,
    lastPurchaseTs: 0n,
    version: 0,
    takes: 0,
    registered: true,
    isAvailable: true,
    isUnclaimed: true,
    charged: 10n,
    tenant: null,
    rentalExpiry: 0n,
    unaccruedRent: 0n,
    netCost: 10n,
    isFreeCarry: false,
    isRented: false,
    ratePerDay: 0n,
    maxDurationSecs: 0n,
    isListed: false,
    ...overrides,
  };
}

/** The provider only ever calls `readContract`; nothing here needs a real chain. */
const client = { readContract: vi.fn() } as unknown as PublicClient;

function renderWith(slots: SlotState[], children: React.ReactNode) {
  return render(
    <SlotProvider config={config} client={client} initialSlots={slots}>
      {children}
    </SlotProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respondWith(bytes: Uint8Array) {
  fetchMock.mockResolvedValue({
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

describe('the fallback, which is most of the page most of the time', () => {
  it('renders for an unclaimed slot', () => {
    renderWith([slotState('hero.headline')], <Slot id="hero.headline" as="h1" fallback="Ship faster." />);
    expect(screen.getByRole('heading')).toHaveTextContent('Ship faster.');
  });

  it('renders for a slot that is owned but has never been edited', () => {
    renderWith(
      [slotState('hero.headline', { owner: SITE, isUnclaimed: false, contentHash: null })],
      <Slot id="hero.headline" fallback="Ship faster." />,
    );
    expect(screen.getByText('Ship faster.')).toBeDefined();
  });

  /**
   * §3's second honest caveat: the chain will say a slot is owned and priced while its content
   * 404s. v1 never had this failure mode because Postgres and R2 were the same system as the
   * renderer; the framework introduces it, and this is the only thing standing between it and a
   * blank page.
   */
  it('renders when the gateway is down', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const content = encodeText('Real content');

    renderWith(
      [slotState('hero.headline', { contentHash: content.hash })],
      <Slot id="hero.headline" fallback="Ship faster." />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('Ship faster.')).toBeDefined();
  });

  it('renders when the gateway throws outright', async () => {
    fetchMock.mockRejectedValue(new Error('DNS is having a day'));
    const content = encodeText('Real content');

    renderWith(
      [slotState('hero.headline', { contentHash: content.hash })],
      <Slot id="hero.headline" fallback="Ship faster." />,
    );

    await waitFor(() => expect(screen.getByText('Ship faster.')).toBeDefined());
  });

  /**
   * **The one that matters.** A gateway serving different bytes than the hash commits to is
   * indistinguishable from an attacker substituting content, and the substituted text must never
   * reach the DOM — not briefly, not behind a warning.
   */
  it('renders when the bytes do not match the on-chain hash, and never paints the substitute', async () => {
    const committed = encodeText('Ship faster.');
    respondWith(encodeText('Buy my coin.').bytes);

    renderWith(
      [slotState('hero.headline', { contentHash: committed.hash })],
      <Slot id="hero.headline" fallback="Ship faster." />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText('Buy my coin.')).toBeNull();
    expect(screen.getByText('Ship faster.')).toBeDefined();
  });

  /**
   * A slot written under a newer scheme. Without the version byte in the object this is a silent
   * blank; with it, the page still looks finished and the console says why.
   */
  it('renders for content written under an unknown scheme version', async () => {
    const future = Uint8Array.from([SCHEME_VERSION + 1, ContentKind.Text, 65, 66]);
    respondWith(future);

    renderWith(
      [slotState('hero.headline', { contentHash: sha256(future) })],
      <Slot id="hero.headline" fallback="Ship faster." />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('Ship faster.')).toBeDefined();
  });
});

describe('rendering verified content', () => {
  it('renders text into the requested element', async () => {
    const content = encodeText('Owned and edited.');
    respondWith(content.bytes);

    renderWith(
      [slotState('hero.headline', { contentHash: content.hash })],
      <Slot id="hero.headline" as="h1" className="text-6xl" fallback="Ship faster." />,
    );

    await waitFor(() => expect(screen.getByRole('heading')).toHaveTextContent('Owned and edited.'));
    expect(screen.getByRole('heading').className).toBe('text-6xl');
  });

  it('renders a link from its JSON payload', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ href: 'https://example.com', label: 'Pricing' }));
    const object = Uint8Array.from([SCHEME_VERSION, ContentKind.Link, ...payload]);
    respondWith(object);

    renderWith(
      [slotState('nav.link.1', { contentHash: sha256(object) })],
      <Slot id="nav.link.1" fallback="Docs" />,
    );

    await waitFor(() => expect(screen.getByRole('link')).toHaveTextContent('Pricing'));
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com');
  });

  /** A link with no destination is a dead element that looks deliberate. Fall back instead. */
  it('falls back for a link whose payload does not parse', async () => {
    const object = Uint8Array.from([SCHEME_VERSION, ContentKind.Link, 123, 125, 125]);
    respondWith(object);

    renderWith(
      [slotState('nav.link.1', { contentHash: sha256(object) })],
      <Slot id="nav.link.1" fallback="Docs" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('Docs')).toBeDefined();
  });

  /**
   * **Media never renders from a gateway URL.** `<img src={gatewayUrl}>` would let the browser
   * fetch and paint bytes nobody checked. The `src` here must be a blob of already-verified bytes,
   * and asserting the scheme is how that stays true.
   */
  it('renders an image from verified bytes, not from the gateway URL', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const object = Uint8Array.from([SCHEME_VERSION, ContentKind.Image, ...png]);
    respondWith(object);

    renderWith(
      [slotState('hero.image', { contentHash: sha256(object) })],
      <Slot id="hero.image" fallback="/placeholder.png" />,
    );

    const img = await waitFor(() => {
      const found = document.querySelector('img');
      expect(found?.getAttribute('src')).toMatch(/^blob:/);
      return found!;
    });
    expect(img.getAttribute('src')).not.toContain('gateway.test');
  });

  it('uses a string fallback as the image src until content verifies', () => {
    renderWith([slotState('hero.image')], <Slot id="hero.image" fallback="/placeholder.png" />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/placeholder.png');
  });
});

describe('ergonomics', () => {
  it('does not leak the slot key into the DOM id namespace', () => {
    renderWith([slotState('hero.headline')], <Slot id="hero.headline" as="h1" fallback="x" />);
    expect(screen.getByRole('heading').getAttribute('id')).toBeNull();
  });

  /**
   * A key absent from the config is a typo, and a typo is a permanent on-chain identity pointing at
   * nothing. Failing loudly beats rendering `fallback` forever on a slot the owner believes they
   * bought — which is what a lenient lookup would produce, indistinguishable from an unclaimed slot.
   */
  it('throws a useful error for a key that is not in the config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderWith([], <Slot id="footer.cta" fallback="x" />)).toThrow(/not in the site config/);
    spy.mockRestore();
  });

  it('throws when used outside a provider, rather than rendering nothing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Slot id="hero.headline" fallback="x" />)).toThrow(/no <SlotProvider>/);
    spy.mockRestore();
  });

  it('hands the raw state to a render-prop child', () => {
    renderWith(
      [slotState('hero.headline', { charged: 1234n })],
      <Slot id="hero.headline">{(slot) => <span>price {String(slot.state?.charged)}</span>}</Slot>,
    );
    expect(screen.getByText('price 1234')).toBeDefined();
  });

  /**
   * §3 makes identical content across slots one stored object. The store dedups in-flight requests
   * by hash so that becomes one fetch, not one per slot.
   */
  it('fetches shared content once for slots that hold it', async () => {
    const content = encodeText('Shared');
    respondWith(content.bytes);

    renderWith(
      [
        slotState('hero.headline', { contentHash: content.hash }),
        slotState('nav.link.1', { contentHash: content.hash }),
      ],
      <>
        <Slot id="hero.headline" fallback="a" />
        <Slot id="nav.link.1" fallback="b" />
      </>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
