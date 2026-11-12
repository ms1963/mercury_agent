import { defineConfig } from 'vitest/config';

// Tests import the built workspace packages (@mercury/*): run `npm run build` first.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
