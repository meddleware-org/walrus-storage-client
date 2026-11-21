// Vitest settings for the offline unit suite: `npm test`. The localnet integration suites have their own config (vitest.integration.config.ts).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: the package has no DOM code (it uses `fetch`, `Headers` and `AbortSignal`, which Node provides).
    environment: 'node',
    // Every unit test file under tests/ (the integration ones are excluded below).
    include: ['tests/**/*.test.ts'],
    // Integration suites are localnet-gated and run via vitest.integration.config.ts, not here,
    // so the default `npm test` (unit) stays fast and offline.
    exclude: ['tests/integration/**', 'node_modules/**'],
  },
})
