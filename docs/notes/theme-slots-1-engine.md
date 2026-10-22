# Theme slots 1: the three-tier engine

PR 1 of the theme-slots series (1: this, the engine; 2: move components from the shadcn
names onto the slots; later: publish the resolved map to frames, user overrides). Frontend
only. Goal: no visible change. Themes get small, a slot can be overridden on its own, and
a theme is one file the model can write.

The rules and slot list below are this PR's. theme-slots-3-hardening.md changed several (status
fills and `-text`, distinct control steps, guarded focus and sidebar rows, 72 `--cf-*` slots);
the current file format and slot list are in docs/THEMES.md.

## The three tiers

1. **Base**: what a theme file must give (`ThemeBase` in `src/themes/slots.ts`):
   `canvas`, `surface`, `text`, `accent`, one colour each for `success`, `warning`,
   `error`, `info`, `highlight`, optional `link`, and `terminal: { foreground, cursor?,
   cursorText?, selection?, ansi[16] }`. Every base colour is `#rrggbb`.
2. **Semantic slots**: 67 `--cf-*` slots plus the 21 terminal and 10 syntax colours (98
   in all), derived from the base at load time by the rules in `SLOTS`
   (`src/themes/slots.ts`), each overridable per theme.
3. **Component names**: the shadcn and shell variables (`--card`, `--primary`, `--pane`,
   `--sidebar-accent`, ...), 44 of them, declared in `index.css` as `var()` aliases of
   slots. No theme sets them; `COMPONENT_ALIASES` lists the same pairs and
   `src/design/slots.test.ts` checks both ways.

Rule for the semantic set: a slot exists only when two unrelated components need the same
distinction; anything else derives from the slots that exist.

### Naming

`--cf-<slot>`, where the slot name is the one in the list below. The group (surfaces, text,
interactive, sidebar, thread, status, diff, charts) is metadata in the registry (`group`)
rather than a name segment, except where the name would be ambiguous without it
(`sidebar-*`, `message-*`, `code-*`, `diff-*`, `chart-*`). A status is a triple:
`--cf-<tone>` (solid, also its text colour), `--cf-<tone>-foreground` (text on a solid
fill) and `--cf-<tone>-surface` (a tint). The terminal and syntax palettes keep their
names (`--terminal-*`, `--syn-*`, `--sh-*`). Note `--cf-accent` is the brand colour (shadcn's
`--primary`); shadcn's `--accent` is the hover surface and aliases `--cf-control-hover`.

Values are `#rrggbb`, or `#rrggbbaa` for the tints (accent-surface, selection, the status
and diff surfaces, message-surface, dark code-background), so a tint composites over
whatever it sits on, as `bg-success/10` does today. Component, terminal and syntax values
are always opaque (xterm needs hex; contrast.test.ts checks).

## Theme file format

```json
{ "id": "rose-pine-dawn", "name": "Rosé Pine Dawn", "scheme": "light", "pair": "rose-pine",
  "source": "Rosé Pine, …; Ghostty theme \"Rose Pine Dawn\" (iTerm2-Color-Schemes, MIT)",
  "base": { "canvas": "#ebe5de", "surface": "#faf4ed", "text": "#575279", "accent": "#907aa9",
            "success": "#6d8f89", "warning": "#ea9d34", "error": "#b0405a", "info": "#56949f",
            "highlight": "#907aa9",
            "terminal": { "foreground": "#575279", "cursor": "#575279", "cursorText": "#faf4ed",
                          "selection": "#dfdad9", "ansi": ["#f2e9e1", …16] } } }
```

(Rosé Pine Dawn has no overrides; a theme that wants one adds e.g. `"overrides":
{ "--cf-sidebar-row-selected": "#e4dcd2" }`.)

- `overrides` are final values (`#rrggbb` or `#rrggbbaa`), applied as each slot resolves,
  so a slot derived later from an overridden one follows it (override `--cf-surface` and
  `--cf-surface-raised`, the sunken and border mixes follow). They are not guarded: a
  user who overrides a slot gets that colour.
- `parseThemeFile(json)` checks and normalises a file (scheme, 9 base colours, 16 ANSI,
  override keys must be slots: `--card` is refused). The converter runs every curated
  theme through it.
