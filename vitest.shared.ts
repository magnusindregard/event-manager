import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Resolve workspace packages to their TypeScript source in tests.
const source = "@event-manager/source";

export default defineConfig({
  resolve: { conditions: [source, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [source, ...defaultServerConditions] } },
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
