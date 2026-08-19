import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { InvalidSlotKeyError, MAX_KEY_LENGTH, slotKey, slotKeys, slotTokenId } from './keys';

describe('slotKey', () => {
  it('is keccak256 of the UTF-8 key, which is what the contract stores', () => {
    expect(slotKey('hero.headline')).toBe(keccak256(toBytes('hero.headline')));
  });

  it('derives the ERC-721 token id as uint256 of the key hash', () => {
    expect(slotTokenId('hero.headline')).toBe(BigInt(slotKey('hero.headline')));
  });

  /**
   * Pinned against `cast keccak`, not against this module's own output — the first line of this
   * suite compares `slotKey` to viem's `keccak256`, which would agree with itself even if both were
   * hashing the wrong bytes. These are permanent on-chain identities: a slot bought under one hash
   * is a different slot under another, and no migration recovers it.
   *
   *   $ cast keccak 'hero.headline'
   *   $ cast keccak 'nav.link.1'
   */
  it('is stable — these hashes are on-chain identities and can never change', () => {
    expect(slotKey('hero.headline')).toBe(
      '0x61d0c3ee2ccc3471cff62277f9033832f6a22c34045652de639c758572564dab',
    );
    expect(slotKey('nav.link.1')).toBe(
      '0x4825b086763d7d11829ecedc6744b49b81d3170e5f54fb6481f6180554aa10c1',
    );
  });
});

describe('key validation', () => {
  /**
   * The contract takes any `bytes32` and cannot enforce this. It is enforced here so two developers
   * describing the same region of a page arrive at the same string — and, more importantly, so a
   * key never carries whitespace or casing that hashes to a DIFFERENT slot while looking identical
   * in a config file and in a screenshot.
   */
  it.each([
    ['Hero.Headline', 'uppercase'],
    ['hero.headline ', 'trailing space'],
    [' hero.headline', 'leading space'],
    ['hero..headline', 'empty segment'],
    ['.hero', 'leading separator'],
    ['hero.', 'trailing separator'],
    ['hero headline', 'inner space'],
    ['hero/headline', 'unsupported separator'],
    ['héro.headline', 'non-ascii'],
    ['', 'empty'],
  ])('rejects %j (%s)', (key) => {
    expect(() => slotKey(key)).toThrow(InvalidSlotKeyError);
  });

  it.each(['hero', 'hero.headline', 'nav.link.1', 'footer.cta-primary', 'section.2.body_text'])(
    'accepts %j',
    (key) => {
      expect(() => slotKey(key)).not.toThrow();
    },
  );

  it('rejects a key past the length limit', () => {
    expect(() => slotKey('a'.repeat(MAX_KEY_LENGTH + 1))).toThrow(InvalidSlotKeyError);
    expect(() => slotKey('a'.repeat(MAX_KEY_LENGTH))).not.toThrow();
  });
});

describe('slotKeys', () => {
  it('hashes a batch in order', () => {
    expect(slotKeys(['hero.headline', 'nav.link.1'])).toEqual([
      slotKey('hero.headline'),
      slotKey('nav.link.1'),
    ]);
  });

  /**
   * A site registers its slots in one transaction, so a config with three bad keys should produce
   * one error listing three — not three rounds of fix-and-retry against a chain.
   */
  it('reports every bad key at once rather than the first', () => {
    try {
      slotKeys(['hero.headline', 'Bad Key', 'also/bad', 'nav.link.1']);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('Bad Key');
      expect(message).toContain('also/bad');
      expect(message).toContain('2 keys');
    }
  });

  /**
   * `registerSlots` reverts `SlotAlreadyRegistered` on the second occurrence — AFTER the first has
   * been written. Catching it here turns a half-applied transaction into a config error.
   */
  it('rejects a duplicate key before it can half-apply a registration', () => {
    expect(() => slotKeys(['hero.headline', 'nav.link.1', 'hero.headline'])).toThrow(InvalidSlotKeyError);
  });

  it('accepts an empty batch', () => {
    expect(slotKeys([])).toEqual([]);
  });
});
