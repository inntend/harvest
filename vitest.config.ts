import { configDefaults, defineConfig } from 'vitest/config';

// Two projects keep the live-API integration tests out of the default run.
// Select a project with `vitest run --project <name>` (see package.json scripts).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
        },
      },
    ],
  },
});
