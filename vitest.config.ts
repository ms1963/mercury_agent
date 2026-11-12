import { defineConfig } from 'vitest/config';

// Tests import the built workspace packages (@mercury/*): run `npm run build` first.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // The mock LLM/decision providers are disabled in normal operation (Mercury
    // requires a real provider). Tests enable them to run fully offline.
    env: { MERCURY_ENABLE_MOCK: '1' },
  },
});
