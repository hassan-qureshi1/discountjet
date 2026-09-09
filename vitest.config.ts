import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      // Covers root AND nested package installs (e.g. extensions/*/node_modules)
      // whose own *.test.js files must never be collected as our tests.
      '**/node_modules/**',
      'dist/**',
      '.wrangler/**',
      '.worktrees/**',
      // Playwright owns the e2e specs — keep Vitest out of them.
      'playwright-tests/**',
    ],
  },
});
