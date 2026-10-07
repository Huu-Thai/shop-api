import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    restoreMocks: true,
    setupFiles: ['src/testing/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/database/generated/**',
        'src/database/prisma/seed.ts',
        'src/main.ts',
        'src/cli/**', // admin bootstrap + demo seed: exercised by the live container check
        'src/worker.main.ts',
        'src/bootstrap.ts', // exercised by the e2e suite
        'src/**/*.module.ts', // wiring only; covered by e2e
        'src/**/dto/**',
        'src/testing/**',
      ],
      // PLAN.md gate is 80 / 75; ratcheted to just below the measured Phase 3 level
      // (96.7% lines, 86.6% branches) so coverage can only go up. CI fails below these.
      thresholds: { lines: 95, statements: 95, functions: 92, branches: 85 },
    },
  },
});
