import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library auto-cleans only when vitest globals are on; this package keeps them off, so the
// unmount is explicit. Without it, every render accumulates in the same document and a query for
// text that appears in two tests fails with "found multiple elements" — which reads like a
// component bug and is not one.
afterEach(cleanup);

// jsdom implements neither of these, and `<Slot>` uses them for the media path — content is
// rendered from verified bytes through a blob URL rather than from a gateway URL, which is the
// whole point of the hash gate and cannot be dropped just because the test environment is thin.
if (typeof URL.createObjectURL !== 'function') {
  let counter = 0;
  URL.createObjectURL = () => `blob:websitekit-test/${++counter}`;
  URL.revokeObjectURL = () => {};
}
