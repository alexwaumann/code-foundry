import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  // Generated code: protobuf-es output and Wails bindings.
  globalIgnores(["dist", "bindings", "src/gen"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `const { [id]: _removed, ...rest } = obj` is the idiomatic immutable delete.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // Node-side tooling: mock daemon, Playwright config and specs.
    files: ["mock/**/*.ts", "e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Generated protobuf types are only allowed in src/api (see CLAUDE.md).
    // cn comes from @/lib/utils, which teaches it the design tokens (type roles, rounded-pane).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/api/**", "src/lib/utils.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "cn", message: "Import cn from @/lib/utils: it knows the design tokens (src/design/tokens.ts)." }],
          patterns: [{ group: ["@/gen/*", "**/gen/*"], message: "Import generated protobuf types only in src/api/." }],
        },
      ],
    },
  },
  {
    // src/api may import generated types, but cn still comes from @/lib/utils.
    files: ["src/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "cn", message: "Import cn from @/lib/utils." }] }],
    },
  },
  {
    // shadcn/ui components export variants alongside components.
    files: ["src/components/ui/**"],
    rules: { "react-refresh/only-export-components": "off" },
  },
]);
