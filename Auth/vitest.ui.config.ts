import { defineConfig } from 'vitest/config';

// Explicit local command only; ordinary unit tests and CI do not include these UI checks.
export default defineConfig({ test: { include: ['e2e/**/*.ui.tsx'] } });
