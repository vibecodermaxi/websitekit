/**
 * Content addressing — spec §3, LOCKED.
 *
 *     object      = [schemeVersion:u8][kind:u8][payload…]
 *     contentHash = sha256(object)        // fits bytes32, stored on-chain
 *
 * `payload` is opaque bytes. Not a canonical string with named segments.
 *
 * **This is a deliberate rejection of how v1's `apps/api/src/hash.ts` evolved.** That
 * scheme is a delimiter-joined canonical string which accreted `color:`, `bg:`, `style:`,
 * `reveal:`, `rotate:` and `var:` segments over successive phases, each appended under an
 * "absent, not empty" rule so old hashes stayed valid. It works — because one team controls both
 * sides and can reason about every hash it has ever produced. Ship that shape as a framework and
 * every user's on-chain hashes are permanently coupled to a vocabulary you will want to extend,
 * and a dev on an old package version renders a blank slot with no error anywhere.
 *
 * So the framework hashes BYTES, and any structure — JSON for a styled text block, raw bytes for an
 * image — is the dev's concern inside `payload`.
 *
 * Three decisions worth restating because they are not obvious and cannot be revisited:
 *
 *   - **sha256, not keccak.** The contract never hashes anything, so EVM-native buys nothing —
 *     while sha256 makes `contentHash` reconstructible as an IPFS CIDv1 raw multihash. The hash IS
 *     the URL, so the default read path needs no storage adapter and no mapping table.
 *   - **Version and kind live in the object, not merely in the preimage.** A renderer fetches,
 *     verifies, then reads two bytes and knows what it is holding. An unknown version degrades to
 *     `fallback` with a warning instead of the silent blank a bare hash mismatch produces. `kind`
 *     also domain-separates, which is the lesson v1's `hash.ts` learned when a text body could
 *     collide with a `youtube:` video src.
 *   - **Content-only preimage — no site, no slot key.** The chain already binds hash → slot, so
 *     adding them gains nothing and costs dedup across slots.
 *
 * Sanitization is a RENDER-time concern, not a hash-time one. v1's hash function assumes its
 * inputs already passed `sanitizeText`, which is what makes its `\n` delimiter unambiguous. Hashing
 * raw bytes removes that dependency entirely: the renderer treats all content as untrusted — which
 * it always was — and escapes at render.
 */
import { sha256 } from 'viem';
import type { Hex } from 'viem';

/**
 * Bumping this is how a future object layout ships. It is in the preimage, so a v2 scheme is a
 * version bump rather than an argument — and a v1 renderer meeting a v2 object says so out loud
 * instead of rendering nothing.
 */
export const SCHEME_VERSION = 1;

/**
 * Well-known payload kinds. `kind` is a `u8` and the framework claims only the low range; ids from
 * `SITE_DEFINED_KIND_MIN` up are yours and will never be assigned a meaning here.
 *
 * `0` is deliberately not a kind. A zero byte is what an uninitialized buffer, a truncated fetch
 * and a zeroed storage read all look like, and none of those should decode as valid content.
 */
export const ContentKind = {
  Text: 1,
  Link: 2,
  Image: 3,
  Video: 4,
  /**
   * A body of some other kind, with a destination attached — see `encodeLinked`.
   *
   * **A wrapper rather than a product type**, because the decision it encodes was *a link is
   * optional and can be added to any slot*, and a thing that can be added to anything is a
   * decoration on content rather than a kind of it. The alternative — `LinkedImage`, then
   * `LinkedVideo` — spends one id per pairing and reopens on the third ask.
   */
  Linked: 5,
} as const;

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

/** Kind ids at or above this are reserved for the site and never interpreted by websitekit. */
export const SITE_DEFINED_KIND_MIN = 128;

/**
 * The header is two bytes: `[schemeVersion][kind]`.
 */
export const HEADER_BYTES = 2;

/**
 * **Enforced at encode time, so it bites before anyone signs.**
 *
 * IPFS raw blocks top out around here; past it you need chunked DAG-PB and `sha256(bytes)` stops
 * being the CID — silently breaking hash-is-the-URL for exactly the content type most likely to
 * exceed it. A re-encoded web image lands at 100–300KB, so this only bites someone uploading a raw
 * camera JPEG.
 *
 * §3 says "cap payloads at 1MB"; this caps the OBJECT at 1 MiB, which is two bytes stricter. The
 * object is what gets stored and addressed, so it is the thing that has to stay a valid raw block —
 * capping the payload instead would let a maximal payload produce a 1 MiB + 2 object and defeat the
 * stated reason for the cap.
 */
export const MAX_OBJECT_BYTES = 1_048_576;

