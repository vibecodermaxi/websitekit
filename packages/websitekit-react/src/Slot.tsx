'use client';

/**
 * `<Slot>` — the component a builder actually writes.
 *
 *     <Slot id="hero.headline" as="h1" className="text-6xl" fallback="Ship faster." />
 *
 * **`fallback` is the most important prop in this package.** It is what renders when a slot is
 * unclaimed, and it is what makes the page look finished on day one — the difference between a
 * demo and a dead grid of empty boxes. It is also the universal failure mode: unclaimed, never
 * edited, gateway down, hash mismatch, unknown scheme version. Every one of those paints
 * `fallback`, so a page whose storage has gone entirely dark still looks like the product it is
 * pretending to be.
 *
 * **Always import this as `Slot` from `@websitekit/react`, never as a bare default.** §7.10 accepts
 * one naming care point knowingly: `slot` is crowded frontend vocabulary — Web Components have a
 * native `<slot>` element and React has an established "slots" composition pattern. A named import
 * is how a reader tells at a glance which `Slot` is meant.
 */
import { createElement, useEffect, useState, type ElementType, type ReactNode } from 'react';
import { ContentKind } from '@websitekit/sdk';

import { useSlot, type UseSlotResult } from './useSlot';

const decoder = new TextDecoder();

/**
 * The payload structures `<Slot>` understands. These are a CLIENT convention layered on top of §3's
 * opaque bytes, not part of the wire format — the chain stores a hash and knows nothing about them,
 * and a site with its own structure uses `useSlot()` and renders it directly.
 *
 *   text   — UTF-8
 *   link   — JSON `{ "href": string, "label": string }`
 *   image  — the raw encoded image
 *   video  — JSON `{ "src": string }`
 */
export interface SlotProps {
  /**
   * The slot key from `websitekit.config.ts`, e.g. `hero.headline`.
   *
   * Named `id` because §0's example does, and deliberately NOT forwarded to the DOM — this is an
   * on-chain identity, not an HTML id, and spreading it would silently put `hero.headline` in the
   * document's id namespace where it would collide with the page's own.
   *
   * It IS emitted as `data-slot`, which is a namespace nothing else owns — enough for a site to
   * target slots in CSS, or to find which one an event came from, without that collision.
   */
  id: string;
  /** The element to render. Defaults per kind: `span` for text, `a` for link, `img` for image. */
  as?: ElementType;
  className?: string;
  /**
   * What renders when there is no verified content. A ReactNode for text and link slots; for image
   * and video slots, a string is used as the `src`.
   */
  fallback?: ReactNode;
  /** Escape hatch: render the slot yourself from the resolved state. */
  children?: (slot: UseSlotResult) => ReactNode;
}

export function Slot({ id, as, className, fallback, children }: SlotProps) {
  const slot = useSlot(id);
  if (children) return <>{children(slot)}</>;

  const kind = slot.content.state === 'ready' ? slot.content.kind : slot.definition.contentKind;

  if (kind === ContentKind.Image || kind === ContentKind.Video) {
    return <MediaSlot slot={slot} id={id} as={as} className={className} fallback={fallback} />;
  }

  if (slot.showFallback) {
    return createElement(as ?? defaultElement(kind), { className, 'data-slot': id }, fallback);
  }

  if (kind === ContentKind.Link) {
    const link = parseJson<{ href?: string; label?: string }>(slot.content);
    // A link whose payload does not parse, or names no destination, is a failure like any other —
    // rendering an anchor with no href is a dead element that looks deliberate.
    if (!link?.href) return createElement(as ?? 'a', { className, 'data-slot': id }, fallback);
    return createElement(as ?? 'a', { className, href: link.href, 'data-slot': id }, link.label ?? link.href);
  }

  return createElement(as ?? 'span', { className, 'data-slot': id }, decodePayload(slot));
}

/**
 * Media renders from VERIFIED BYTES via an object URL, never from a gateway URL.
 *
 * `<img src={gatewayUrl}>` would be simpler and is wrong: the browser fetches and paints those
 * bytes without anyone checking them against the on-chain hash, so a wrong or hostile gateway
 * substitutes content silently on a page whose entire premise is that content is verifiable.
 *
 * The cost, stated plainly: no cross-page-load browser image cache and no progressive decode. That
 * is the price of §3's "must never render unverified bytes", and the guarantee is the product.
 */
function MediaSlot({
  slot,
  id,
  as,
  className,
  fallback,
}: {
  slot: UseSlotResult;
  id: string;
  as?: ElementType;
  className?: string;
  fallback?: ReactNode;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const content = slot.content;

  useEffect(() => {
    if (content.state !== 'ready') {
      setObjectUrl(null);
      return;
    }
    // jsdom and older runtimes lack createObjectURL; without this guard a test environment throws
    // on every image slot rather than falling back.
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;

    const url = URL.createObjectURL(new Blob([content.payload as BlobPart]));
    setObjectUrl(url);
    // Revoked on unmount and on every content change, or a page that refetches through a few takes
    // leaks a blob per image for the session.
    return () => URL.revokeObjectURL(url);
  }, [content]);

  const src = objectUrl ?? (typeof fallback === 'string' ? fallback : undefined);
  if (!src) {
    return createElement(
      as ?? 'span',
      { className, 'data-slot': id },
      typeof fallback === 'string' ? null : fallback,
    );
  }

  const element = as ?? (slot.definition.kind === 'video' ? 'video' : 'img');
  return createElement(element, { className, src, 'data-slot': id, alt: element === 'img' ? '' : undefined });
}

function defaultElement(kind: number): ElementType {
  return kind === ContentKind.Link ? 'a' : 'span';
}

function decodePayload(slot: UseSlotResult): string {
  return slot.content.state === 'ready' ? decoder.decode(slot.content.payload) : '';
}

function parseJson<T>(content: UseSlotResult['content']): T | null {
  if (content.state !== 'ready') return null;
  try {
    return JSON.parse(decoder.decode(content.payload)) as T;
  } catch {
    return null;
  }
}
