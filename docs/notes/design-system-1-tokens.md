# Design system 1: tokens and the guard

PR 1 of 4 of the design-system normalization (1: tokens + guard, 2: shell seams on
`--gap-shell` and panes on `rounded-pane`, 3 and 4: sweep src onto the roles and the scale).
Frontend only. This PR adds the tokens and a guard; it moves no component onto them.

## Tokens (gui/frontend/src/index.css)

| token | value | Tailwind |
| --- | --- | --- |
| `--gap-shell` (:root) | 12px (was 8 in the shell's seams; PR 2 moves them) | `--spacing-shell`: `m-shell`, `mt-shell`, `pl-shell`, `gap-shell`, ... |
| `--radius` (:root) | 0.75rem = 12px, the pane corner (was 10px) | `rounded-pane`, `rounded-xl` |

Radius scale (fixed values, no longer multiples of `--radius`):

| class | before | now |
| --- | --- | --- |
| `rounded-sm` | 6px | 4px |
| `rounded-md` | 8px | 6px |
| `rounded-lg` | 10px | 10px |
| `rounded-xl` | 14px | 12px (`var(--radius)`) |
| `rounded-pane` | (new) | 12px (`var(--radius)`) |
| `rounded-2xl` | 18px | 16px |
| `rounded-3xl`, `-4xl`, `-xs` | 22 / 26 / 2px | not generated |
| `rounded` (bare) | 4px | 4px, banned |

Rule: a rounded element inside a padded rounded parent takes the next step down. Buttons
(md) and small chips (sm) shrink by 2px app-wide; the composer and completion card
(`rounded-2xl`) and the Themes preview (`rounded-xl`) by 2px. Panes are `rounded-lg` today
and stay 10px until PR 2 moves them to `rounded-pane`. Sonner's toasts use `var(--radius)`
and grow 10 → 12px.

Type roles, `@utility` classes in index.css (names also in `src/design/tokens.ts`):

| class | size / line-height | weight | other | colour |
| --- | --- | --- | --- | --- |
| `text-title` | 22 / 28 | 600 | tracking-tight | foreground |
| `text-heading` | 15 / 20 | 600 | | foreground |
| `text-subheading` | 14 / 20 | 600 | | foreground |
| `text-overline` | 11 / 16 | 500 | uppercase, 0.06em | muted-foreground |
| `text-body` | 15 / 22 | 400 | | foreground |
| `text-body-sm` | 13 / 18 | 400 | | foreground |
| `text-label` | 14 / 20 | 500 | | foreground |
| `text-caption` | 13 / 18 | 400 | | muted-foreground |
| `text-caption-sm` | 12 / 16 | 400 | | muted-foreground |
| `text-link` | inherits | 500 | underline on hover | link |
| `text-code` | 0.92em, inherits | 400 | `ui-monospace, "SF Mono", Menlo, monospace` | inherits |

A colour, weight, tracking or leading utility after a role wins: `text-caption
text-foreground`, `text-body font-medium`.

## The guard (gui/frontend/src/design)

- `scan.ts`: the scanner. Parses each file with the TypeScript compiler API and matches
  only string and template literals (comments, JSX text and regex literals are skipped), so
  "rounded up" in a comment is not a hit but in a string it is. Categories: size
  (`text-xs..3xl`, `text-[…]`), weight (`font-thin..black`), leading (`leading-[…]`),
  radius (bare `rounded`, `rounded-[…]`). Scans `src/**/*.{ts,tsx}` except `*.test.*`,
  `*.d.ts` and `src/gen`; `components/ui` included. CSS is not scanned.
- `guards.allow.json`: per file (repo-relative) the counts the tree had when the guard
  landed. 103 of 321 files: size 481, weight 156, leading 6, radius 40.
- `guards.test.ts`: fails when a file has more hits in a category than allowed (a file
  not listed is allowed none), naming the file, line, match and pattern and what to use
  instead. A separate test fails when a file has fewer than allowed: run
  `pnpm run guards:allow` (gui/frontend) and commit the JSON, so the list only shrinks.
  A third checks the JSON is in the generator's format.
- `pnpm run guards:allow` = `scripts/guards-allow.ts`: walks src with the same scanner and
  rewrites the JSON.
- `roles.test.ts`: compiles index.css with Tailwind's own `compile()` and checks every
  role's declarations, the radius scale, the shell spacing, the override order, and that
  `cn` merges the tokens.

## Gotchas

- **cn read the roles as colours.** `cn` (tailwind-merge semantics) treats any
  `text-<word>` as a text colour, so `cn("text-caption", "text-foreground")` dropped the
  role. `lib/utils.ts` now builds `cn` with `createCn` and extends its theme: the block
  roles join the font-size group, `text-link`/`text-code` get their own group,
  `pane` joins radius and `shell` spacing. 25 files imported `cn` straight from the
  package (shadcn primitives, Themes, SettingRow); they now import `@/lib/utils`, and
  ESLint refuses a direct `cn` import.
- **Utility order.** Tailwind v4 sorts utilities by their first property in its property
  order, then by property count. Every block role starts with font-size, so it lands before
  colour, weight, tracking and leading utilities whatever the class order; `text-code`
  starts with font-family, before `font-mono` because it has more properties. The test
  asserts this on the compiled CSS rather than trusting the rule.
- **`--radius-*: initial` also removes bare `rounded`** (Tailwind's deprecated `--radius`
  theme key lives in the same namespace), turning every bare `rounded` square. xs/3xl/4xl
  are cleared one key at a time instead.
- **`text-link` already existed** as Tailwind's colour utility for `--color-link`. The
  `@utility` merges with it (the rule carries both `color` declarations, same value), and
  its two existing users (UpdateDialog's links, the Themes gallery's link sample) now get
  weight 500.
- **Themes.** `themes/convert.ts` reads every `:root` variable as a colour except a
  `NOT_COLOURS` set; `--gap-shell` joined `--cf-zoom` and `--radius` there. Themes carry
  only colours, so no theme can move the radius or the gap. The catalog is unchanged.
- `scan.ts` imports `typescript` (a devDependency) and is never imported by app code, so it
  is not bundled. The script lives in `gui/frontend/scripts` (added to tsconfig.node.json)
  because src has no Node types.
- The weight category also counts `font-medium` used as a modifier on a role; PRs 3/4
  decide whether the guard should tell the two apart.
  PR 3 dropped the weight category and, with PR 4 merged, made the guard strict and
  deleted the allowlist and `guards:allow` (docs/notes/design-system-3-sweep-chrome.md).

## Verified

- `make check` green.
- `make gui-e2e` (on `E2E_MOCK_PORT=7833 E2E_VITE_PORT=9288`, 7799 was taken by another
  worktree's run): 810 passed, 40 skipped, 0 failed. No assertion encoded the old radii.
- Settings page and a thread before/after in Playwright WebKit against the mock daemon,
  dark and light: buttons, selects and inputs 2px tighter, nothing else moves.