export class ContentTooLargeError extends RangeError {
  constructor(readonly objectBytes: number) {
    super(
      `websitekit/content: object is ${objectBytes} bytes, over the ${MAX_OBJECT_BYTES}-byte cap — ` +
        'past this the hash is no longer the CID. Re-encode or downscale before submitting.',
    );
    this.name = 'ContentTooLargeError';
  }
}

export class MalformedContentError extends Error {
  constructor(message: string) {
    super(`websitekit/content: ${message}`);
    this.name = 'MalformedContentError';
  }
}

export interface EncodedContent {
  /** The full object — this is what gets stored, and what the hash is taken over. */
  bytes: Uint8Array;
  /** `sha256(bytes)`, the value written on-chain. */
  hash: Hex;
  /** The same hash expressed as an IPFS CIDv1 raw block — the default read address. */
  cid: string;
}

/**
 * Wraps a payload in the scheme header and hashes it.
 *
 * @param kind One of `ContentKind`, or any id at or above `SITE_DEFINED_KIND_MIN`.
 */
export function encodeContent(kind: number, payload: Uint8Array): EncodedContent {
  assertByte(kind, 'kind');
  if (kind === 0) {
    throw new MalformedContentError('kind 0 is reserved and never valid — pick a ContentKind');
  }

  const objectBytes = HEADER_BYTES + payload.length;
  if (objectBytes > MAX_OBJECT_BYTES) throw new ContentTooLargeError(objectBytes);

  const bytes = new Uint8Array(objectBytes);
  bytes[0] = SCHEME_VERSION;
  bytes[1] = kind;
  bytes.set(payload, HEADER_BYTES);

  const hash = sha256(bytes);
  return { bytes, hash, cid: contentHashToCid(hash) };
}

const utf8 = new TextEncoder();

/** UTF-8 bytes, unsanitized and unescaped — see the module note on why that is correct here. */
export function encodeText(text: string): EncodedContent {
  return encodeContent(ContentKind.Text, utf8.encode(text));
}

/**
 * A link payload is JSON — `{"href": "…"}`, optionally with a `"label"`.
 *
 * **It encoded a bare UTF-8 URL string until 2026-08-23, and every consumer disagreed with it.**
 * `@websitekit/react`'s `Slot.tsx` parses JSON and reads `href`/`label`; `@websitekit/loader`'s
 * `renderLink` does the same; `seed-content.ts` and `seed-example-content.ts` both WRITE that shape,
 * so the convention on chain was never in doubt. This helper was the only thing that disagreed, and
 * nothing called it — so the disagreement was published, documented, listed in the generated API
 * reference, and had never once rendered.
 *
 * The failure it would have produced is the specific one this content scheme exists to prevent: the
 * bytes verify, the hash matches, the object decodes, and then the renderer finds no JSON and falls
 * back to the publisher's own content. **A silent blank, with nothing anywhere reporting an error.**
 *
 * Fixing it is a breaking change to a function with no callers, which is the cheapest kind, and it
 * is not a contract change — content encoding is entirely client-side and the on-chain hash is over
 * whatever bytes were produced, so existing links are unaffected.
 *
 * **Scheme policy is deliberately NOT here.** `javascript:` is refused at RENDER, by the loader's
 * `safeHref` and by nothing else, because the renderer is the security boundary — it is the only
 * place that sees content nobody in this repo wrote. Restating that list here would create a second
 * definition of "safe" that can drift from the one actually enforced, and the drifting copy would be
 * the reassuring one. An href refused at render falls back to the publisher's own markup, which is
 * the designed behaviour rather than a gap.
 *
 * @param href Where the link points. Relative hrefs are legal; the renderer resolves them.
 * @param label What it says. Omitted, both renderers show the href itself.
 */
export function encodeLink(href: string, label?: string): EncodedContent {
  if (typeof href !== 'string' || href.trim() === '') {
    throw new MalformedContentError('a link needs an href');
  }
  // `JSON.stringify` drops an undefined value, so an omitted label produces `{"href":"…"}` — which
  // is what both renderers already handle, rather than a `"label":null` neither of them checks for.
  return encodeContent(ContentKind.Link, utf8.encode(JSON.stringify({ href, label })));
}

export function encodeImage(bytes: Uint8Array): EncodedContent {
  return encodeContent(ContentKind.Image, bytes);
}

/**
 * The wrapper's payload layout. Two bytes of length rather than one because 255 is inside the range
 * of URLs people actually paste, and rather than four because the object cap is 1 MiB and a href
 * longer than 64 KiB is not a href.
 */
const LINKED_HREF_LENGTH_BYTES = 2;
const MAX_HREF_BYTES = 0xffff;

