import { describe, it, expect } from 'vitest';
import { sha256 } from 'viem';
import {
  ContentKind,
  ContentTooLargeError,
  HEADER_BYTES,
  MAX_OBJECT_BYTES,
  MalformedContentError,
  SCHEME_VERSION,
  SITE_DEFINED_KIND_MIN,
  cidToContentHash,
  contentHashToCid,
  decodeContent,
  encodeContent,
  encodeImage,
  encodeLink,
  encodeText,
  readContent,
} from './content';

const utf8 = new TextEncoder();

describe('the object layout', () => {
  it('is [schemeVersion][kind][payload]', () => {
    const payload = utf8.encode('Ship faster.');
    const { bytes } = encodeContent(ContentKind.Text, payload);

    expect(bytes[0]).toBe(SCHEME_VERSION);
    expect(bytes[1]).toBe(ContentKind.Text);
    expect(bytes.subarray(HEADER_BYTES)).toEqual(payload);
    expect(bytes.length).toBe(payload.length + HEADER_BYTES);
  });

  it('hashes the whole object, header included', () => {
    const { bytes, hash } = encodeText('Ship faster.');
    expect(hash).toBe(sha256(bytes));
  });

  /**
   * `kind` domain-separates. This is the lesson v1's `hash.ts` learned when a text body could
   * collide with a `youtube:` video src — identical bytes under different kinds must not share a
   * hash, or one slot's content is addressable as another's.
   */
  it('gives identical payloads under different kinds different hashes', () => {
    const payload = utf8.encode('https://example.com');
    expect(encodeContent(ContentKind.Link, payload).hash).not.toBe(
      encodeContent(ContentKind.Text, payload).hash,
    );
  });

  /**
   * Content-only preimage — no site, no slot key (§3). The chain already binds hash → slot, so
   * adding them would gain nothing and cost dedup: the same headline on two slots, or on two
   * different sites, is one stored object.
   */
  it('dedups identical content across slots and sites', () => {
    expect(encodeText('Ship faster.').hash).toBe(encodeText('Ship faster.').hash);
  });

  it('rejects kind 0, which is what every uninitialized buffer looks like', () => {
    expect(() => encodeContent(0, new Uint8Array(1))).toThrow(MalformedContentError);
  });

  it('accepts site-defined kinds above the reserved range', () => {
    const { bytes } = encodeContent(SITE_DEFINED_KIND_MIN + 7, utf8.encode('{}'));
    expect(bytes[1]).toBe(SITE_DEFINED_KIND_MIN + 7);
  });

  it('rejects a kind that is not a u8', () => {
    expect(() => encodeContent(256, new Uint8Array(1))).toThrow(MalformedContentError);
    expect(() => encodeContent(1.5, new Uint8Array(1))).toThrow(MalformedContentError);
  });
});

describe('the 1 MiB cap', () => {
  /** It has to bite at encode time, because that is before anyone signs. */
  it('admits an object of exactly the cap and rejects one byte more', () => {
    const atCap = new Uint8Array(MAX_OBJECT_BYTES - HEADER_BYTES);
    expect(() => encodeImage(atCap)).not.toThrow();

    const overCap = new Uint8Array(MAX_OBJECT_BYTES - HEADER_BYTES + 1);
    expect(() => encodeImage(overCap)).toThrow(ContentTooLargeError);
  });

  /**
   * The cap is on the OBJECT, not the payload, which is two bytes stricter than §3's wording. The
   * object is what gets stored and addressed, so it is the thing that has to stay a valid raw
   * block — capping the payload instead would let a maximal payload produce a 1 MiB + 2 object and
   * defeat the stated reason for the cap.
   */
  it('counts the header against the cap', () => {
    const payloadAtOneMiB = new Uint8Array(MAX_OBJECT_BYTES);
    expect(() => encodeImage(payloadAtOneMiB)).toThrow(ContentTooLargeError);
  });

  it('reports the offending size, so the error is actionable', () => {
    try {
      encodeImage(new Uint8Array(MAX_OBJECT_BYTES));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContentTooLargeError);
      expect((error as ContentTooLargeError).objectBytes).toBe(MAX_OBJECT_BYTES + HEADER_BYTES);
    }
  });
});

