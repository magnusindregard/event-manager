import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "infra/**", "packages/sdk/src/core.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Module boundaries (ADR 0001): a domain module reaches another module only through
    // its index.ts. Files inside a module import each other with "./".
    files: ["packages/domain/src/*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*/*", "!../*/index.js", "../../*"],
              message: "Import other domain modules through their index.ts (ADR 0001).",
            },
          ],
        },
      ],
    },
  },
  {
    // Apps use packages through their public entry points only; the exports map enforces
    // this at runtime, the rule catches relative reach-ins.
    files: ["apps/*/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/packages/*/src/**", "@event-manager/*/src/**"], message: "Import the package, not its source files." }] },
      ],
    },
  },
);
