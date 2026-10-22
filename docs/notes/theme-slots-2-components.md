# Theme slots 2: components on the slots

PR 2 of the theme-slots series (1: the engine, `theme-slots-1-engine.md`; 2: this; next:
publish the resolved map to frames, user overrides). Frontend only. Goal: components say
what they mean with the semantic slots, so a theme override of `--cf-sidebar-row-selected`
or `--cf-warning-surface` changes exactly the thing it names, with no visible change.

## Utility naming

Every `--cf-*` slot (all 67) is a Tailwind colour: `--color-cf-<slot>: var(--cf-<slot>)` in
index.css's `@theme inline`, so the utility is the prop plus the slot name with its `cf-`:

`bg-cf-surface-raised`, `text-cf-text-muted`, `bg-cf-sidebar-row-selected`,
`bg-cf-warning-surface`, `border-cf-divider`, `ring-cf-focus`, `fill-cf-text-muted`,
`text-cf-diff-addition`, `bg-cf-message-surface`, …

- The `cf-` stays in the utility: without it `bg-accent` (shadcn's hover surface) and
  `bg-accent` (the slot, the brand colour) would collide, and so would `warning`, `border`,
  `input`, `sidebar` and the rest. With it every slot utility is unambiguous and greppable,
  at the cost of `text-cf-text` reading twice.
- `inline` as before: the utility reads `var(--cf-…)` where it is used, so a preview scope
  (ThemeScope sets its slots inline) paints in its own theme.
- Opacity modifiers still work (`bg-cf-text/10`, `hover:bg-cf-warning/30`) for tints that
  have no slot.
- Stylesheets read `var(--cf-…)` directly. index.css's own rules (the type roles,
  `.cf-markdown`, the base layer) read the slots too; they no longer read the component
  names.
- The 44 shadcn `--color-*` names and the alias block stay, for `components/ui/*`
  (vendored shadcn, not edited). `src/design/slots.test.ts` checks the `@theme` block both
  ways: every exposed colour is an alias or a slot, every `--cf-*` slot has its utility.

## Mapping

The mechanical part is the alias table read backwards: each shadcn utility became the slot
its name aliases, so it resolves to the same colour.

| old | new |
| --- | --- |
| `bg-background`, `bg-sheet` | `bg-cf-canvas` |
| `bg-pane` | `bg-cf-surface` |
| `border-pane-border`, `bg-pane-border` | `border-cf-divider`, `bg-cf-divider` |
| `bg-card` | `bg-cf-surface-raised` |
| `bg-popover` | `bg-cf-surface-overlay` |
| `bg-muted` | `bg-cf-surface-sunken` |
| `text-foreground`, `text-card-foreground`, `text-popover-foreground`, `text-secondary-foreground`, `text-accent-foreground` | `text-cf-text` |
| `text-muted-foreground` | `text-cf-text-muted` (in sidebar rows: `text-cf-sidebar-muted-foreground`) |
| `bg-accent` (hover surface) | `bg-cf-control-hover` |
| `bg-secondary` | `bg-cf-control` |
| `bg-primary`, `text-primary-foreground` | `bg-cf-accent`, `text-cf-accent-foreground` |
| `bg-primary/10` | `bg-cf-accent-surface` |
| `border-border`, `bg-border` | `border-cf-border`, `bg-cf-border` |
| `border-input`, `bg-input/30` | `border-cf-input`, `bg-cf-input/30` |
| `ring-ring`, `bg-ring`, `outline-ring/50` | `ring-cf-focus`, `bg-cf-focus`, `outline-cf-focus/50` |
| `text-destructive`, `bg-destructive`, `border-destructive/40` | `text-cf-error`, `bg-cf-error`, `border-cf-error/40` |
| `text-{success,warning,info,highlight}` | `text-cf-{success,warning,info,highlight}` |
| `bg-{tone}/10` (resting tint) | `bg-cf-{tone}-surface` (`destructive` → `error`) |
| `bg-{tone}/12`, `bg-{tone}/15` (resting chip) | `bg-cf-{tone}-surface` |
| `hover:bg-{tone}/15`, `/18`, `/30`; faint `/5`, `/7`; the search mark's `/25` | `bg-cf-{tone}/N` (no slot for these) |
| `bg-sidebar` | `bg-cf-sidebar` |
| `bg-sidebar-accent` (selected row) | `bg-cf-sidebar-row-selected` |
| `hover:bg-sidebar-accent/50`, `/60` (row hover) | `hover:bg-cf-sidebar-row-hover` |
| `text-sidebar-foreground`, `text-sidebar-accent-foreground` | `text-cf-sidebar-foreground` |
| `border-sidebar-border`, `ring-sidebar-ring` | `border-cf-sidebar-border`, `ring-cf-focus` |
| `bg-foreground/N`, `bg-muted-foreground/N`, `bg-accent/N` (no slot) | `bg-cf-text/N`, `bg-cf-text-muted/N`, `bg-cf-control-hover/N` |
| diff `+N` / `−N`, file status A / M / D | `text-cf-diff-addition` / `text-cf-diff-deletion`, `text-cf-diff-{addition,modified,deletion}` (R stays `text-cf-info`) |
| `var(--X)` in stylesheets and arbitrary values | `var(--cf-<slot X aliases>)` |
| `theme.vars["--pane"]`, `"--sheet"`, the ThemeChip strip | `theme.slots["--cf-surface"]`, `"--cf-canvas"`, `--cf-error/warning/success/info/accent` |

