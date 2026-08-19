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

export function encodeLink(url: string): EncodedContent {
  return encodeContent(ContentKind.Link, utf8.encode(url));
}

export function encodeImage(bytes: Uint8Array): EncodedContent {
  return encodeContent(ContentKind.Image, bytes);
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
