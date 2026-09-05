import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // DB-backed integration files each provision an isolated Postgres schema
    // and run `prisma migrate deploy` in beforeAll; under concurrent file
    // startup that legitimately exceeds the 10s default. Race tests hold
    // advisory locks across deliberate pauses, so they also need headroom.
    //
    // A per-hook timeout argument (`beforeAll(fn, 30_000)`) silently overrides
    // this and reintroduces the flake it exists to prevent — `createTestDb`
    // alone backs off for up to ~31s across its six startup retries, so a
    // budget under that cannot even survive contention it is designed to ride
    // out. Provisioning hooks must take their budget from here.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
