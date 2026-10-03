import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['packages/*/src/**/*.spec.ts', 'packages/*/lint-boundary/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    environment: 'node',
    reporters: ['default'],
    passWithNoTests: false,
  },
});