/**
 * Kinds that already carry a destination of their own, and therefore may never be wrapped.
 *
 * **This is the twin trap refused at the door.** `Text` wrapped in a link and `Link` itself would
 * be two encodings of one thing, with nothing comparing them — and unlike the four twins this repo
 * pins with shared fixtures, this one is avoidable by construction, because both ends are in this
 * function. `Link` is what a text slot with a destination is.
 */
const NEVER_WRAPPED: readonly number[] = [ContentKind.Text, ContentKind.Link, ContentKind.Linked];

export interface DecodedLinked {
  /** The kind of the body — never `Linked`, never `Text`, never `Link`. */
  innerKind: number;
  /** Where it points, exactly as written. **Scheme policy is the renderer's**, not this function's. */
  href: string;
  /** The body, to be rendered as `innerKind` says. */
  body: Uint8Array;
}

/**
 * Wraps a body of another kind with a destination.
 *
 *     payload = [innerKind:u8][hrefLen:u16 big-endian][href utf8][body…]
 *
 * **Nesting is refused rather than supported.** One link is a decoration; two is a malformed object,
 * and a decoder that recurses on bytes somebody else wrote is a decoder with a depth limit to
 * argue about. `decodeLinked` refuses it too, so a hand-built object cannot smuggle one past this.
 *
 * **No scheme check here, deliberately, and it is `encodeLink`'s reasoning unchanged:** the
 * renderer is the security boundary because it is the only place that sees content nobody in this
 * repo wrote, and a second list of safe schemes would be a second definition of "safe" that can
 * drift — with the drifting copy being the reassuring one. A href refused at render falls back to
 * the publisher's own markup, which is the designed behaviour and not a gap.
 */
export function encodeLinked(innerKind: number, href: string, body: Uint8Array): EncodedContent {
  assertByte(innerKind, 'innerKind');
  if (NEVER_WRAPPED.includes(innerKind)) {
    throw new MalformedContentError(
      `kind ${innerKind} already carries a destination — a text slot with a link is ContentKind.Link`,
    );
  }
  if (typeof href !== 'string' || href.trim() === '') {
    throw new MalformedContentError('a linked object needs an href');
  }

  const hrefBytes = utf8.encode(href);
  if (hrefBytes.length > MAX_HREF_BYTES) {
    throw new MalformedContentError(`href is ${hrefBytes.length} bytes, over the ${MAX_HREF_BYTES}-byte field`);
  }

  const payload = new Uint8Array(1 + LINKED_HREF_LENGTH_BYTES + hrefBytes.length + body.length);
  payload[0] = innerKind;
  payload[1] = (hrefBytes.length >>> 8) & 0xff;
  payload[2] = hrefBytes.length & 0xff;
  payload.set(hrefBytes, 3);
  payload.set(body, 3 + hrefBytes.length);

  return encodeContent(ContentKind.Linked, payload);
}

/**
 * Reads a `Linked` payload back. Throws `MalformedContentError` on anything a renderer should treat
 * as fallback — a truncated header, a length that runs past the end, a body kind that may not be
 * wrapped, or a href that is not UTF-8.
 *
 * The length is checked against the payload it actually has rather than trusted, which is
 * `sniffImage`'s rule applied to our own format: the bytes decide, never the field claiming to
 * describe them.
 */
export function decodeLinked(payload: Uint8Array): DecodedLinked {
  const header = 1 + LINKED_HREF_LENGTH_BYTES;
  if (payload.length < header) {
    throw new MalformedContentError(`linked payload is ${payload.length} bytes, shorter than its 3-byte header`);
  }

  const innerKind = payload[0]!;
  if (innerKind === 0) throw new MalformedContentError('kind 0 is reserved and never valid');
  if (NEVER_WRAPPED.includes(innerKind)) {
    throw new MalformedContentError(`kind ${innerKind} may not be wrapped — see encodeLinked`);
  }

  const hrefLength = (payload[1]! << 8) | payload[2]!;
  const bodyStart = header + hrefLength;
  if (bodyStart > payload.length) {
    throw new MalformedContentError(`href claims ${hrefLength} bytes, past the end of a ${payload.length}-byte payload`);
  }

  // `fatal`, so invalid UTF-8 throws instead of arriving as replacement characters in a URL.
  let href: string;
  try {
    href = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(header, bodyStart));
  } catch {
    throw new MalformedContentError('href is not valid UTF-8');
  }
  if (href === '') throw new MalformedContentError('a linked object needs an href');

  return { innerKind, href, body: payload.subarray(bodyStart) };
}

export interface DecodedContent {
  schemeVersion: number;
  kind: number;
  payload: Uint8Array;
}

/**
 * Splits an object into its header and payload. Does NOT verify the hash — use `readContent` for
 * anything that will be rendered.
 */