describe('CIDs — the hash IS the address', () => {
  /**
   * **External ground truth, not a round-trip.** These are the published IPFS CIDv1 raw CIDs for
   * the empty file and for `hello world`; anyone can check them against `ipfs add --raw-leaves` or
   * any CID inspector. A round-trip test only proves this file's encoder and decoder agree with
   * each other, which they would even if the base32 alphabet were wrong.
   */
  it('matches the published CIDv1 raw CID for the empty file', () => {
    expect(contentHashToCid(sha256(new Uint8Array(0)))).toBe(
      'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    );
  });

  it('matches the published CIDv1 raw CID for "hello world"', () => {
    expect(contentHashToCid(sha256(utf8.encode('hello world')))).toBe(
      'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
    );
  });

  /** Every slotkit CID is a CIDv1 raw sha2-256 block, so every one of them starts this way. */
  it('always produces a bafkrei… CID of the canonical length', () => {
    const { cid } = encodeText('anything at all');
    expect(cid.startsWith('bafkrei')).toBe(true);
    expect(cid.length).toBe(59);
  });

  it('round-trips back to the on-chain hash', () => {
    const { hash, cid } = encodeText('Ship faster.');
    expect(cidToContentHash(cid)).toBe(hash);
  });

  it('rejects a CID that is not a raw sha256 block', () => {
    // A CIDv1 dag-pb CID — right multibase, wrong multicodec.
    expect(() => cidToContentHash('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toThrow(
      MalformedContentError,
    );
  });

  it('rejects a non-base32 multibase prefix', () => {
    expect(() => cidToContentHash('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toThrow(
      MalformedContentError,
    );
  });
});

describe('readContent — the only function a renderer should call', () => {
  it('verifies and decodes matching bytes', () => {
    const { bytes, hash } = encodeText('Ship faster.');
    const result = readContent(bytes, hash);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe(ContentKind.Text);
    expect(result.schemeVersion).toBe(SCHEME_VERSION);
    expect(new TextDecoder().decode(result.payload)).toBe('Ship faster.');
  });

  /**
   * The failure that matters. A hash mismatch is indistinguishable from an attacker substituting
   * content at the gateway, so it has to be treated as one — unverified bytes never reach a render
   * path.
   */
  it('refuses bytes that do not hash to what the chain says', () => {
    const { hash } = encodeText('Ship faster.');
    const substituted = encodeText('Buy my coin.').bytes;

    const result = readContent(substituted, hash);
    expect(result).toEqual({ ok: false, reason: 'hash-mismatch' });
  });

  it('is case-insensitive about the hash, since RPCs disagree on it', () => {
    const { bytes, hash } = encodeText('Ship faster.');
    expect(readContent(bytes, hash.toUpperCase().replace('0X', '0x') as `0x${string}`).ok).toBe(true);
  });

  /**
   * Separated from `malformed` on purpose: this is "written by someone on a newer SDK than you",
   * not "your gateway served garbage", and only the first is fixed by upgrading. Without the
   * version byte in the object this is a silent blank slot with no error anywhere.
   */
  it('reports an unknown scheme version distinctly, and says which', () => {
    const future = Uint8Array.from([99, ContentKind.Text, ...utf8.encode('from the future')]);
    const result = readContent(future, sha256(future));

    expect(result).toEqual({ ok: false, reason: 'unknown-version', schemeVersion: 99 });
  });

  it('reports a truncated object as malformed', () => {
    const truncated = Uint8Array.from([SCHEME_VERSION]);
    expect(readContent(truncated, sha256(truncated))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports a zero kind as malformed even when the hash checks out', () => {
    const zeroKind = Uint8Array.from([SCHEME_VERSION, 0, 1, 2, 3]);
    expect(readContent(zeroKind, sha256(zeroKind))).toEqual({ ok: false, reason: 'malformed' });
  });

  /** Empty payloads are legal — an owner clearing their slot is content, not an error. */
  it('accepts an empty payload', () => {
    const { bytes, hash } = encodeText('');
    const result = readContent(bytes, hash);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.length).toBe(0);
  });
});

describe('payload is opaque', () => {
  /**
   * §3's central decision. The SDK hashes bytes and never a canonical string with named segments,
   * so a site can put whatever structure it likes inside `payload` and slotkit never needs to learn
   * that vocabulary — which is what stops a framework-wide hash scheme from accreting one.
   */
  it('preserves arbitrary bytes exactly, including nulls and invalid UTF-8', () => {
    const hostile = Uint8Array.from([0x00, 0xff, 0xfe, 0x0a, 0x00, 0x80]);
    const { bytes, hash } = encodeContent(SITE_DEFINED_KIND_MIN, hostile);
    const result = readContent(bytes, hash);

    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.payload)).toEqual(Array.from(hostile));
  });

  /**
   * Sanitization is a render-time concern, not a hash-time one — hashing raw bytes is what removes
   * the dependency on an upstream `sanitizeText` that v1's delimiter scheme needed to be
   * unambiguous.
   */
  it('does not sanitize, escape, or normalize text', () => {
    const raw = '  <script>alert(1)</script> \r\n  ';
    const result = readContent(encodeText(raw).bytes, encodeText(raw).hash);
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.payload)).toBe(raw);
  });

  it('decodeContent does not verify — that is readContent’s job', () => {
    const { bytes } = encodeLink('https://example.com');
    expect(decodeContent(bytes).kind).toBe(ContentKind.Link);
  });
});