- `src/themes/catalog.json` is the curated themes as theme files, generated and committed.
  `themes/convert.ts` fills only the base from a Ghostty file (canvas = background at OKLCH
  L −0.05 dark / −0.045 light; statuses from ANSI 9-13 dark / 1-5 light, or the override's
  `slots` / `status` picks; text, statuses and selection as the file has them: the rules
  guard them) or takes a literal `base` (Graphite). `overrides.json`'s `vars` became
  `overrides`, its `destructive` status key `error`, and Graphite's `graphite: "dark"`
  a literal `scheme` + `base`.

## Runtime

- `src/themes/index.ts`: `Theme` = the file plus `slots` (resolved slots) and `vars` (slots
  plus the component names as the aliases compute them, so `ThemeChip`,
  `windowBackground`, `codeTheme` and the e2e specs read `--pane` / `--primary` / `--syn-kw`
  unchanged). Both are resolved lazily on first read and cached; resolving all 22 themes
  takes a few milliseconds.
- `lib/theme.ts` `syncDocumentScheme` sets every slot inline on `<html>` (plus `data-theme`,
  the `dark` class and `color-scheme`, as before) and stores `{ id, vars }` under
  `cf.theme.slots` for the first paint.
- **Export for frames (next PR)**: `activeThemeSlots()` (the active theme's resolved map,
  the same object until the theme changes), `useActiveThemeSlots()` and
  `subscribeThemeSlots(cb)` (called now and on every change of the active theme only). No
  daemon call yet.
- `components/themes/ThemeScope.tsx` sets the previewed theme's slots inline on its element.
- `themes.css` is gone: everything it held is a variable now. thread.css no longer declares
  `--syn-*` / `--sh-*` (the rules pick the ANSI slot per scheme, as its `.cf-thread` /
  `.dark .cf-thread` aliases did), and index.css no longer has Graphite's `:root` / `.dark`
  colour blocks.

## The slots and their rules

Scheme-dependent numbers are "dark / light". "Guarded" steps OKLCH lightness away from the
surface (hue and chroma kept) until the ratio holds, as the converter's guards did.

