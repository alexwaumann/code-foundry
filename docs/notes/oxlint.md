# Frontend lint: ESLint replaced by oxlint

`pnpm run lint` in `gui/frontend` is now `oxlint --type-aware --deny-warnings`, configured by
`.oxlintrc.json`. ESLint, typescript-eslint and the two React plugins are gone from
`package.json`.

## Why

`eslint . --max-warnings 0` took about 4.5 minutes on a quiet 12-core laptop: typescript-eslint's
`strictTypeChecked` runs 40 type-aware rules through tsserver, single-threaded, over ~1000 files.
The same rule set in oxlint, with type-aware rules served by `oxlint-tsgolint` (the TypeScript 7
Go checker), takes about 2 seconds. `make check` was lint-bound; now vitest (~45 s) is the only
frontend cost left.

## What the config keeps

`@oxlint/migrate` converted the ESLint flat config: 146 of 151 active rules mapped one to one,
including every type-aware rule and the React Compiler rules from `eslint-plugin-react-hooks`.
Rule options (`no-unused-vars` with `ignoreRestSiblings`, the `restrict-*` strictness, `return-await`
error-handling-only, `ban-ts-comment` description length) carried over as written.

The hand edits after migration:

* The first ESLint block applied to `**/*.{ts,tsx}`; its rules are the top-level `rules` now.
* `no-undef` is off. TypeScript reports undefined names, and typescript-eslint's
  `eslint-recommended` preset turned it off for TS files too; the migrate tool re-enabled it
  as a nursery rule and it flagged `process` across the node-side scripts.
* The node-side override lists `themes/**` and every `*.config.ts`, which is what
  `tsconfig.node.json` includes. The ESLint list had only `mock`, `e2e` and `playwright.config.ts`.
* The `no-restricted-imports` layering (generated protobuf types only under `src/api`, `cn` only
  from `@/lib/utils`) stays as two overrides, the `src/api` one replacing the `src/**` one. oxlint
  overrides cannot carry an `ignores` list; later overrides win, like ESLint.

Dropped: `@typescript-eslint/no-unsafe-enum-assignment` (not in oxlint; the code has no enums).
`no-dupe-args`, `no-octal` and `react-hooks/config` are TS-era no-ops oxlint will not implement.

## Rule drift found by the switch

oxlint's implementations are stricter in five places ESLint let pass. Each got a
`oxlint-disable-next-line` with a reason rather than a code change:

* `react/only-export-components` on the `slotEditor` factory in `ThemeSlotEditor.tsx`.
* `react/purity` on `new Date()` during render in `UsagePage.tsx`: "today" must move while the
  page stays open, so recomputing per render is the intent.
* `react/immutability` on the `useCompletion` test harness writing the hook result to an outer ref.
* `typescript/no-deprecated` on `addListener`/`removeListener` in the `MediaQueryList` fake.

## Gotchas

* oxlint honours `eslint-disable` comments with ESLint rule names (`react-hooks/`,
  `@typescript-eslint/`), so the old comments kept working. They were rewritten to
  `oxlint-disable` with oxlint names (`react/`, `typescript/`) anyway, except under `src/gen`
  (buf writes those). The `-- reason` suffix is supported.
* `--type-aware` needs the `oxlint-tsgolint` package in the project's `node_modules`; oxlint
  does not fall back to a global one and fails fast with a clear message if it is missing.
* `--deny-warnings` is the `--max-warnings 0` equivalent. The two `react/*` rules ESLint shipped as
  warnings (`exhaustive-deps`, `incompatible-library`) stay warnings and still fail the run.
* `pnpm dlx oxlint` cannot find tsgolint and `pnpm dlx` eats `-p`; run the installed binaries.

## Not done here

`tsc -b` (about 10 s warm) could become `bun check -b` (0.3 s, Bun 1.4.3+, TypeScript 7
semantics) or `tsgo`. Measured, not switched: see the follow-up decision.