Contextual moves on top of the table:

- **Thread** (`thread.css`): the user bubble is `--cf-message-surface` (it was the same
  accent at 8% light / 14.5% dark, mixed in place); `.add` / `.del` and the PR diff counts
  read `--t-add` / `--t-del`, built from `--cf-diff-addition` / `-deletion` with the same
  light darkening as the status tones; the ok / fail chips are `--cf-success-surface` /
  `--cf-error-surface`; the `--t-*-500` tint helpers are gone.
- **Code and quotes** (`.cf-markdown` in index.css): inline code and `pre` are
  `--cf-code-background` in both schemes (light: surface-sunken, which `--muted` was; dark:
  the text at 5%, which thread.css and index.css each declared separately, the latter as
  white), so both `.dark` overrides are gone. Blockquotes are `--cf-quote-border`.
- **Tags** (`compose/tagStyle.ts`, TagView, QuoteGlyph, and PathChip / CiteChip with the same
  class): the accents are `var(--cf-…)`, and the six class strings that mixed into
  `var(--color-border)` / `var(--color-foreground)` read `var(--cf-border)` / `var(--cf-text)`.
  PR 1's note listed four: two more had the same mix. These resolved at `:root`, so a
  tag in a preview of the other scheme took the window's border and text; now they follow the
  scope.
- **Shiki theme** (`lib/codeTheme.ts`): the diff's added / deleted are the diff slots; modified
  stays `--cf-info` (`--cf-diff-modified` is the warning colour; switching would recolour
  @pierre/diffs' modified bars).
- **Terminal** (`terminal/theme.ts`) reads `--cf-surface` for its background, the window
  background (`lib/windowBackground.ts`) `--cf-canvas`.
- Five slot rule strings in `themes/slots.ts` said "text-muted" for the muted text slot; the
  guard reads that as the `text-muted` utility, so they say "the muted text" now.

## Guard

`src/design/guards.test.ts`, "colour guard", with `scanColours` / `scanStylesheet` in
`src/design/scan.ts`. Strict like the radius and type-role guards: no file under `src`
outside `components/ui/` may have a hit, and there is no allowlist. It reads string and
template literals (not comments or JSX text) in every scanned `.ts`/`.tsx`, and every
stylesheet under `src`, for:

- a shadcn colour utility, any prop and variant (`bg-card`, `hover:text-muted-foreground`,
  `bg-warning/10`, `[&>*]:bg-destructive`, `@apply border-border`); `text-link` is the type
  role and passes;
- `var(--<component name>)` (arbitrary values, style objects, stylesheet rules);
- Tailwind's `var(--color-*)`, which resolves at `:root` (PR 1's preview bug);
- a literal that is a whole component name (`"--pane"`: a theme-map or computed-style key).
  An object key is a declaration, not a use (COMPONENT_ALIASES), so it passes.

index.css's two defining blocks (`@theme inline` and the alias block) are skipped. Each hit
says what to use (`hover:bg-sidebar-accent` → `hover:bg-cf-sidebar-row-selected`).