### surfaces (9)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-canvas` | base.canvas | `--sheet`, `--background` |
| `--cf-surface` | base.surface | `--pane` |
| `--cf-chrome` | canvas (the sidebar and title band sit on the sheet) |  |
| `--cf-surface-raised` | surface (cards and the composer are the pane's colour) | `--card` |
| `--cf-surface-overlay` | surface, OKLCH L +0.03 dark / +0.02 light (menus, popovers, dialogs) | `--popover` |
| `--cf-surface-sunken` | surface mixed 14% dark / 7% light toward the text (wells, code blocks) | `--muted` |
| `--cf-border` | text at 11% dark / 10% light over the surface | `--border` |
| `--cf-border-strong` | text at 18% dark / 16% light over the surface |  |
| `--cf-divider` | text at 11% dark / 8% light over the surface (pane outlines, header rules) | `--pane-border` |

### text (7)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-text` | base.text, lightness stepped away from the surface until 7:1 on it | `--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` |
| `--cf-text-muted` | text mixed 32% toward the surface, then back toward the text in 5% steps until 4.5:1 on the surface and the canvas | `--muted-foreground` |
| `--cf-text-secondary` | halfway between text and text-muted (so never fainter than muted) |  |
| `--cf-placeholder` | text-muted |  |
| `--cf-icon` | text (icons take their label's colour) |  |
| `--cf-icon-muted` | text-muted |  |
| `--cf-link` | base.link guarded as a status colour; info when absent | `--link` |

### interactive (10)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-accent` | base.accent; if neither the surface nor the text reaches 4.5:1 on it, its lightness steps away from the better one until it does | `--primary`, `--sidebar-primary` |
| `--cf-accent-foreground` | text on the accent: the surface or the text, whichever reads (darker preferred) | `--primary-foreground`, `--sidebar-primary-foreground` |
| `--cf-accent-surface` | accent at 10% alpha (a selected tile, a chip) |  |
| `--cf-accent-surface-foreground` | accent, stepped away from the surface until 4.5:1 on accent-surface over the surface |  |
| `--cf-focus` | accent mixed 35% toward the surface (focus rings) | `--ring`, `--sidebar-ring` |
| `--cf-input` | text at 15% dark / 13% light over the surface (field borders) | `--input` |
| `--cf-control` | surface mixed 14% dark / 7% light toward the text (a secondary button at rest) | `--secondary` |
| `--cf-control-hover` | surface mixed 14% dark / 7% light toward the text (a hovered ghost button or menu row) | `--accent` |
| `--cf-control-active` | surface mixed 20% dark / 11% light toward the text (pressed) |  |
| `--cf-selection` | accent at 25% alpha (selected text) |  |

### sidebar (7)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-sidebar` | chrome | `--sidebar` |
| `--cf-sidebar-foreground` | text | `--sidebar-foreground`, `--sidebar-accent-foreground` |
| `--cf-sidebar-muted-foreground` | text-muted (already 4.5:1 on the canvas) |  |
| `--cf-sidebar-row-hover` | sidebar mixed 5% toward the text |  |
| `--cf-sidebar-row-selected` | sidebar mixed 10% toward the text | `--sidebar-accent` |
| `--cf-sidebar-row-active` | sidebar mixed 15% toward the text |  |
| `--cf-sidebar-border` | sidebar (no visible edge) | `--sidebar-border` |

### thread (5)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-message-surface` | accent at 14.5% dark / 8% light alpha (the user's bubble) |  |
| `--cf-message-foreground` | text |  |
| `--cf-code-background` | text at 5% alpha dark; surface-sunken light |  |
| `--cf-code-foreground` | syn-fg |  |
| `--cf-quote-border` | border |  |

### status (18)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-success` | base.success, lightness stepped away from the surface until 4.5:1 on the surface and the canvas | `--success` |
| `--cf-warning` | base.warning, lightness stepped away from the surface until 4.5:1 on the surface and the canvas | `--warning` |
| `--cf-error` | base.error, lightness stepped away from the surface until 4.5:1 on the surface and the canvas | `--destructive` |
| `--cf-info` | base.info, lightness stepped away from the surface until 4.5:1 on the surface and the canvas | `--info` |
| `--cf-highlight` | base.highlight, lightness stepped away from the surface until 4.5:1 on the surface and the canvas | `--highlight` |
| `--cf-success-foreground` | text on a solid success fill: the surface or the text, whichever reads (darker preferred) | `--success-foreground` |
| `--cf-success-surface` | success at 10% alpha (a badge or banner tint over any surface) |  |
| `--cf-warning-foreground` | text on a solid warning fill: the surface or the text, whichever reads (darker preferred) | `--warning-foreground` |
| `--cf-warning-surface` | warning at 10% alpha (a badge or banner tint over any surface) |  |
| `--cf-error-foreground` | text on a solid error fill: the surface or the text, whichever reads (darker preferred) | `--destructive-foreground` |
| `--cf-error-surface` | error at 10% alpha (a badge or banner tint over any surface) |  |
| `--cf-info-foreground` | text on a solid info fill: the surface or the text, whichever reads (darker preferred) | `--info-foreground` |
| `--cf-info-surface` | info at 10% alpha (a badge or banner tint over any surface) |  |
| `--cf-highlight-foreground` | text on a solid highlight fill: the surface or the text, whichever reads (darker preferred) | `--highlight-foreground` |
| `--cf-highlight-surface` | highlight at 10% alpha (a badge or banner tint over any surface) |  |
| `--cf-update` | info (the update chip's available state) |  |
| `--cf-update-foreground` | info-foreground |  |
| `--cf-update-surface` | info-surface |  |

### diff (5)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-diff-addition` | success |  |
| `--cf-diff-addition-surface` | success at 12% alpha |  |
| `--cf-diff-deletion` | error |  |
| `--cf-diff-deletion-surface` | error at 12% alpha |  |
| `--cf-diff-modified` | warning (the M of a file's status) |  |

### charts (6)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--cf-chart-1` | info | `--chart-1` |
| `--cf-chart-2` | highlight | `--chart-2` |
| `--cf-chart-3` | success | `--chart-3` |
| `--cf-chart-4` | warning | `--chart-4` |
| `--cf-chart-5` | error | `--chart-5` |
| `--cf-chart-6` | ANSI 6 (cyan), or the accent when cyan is within 30° of info's hue; stepped to 3:1 on the surface |  |

### terminal (21)

| slot | rule |
| --- | --- |
| `--terminal-fg` | base.terminal.foreground (not guarded: the terminal stays faithful) |
| `--terminal-cursor` | base.terminal.cursor, else the terminal foreground |
| `--terminal-cursor-accent` | base.terminal.cursorText if 3:1 on the cursor, else the surface or the terminal foreground, whichever reads |
| `--terminal-selection` | base.terminal.selection (else the foreground 20% over the surface); under 3:1 against the foreground, the foreground 25% over the surface |
| `--terminal-selection-inactive` | selection mixed 50% into the surface |
| `--terminal-ansi-0` .. `-15` | base.terminal.ansi[0..15] |

### syntax (10)

| slot | rule | component names aliased to it |
| --- | --- | --- |
| `--syn-fg` | terminal foreground, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--syn-kw` | ANSI 1 light / 5 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--syn-fn` | ANSI 5 light / 4 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--syn-type` | ANSI 4 light / 3 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--syn-str` | ANSI 2 light / 2 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--syn-num` | ANSI 6 light / 6 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--sh-cmd` | ANSI 4 light / 4 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--sh-flag` | ANSI 6 light / 6 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--sh-str` | ANSI 2 light / 2 dark, stepped to 4.5:1 on the surface and surface-sunken |  |
| `--syn-com` | ANSI 7 light / 8 dark; text-muted when under 3:1 on the surface or above 85% of the text's contrast |  |

## Overrides in the curated themes

The rules are the converter's old derivation and guards moved to runtime, so 18 of the 22
themes resolve to exactly the colours they had and need no override. The one-time check
compared every component and terminal/syntax value against main's catalog (OKLab ΔE; an
override where ΔE ≥ 0.02).

| theme | overrides | why |
| --- | --- | --- |
| Catppuccin Mocha | `--syn-kw` #cba6f7, `--syn-num` #fab387 | Catppuccin's syntax guide (mauve keywords, peach numbers), as before |
| Catppuccin Latte | `--syn-kw` #8433ea, `--syn-num` #b24200 | the same, darkened to 4.5:1 at the same hue: the old converter guarded its `vars`; overrides are final now, so they carry the guarded values |
| Graphite Dark | `--cf-accent-foreground` #171717, `--cf-focus` #737373, `--cf-sidebar-row-selected` #1e1e1e, `--terminal-selection-inactive` #2c3446 | hand-picked neutral greys (index.css `.dark` before this PR), not derived |
| Graphite Light | `--cf-text-muted` #6d6d6d, `--cf-surface-sunken`, `--cf-control`, `--cf-control-hover` #f5f5f5, `--cf-focus` #a1a1a1, `--cf-input` #e5e5e5, `--cf-sidebar-row-selected` #e1e1e1 | the same, from `:root` |

13 overrides in 4 themes. `themes/convert.test.ts` pins this list: a new override has to
be added there and here with its reason.

Accepted differences (all Graphite, which is hand-made):

- Component names that alias `--cf-text` lose Graphite's second near-black: Light's
  `--secondary-foreground`, `--accent-foreground`, `--sidebar-accent-foreground` #171717 →
  #0a0a0a; the `*-foreground` near-whites #fafafa → #ffffff (Light) and near-blacks #0a0a0a →
  #080808 (Dark). The component tier is never customised, so these cannot be overridden.
  The pixel diff shows them only as antialiasing on the glyphs of the selected sidebar row
  and the primary buttons.
- Graphite Light `--warning-foreground` #171717 → #ffffff: the old value was the
  hand-written one and only 3.9:1 on its #a55900 fill; the rule's white is 5:1.
- Graphite Dark's `--secondary`/`--muted`/`--accent` #262626 → #222222, `--popover` #0a0a0a
  → #0e0e0e and Light's `--terminal-selection-inactive` are under ΔE 0.02 (at most 4/255 per
  channel in the screenshots).
- `--chart-1..5` were greys and are now the categorical `--cf-chart-*`; nothing uses
  them (charts use `lib/usage.ts`'s fixed colours). Graphite Dark's `--sidebar-primary`
  (#1447e6) is now its accent; nothing uses it either.

## Gotchas

- **A var() alias resolves where it is declared.** `:root { --card: var(--cf-surface-raised) }`
  computes at the root and inherits as a value, so a preview scope that only set
  `--cf-*` would still get the window's `--card`. The alias block is declared on
  `:root, [data-theme-scope]`.
- **Tailwind's `--color-*` resolve on :root too.** The type roles read
  `var(--color-foreground)`, which Tailwind declares once on `:root`; inside a preview of
  the other scheme (a dark theme in the light window's Themes page) every role-coloured
  text took the window's colour, dark on dark. This was already the case on main (the
  live shots for this PR caught it). The roles now read `--foreground`,
  `--muted-foreground` and `--link`, which the alias block re-declares on every scope;
  identical outside previews (the pixel comparison is unchanged), and
  `src/design/slots.test.ts` refuses `var(--color-` in index.css's rules. Four component
  class strings still mix `--color-foreground` / `--color-border` into a tag's tint
  (compose/QuoteGlyph.tsx, compose/TagView.tsx, compose/tagStyle.ts): only visible in a
  preview, left for the migration PR, which moves components off these names anyway.
- **Inline slots on `<html>` lose to a declaration on a descendant.** thread.css declared
  the syntax colours on `.cf-thread`; they had to go (the rules own them) or they would
  shadow the theme's. `src/design/slots.test.ts` now refuses any stylesheet declaring a
  slot or a component name outside the alias block.
- **First paint.** There is no CSS fallback colour any more. index.html's inline script
  applies the stored slots when they belong to the theme it picks; on the very first
  launch (nothing stored) the first frame is the window's background colour
  (gui/windowbg.go keeps it on the theme's sheet) until App mounts, which is what showed
  through before the page painted anyway.
- **Overrides are final, guards are rules.** The old `vars` in overrides.json were guarded
  after being applied; overrides are not, so Latte's syntax overrides carry the guarded
  hex. A theme the model writes gets exactly what it asks for in `overrides`, and the
  guards for everything it leaves to the base.
- **text-secondary** was first "text mixed 20% toward the surface" and fell under 4.5:1 on
  Latte, Rosé Pine Dawn and Solarized Light; it is now halfway between text and text-muted,
  so it can never be fainter than muted.
- **Status text on its own tint** (`text-{tone}` on `bg-{tone}/10`, the badge pattern in
  pr/tones.ts) is 3.9-4.5:1 in 14 themes, mostly the red. Unchanged by this PR (it is how
  the app paints today); the migration PR should guard `-surface` text or step the tone.
- `color.ts` moved from `gui/frontend/themes/` to `src/themes/` so the app bundles it; the
  converter imports it from there. `parseCss` (only used to read Graphite out of index.css)
  is gone, and `withAlpha` / `flatten` are new.
- `lib/palette.test.ts` scans test files for arbitrary-colour classes too, so the new
  guard's own example is assembled from two strings.
- The pixel comparison ran main and this branch side by side against two mock daemons;
  differences in the sidebar's row block between runs were the mock's Working section
  reordering, not colour (the same themes compared clean on another run).

## Verified

- `make check` green; `make gui-e2e` green.
- Pixel comparison, Playwright WebKit at 1280×800, main vs this branch against the mock
  daemon, four scenes per theme (dashboard, a rendered thread with code and a table, the
  Themes page with its gallery and terminal sample, Settings → Appearance): GitHub Dark,
  GitHub Light, Catppuccin Mocha and Rosé Pine Dawn are identical pixel for pixel in all
  four scenes; all 22 themes were compared, and only Graphite differs (above).
- `make gui-build`, then the built app on an isolated `CODE_FOUNDRY_HOME`: the Themes page
  in dark and light (shots in the PR body).