export function decodeContent(bytes: Uint8Array): DecodedContent {
  if (bytes.length < HEADER_BYTES) {
    throw new MalformedContentError(`object is ${bytes.length} bytes, shorter than the 2-byte header`);
  }
  return {
    schemeVersion: bytes[0]!,
    kind: bytes[1]!,
    payload: bytes.subarray(HEADER_BYTES),
  };
}

export type ContentFailure =
  /** The bytes do not hash to what the chain says. Never render these. */
  | 'hash-mismatch'
  /** Shorter than the header, or a kind of 0. */
  | 'malformed'
  /** Verified, but written under a scheme this package does not know how to read. */
  | 'unknown-version';

export type ContentResult =
  | ({ ok: true } & DecodedContent)
  | { ok: false; reason: ContentFailure; schemeVersion?: number };

/**
 * The one function a renderer should call. Verify, then decode, in that order and never the other
 * way round.
 *
 * **§3's second honest caveat is what this exists for.** Nothing guarantees the bytes stay
 * available: the chain will happily say a slot is owned and priced while its content 404s. v1
 * never had that failure mode because Postgres and R2 were the same system as the renderer; the
 * framework introduces it. So every failure here is a `fallback`, and unverified bytes never reach
 * a render path — a hash mismatch is indistinguishable from an attacker substituting content, and
 * has to be treated as one.
 *
 * `unknown-version` is separated from `malformed` on purpose. It is the difference between "this
 * gateway served you garbage" and "this slot was written by someone on a newer SDK than you", and
 * only the second one is fixed by upgrading.
 */
export function readContent(bytes: Uint8Array, expectedHash: Hex): ContentResult {
  if (sha256(bytes).toLowerCase() !== expectedHash.toLowerCase()) {
    return { ok: false, reason: 'hash-mismatch' };
  }

  let decoded: DecodedContent;
  try {
    decoded = decodeContent(bytes);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (decoded.kind === 0) return { ok: false, reason: 'malformed' };
  if (decoded.schemeVersion !== SCHEME_VERSION) {
    return { ok: false, reason: 'unknown-version', schemeVersion: decoded.schemeVersion };
  }

  return { ok: true, ...decoded };
}

// ---------------------------------------------------------------------------
// CID — the hash IS the address
// ---------------------------------------------------------------------------

/** RFC 4648 base32, lowercase, no padding — multibase `b`. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * `[cidVersion=1][multicodec=raw][multihash=sha2-256][length=32]`, the prefix that makes every
 * websitekit CID start `bafkrei`.
 */
const CID_PREFIX = Uint8Array.from([0x01, 0x55, 0x12, 0x20]);

/**
 * Renders a `bytes32` content hash as the IPFS CIDv1 raw block that addresses the same bytes.
 *
 * This is the whole payoff of choosing sha256 over keccak: a client with nothing but the on-chain
 * hash can construct a gateway URL. No storage adapter, no mapping table, no backend on the read
 * path.
 */
export function contentHashToCid(hash: Hex): string {
  const digest = hexToBytes(hash);
  if (digest.length !== 32) {
    throw new MalformedContentError(`content hash must be 32 bytes, got ${digest.length}`);
  }
  const cid = new Uint8Array(CID_PREFIX.length + 32);
  cid.set(CID_PREFIX, 0);
  cid.set(digest, CID_PREFIX.length);
  return `b${base32Encode(cid)}`;
}

/**
 * The inverse. Useful for checking that a gateway URL a site has stored actually addresses the
 * hash the chain holds — the two can drift, and when they do the slot renders someone else's
 * content with no error.
 */
export function cidToContentHash(cid: string): Hex {
  if (!cid.startsWith('b')) {
    throw new MalformedContentError(`expected a base32 multibase CID starting "b", got "${cid.slice(0, 8)}…"`);
  }
  const bytes = base32Decode(cid.slice(1));
  if (bytes.length < CID_PREFIX.length + 32) {
    throw new MalformedContentError(`CID decodes to ${bytes.length} bytes, too short for a raw sha256 block`);
  }
  for (let i = 0; i < CID_PREFIX.length; i++) {
    if (bytes[i] !== CID_PREFIX[i]) {
      throw new MalformedContentError('CID is not a CIDv1 raw block with a sha2-256 multihash');
    }
  }
  return bytesToHex(bytes.subarray(CID_PREFIX.length, CID_PREFIX.length + 32));
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new MalformedContentError(`"${char}" is not a base32 character`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function hexToBytes(hex: Hex): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new MalformedContentError('hex string has an odd length');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new MalformedContentError(`"${body}" is not valid hex`);
    out[i] = byte;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as Hex;
}

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new MalformedContentError(`${name} must be a u8, got ${value}`);
  }
}
