import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { foundry } from 'viem/chains';
import { ContentKind } from './content';
import { DEFAULT_CONTENT_GATEWAY, InvalidSiteConfigError, defineSite, slotFloors } from './config';

const READER = '0x2222222222222222222222222222222222222222' as const;

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;

const base = {
  address: ADDRESS,
  reader: READER,
  chain: foundry,
  slots: {
    'hero.headline': { kind: 'text' as const, floor: '0.002' },
    'hero.image': { kind: 'image' as const, floor: '0.01' },
    'nav.link.1': { kind: 'link' as const, floor: '0.005' },
  },
};

describe('defineSite', () => {
  it('parses floors as ether strings into wei', () => {
    const config = defineSite(base);
    expect(config.slotsByKey['hero.headline']!.floor).toBe(parseEther('0.002'));
    expect(config.slotsByKey['hero.image']!.floor).toBe(parseEther('0.01'));
  });

  /**
   * The floor is the one number a builder types by hand. A string keeps `0.002` out of a JS float,
   * which is the class of money bug the rest of this codebase refuses to have.
   */
  it('never routes a floor through a JS number', () => {
    const config = defineSite({ ...base, slots: { 'a.b': { kind: 'text', floor: '0.1' } } });
    expect(config.slotsByKey['a.b']!.floor).toBe(100_000_000_000_000_000n);
  });

  /**
   * **The 1e12 bug, pinned.** §11.2: `minFloor` is derived from the settlement token's decimals, so
   * a floor parsed against 18 on a 6-decimal USDG site is not a rounding error — it is twelve orders
   * of magnitude above anything anyone will pay, on a contract whose floors then move at most ±20%
   * per day. `parseEther` is silently correct on a native site, which is exactly what makes it
   * dangerous: the bug does not appear until the first token-settled deploy.
   */
  it('parses floors against the settlement token decimals, not always 18', () => {
    const native = defineSite(base);
    expect(native.decimals).toBe(18);
    expect(native.slotsByKey['hero.image']!.floor).toBe(10_000_000_000_000_000n);

    const usdg = defineSite({ ...base, decimals: 6 });
    expect(usdg.decimals).toBe(6);
    expect(usdg.slotsByKey['hero.image']!.floor).toBe(10_000n);

    // The whole point, stated as a ratio so a regression reads as the number it actually is.
    expect(native.slotsByKey['hero.image']!.floor / usdg.slotsByKey['hero.image']!.floor).toBe(
      1_000_000_000_000n,
    );
  });

  it('rejects nonsense decimals rather than silently parsing against them', () => {
    expect(() => defineSite({ ...base, decimals: -1 })).toThrow(InvalidSiteConfigError);
    expect(() => defineSite({ ...base, decimals: 6.5 })).toThrow(InvalidSiteConfigError);
  });

  /** Every v2 read goes through `SlotReader`, so a config without one cannot render anything. */
  it('requires a reader address', () => {
    expect(() => defineSite({ ...base, reader: 'not-an-address' as never })).toThrow(InvalidSiteConfigError);
    expect(defineSite(base).ref).toEqual({ site: ADDRESS, reader: READER });
  });

  it('maps kind names to the wire kind ids', () => {
    const config = defineSite(base);
    expect(config.slotsByKey['hero.headline']!.contentKind).toBe(ContentKind.Text);
    expect(config.slotsByKey['hero.image']!.contentKind).toBe(ContentKind.Image);
    expect(config.slotsByKey['nav.link.1']!.contentKind).toBe(ContentKind.Link);
  });

  /** A board should read in the order it was written, not in hash order or alphabetically. */
  it('preserves config order', () => {
    expect(defineSite(base).keys).toEqual(['hero.headline', 'hero.image', 'nav.link.1']);
  });

  it('defaults the content gateway and honours an override', () => {
    expect(defineSite(base).contentUrl).toBe(DEFAULT_CONTENT_GATEWAY);
    const custom = defineSite({ ...base, contentUrl: (cid) => `https://mine/${cid}` });
    expect(custom.contentUrl('abc')).toBe('https://mine/abc');
  });

  it('produces the floor map the tx builders take', () => {
    expect(slotFloors(defineSite(base))).toEqual({
      'hero.headline': parseEther('0.002'),
      'hero.image': parseEther('0.01'),
      'nav.link.1': parseEther('0.005'),
    });
  });
});

describe('config validation fails at import time, not at render time', () => {
  /**
   * A typo'd key is a permanent on-chain identity pointing at nothing. It should stop a build, not
   * produce a slot that quietly never resolves on a page nobody checked.
   */
  it('rejects an invalid slot key', () => {
    expect(() => defineSite({ ...base, slots: { 'Hero.Headline': { kind: 'text', floor: '1' } } })).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      defineSite({ ...base, slots: { 'a.b': { kind: 'audio' as 'text', floor: '1' } } }),
    ).toThrow(InvalidSiteConfigError);
  });

  it('rejects a floor that is not a decimal amount', () => {
    expect(() => defineSite({ ...base, slots: { 'a.b': { kind: 'text', floor: 'free' } } })).toThrow(
      InvalidSiteConfigError,
    );
  });

  it('rejects a zero floor, which is free to claim and free to hold', () => {
    expect(() => defineSite({ ...base, slots: { 'a.b': { kind: 'text', floor: '0' } } })).toThrow(
      InvalidSiteConfigError,
    );
  });

  it('rejects a malformed address', () => {
    expect(() => defineSite({ ...base, address: '0xnope' as typeof ADDRESS })).toThrow(InvalidSiteConfigError);
  });

  it('rejects a site with no slots, which has nothing to own', () => {
    expect(() => defineSite({ ...base, slots: {} })).toThrow(InvalidSiteConfigError);
  });
});