Raw colours were already the palette guard's job (`lib/palette.test.ts`: no literal outside
its reasoned allowlist); it now scans index.css too, which no longer holds a colour of its
own (the dark code tint `oklch(1 0 0 / 5%)` was the last).

## Pixel differences accepted

Playwright WebKit, 1280×800, main and this branch side by side against two mock daemons,
GitHub Dark, GitHub Light, Catppuccin Mocha and Rosé Pine Dawn; scenes: dashboard with the
sidebar, the scripted thread (code block, table, tool rows, bubble), the thread with its
side panel, Settings, the MCP panel (status chips) and the Themes page (gallery chips).

- Sidebar, Settings: identical in all four themes.
- Thread and panel: identical in GitHub Light, Catppuccin Mocha and Rosé Pine Dawn. GitHub
  Dark's code blocks are at most 1/255 off (the slot stores the 5% text tint as `#…0d`,
  13/255; the old mix was exactly 5%).
- Resting chips that were `/15` (MCP and plugin status chips, linked-PR badges, the
  sidebar's workspace chip, the Themes gallery's sample chips, WorkspaceMembers, Cleanup,
  "Restart the daemon to apply") and the Model settings' `/12` tiles now sit on the 10%
  `-surface`: at most 11-12/255 per channel, a shade fainter. The surface rule stays at 10%:
  the `/10` sites (banners, PR tones, update chip at rest, error rows) outnumber the `/15`
  ones and stay exact, and the fainter tint slightly raises the contrast of the status text
  on it (PR 1 noted that text at 3.9-4.5:1 on its tint in 14 themes).
- Sidebar row hover: `sidebar-row-selected` at 50% (60% on the Projects and Pull Requests
  lists) over the sidebar is now `--cf-sidebar-row-hover`. Computed for all four themes and
  both Graphites: at most 0.5/255 for the 50% rows (hex rounding), at most 3/255 for the two
  page lists (their hover was a touch stronger than the sidebar's; one hover now).

## Rules moved

One, in `themes/slots.ts`: `--cf-sidebar-row-hover` was "sidebar mixed 5% toward the text"
and is now "sidebar-row-selected at 50% over the sidebar" (resolved after the selected row,
which moved above it). For a theme without overrides the two agree within 1/255 (OKLab mix
versus sRGB compositing). Graphite overrides only the selected row, so under the old rule
its hover stopped following it: Graphite Dark's hover would have been 15/255 off what
`hover:bg-sidebar-accent/50` painted, Light's 5.5/255. Now a theme that overrides the
selected row gets a matching hover without a second override. The `-surface` rules are
unchanged (above).

## Left out

- **Chart series colours** stay `lib/usage.ts`'s fixed per-model colours (palette
  allowlist, DESIGN.md): moving them onto `--cf-chart-*` would recolour both charts per
  theme. Gridlines, labels and the hover band are on slots. `--cf-chart-*` has no user yet.
- `--cf-sidebar-row-active` has no user: nothing has a pressed state distinct from selected.
- The light status-tone darkening in thread.css (`color-mix(… 85%, black)`) predates the
  slot guards, which already hold 4.5:1; dropping it is a visible change, left for later.
- Status text on its own `-surface` is not guarded yet (PR 1's note); the fainter `/15`
  chips help a little.
- Hover and faint tints (`/5`, `/7`, `/18`, `/25`, `/30`) and the text tints
  (`bg-cf-text/10`, ...) keep their opacity: no slot names those distinctions.

## Gotchas

- `components/themes` is not `themes/`: a migration script that skipped any path with
  `/themes` in it also skipped the gallery. Skip `src/themes` by its full path.
- A shadcn Button's default variant still carries `bg-primary` (components/ui is not
  migrated), so a test asserting the class of a rendered `Button` keeps the shadcn name
  (`surfaces/mcp.test.tsx`).
- tailwind-merge sorts `bg-cf-*` into the background-colour group like any other colour,
  so `cn("bg-accent", "bg-cf-control-hover")` keeps the slot (`design/roles.test.ts`).

## Verified

- `make check` green; `make gui-e2e` green; `make gui-build`.
- The pixel comparison above (main vs branch, 24 scenes).
