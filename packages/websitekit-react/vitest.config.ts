import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The package's own tsconfig sets "jsx": "react-jsx", but Vite's oxc transform reads that file
  // and the two disagree about naming; spelling the runtime out here keeps .tsx tests parseable
  // without touching the build config. Same workaround apps/web needs, for the same reason.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
