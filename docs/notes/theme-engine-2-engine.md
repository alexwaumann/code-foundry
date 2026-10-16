# Theme engine 2: curated Ghostty themes and the engine

PR 2 of 4 of the theme engine (1: thread.css and `dark:` cleanup, 2: this, 3: Settings
picker + Wails window background, 4: follow-ups). A theme is one object with a fixed
scheme; 21 curated ones, generated at build time from Ghostty's theme files plus a small
override map, and applied by `data-theme` on `<html>`. Default: Catppuccin Mocha (dark) and
Catppuccin Latte (light). Frontend only.

## Files

| Path | What |
| --- | --- |
| `gui/frontend/themes/ghostty/` | the 19 Ghostty theme files, copied unchanged, plus `LICENSE` (iTerm2-Color-Schemes, MIT). The build never needs Ghostty installed |
| `gui/frontend/themes/overrides.json` | the curated list: per theme `name`, `ghostty` file (or `graphite`), `pair`, `upstream`, `accent`, `slots`, `status`, `vars`, `why` |
| `gui/frontend/themes/color.ts` | hand-rolled sRGB/OKLab/OKLCH maths, gamut mapping by chroma, mixes, WCAG contrast (no dependency) |
| `gui/frontend/themes/convert.ts` | the converter. `pnpm run themes` writes the two generated files; `pnpm run themes -- --refresh` first re-copies the Ghostty files from `/Applications/Ghostty.app` |
| `gui/frontend/src/themes/catalog.json`, `themes.css` | generated and committed |
| `gui/frontend/src/themes/index.ts` | the typed registry |
| `gui/frontend/src/lib/theme.ts` | the slots and the document sync |

`themes/` sits outside `src/` so the converter is never bundled. It is TypeScript run with
`tsx` (already a devDependency) rather than `.mjs`, so it typechecks under
`tsconfig.node.json` (now including `themes`) and the tests import it directly. Vitest
includes `themes/**/*.test.ts`.

## Catalog format

```json
[{ "id": "catppuccin-mocha", "name": "Catppuccin Mocha", "scheme": "dark",
   "pair": "catppuccin-latte", "source": "Catppuccin, github.com/…; Ghostty theme \"Catppuccin Mocha\" (iTerm2-Color-Schemes, MIT)",
   "vars": { "--sheet": "#131222", "--pane": "#1e1e2e", …, "--sh-str": "#a6e3a1" } }]
```

- `vars`: every colour variable index.css's `:root` declares (in its order; `--cf-zoom` and
  `--radius` are not colours), then thread.css's ten syntax colours (`--syn-*`, `--sh-*`).
  Every value is `#rrggbb`. Alpha borders (`oklch(1 0 0 / 11%)`) are painted over the pane
  into opaque hex; `var()` references are resolved.
- Order: dark themes, then light, each in overrides.json order (Catppuccin first, then
  Graphite).
- `themes.css`: per theme, `html[data-theme="id"] { color-scheme; …vars }` and, only
  where a guard or override changed a syntax colour, `html[data-theme="id"] .cf-thread {
  …those tokens }` (17 of 21 themes have one; Mocha patches keyword, comment and number). `html[data-theme]` (0,1,1) outranks
  `:root`/`.dark` (0,1,0) and `html[data-theme] .cf-thread` (0,2,1) outranks thread.css's
  `.cf-thread` / `.dark .cf-thread`, so neither stylesheet was edited for the switch and the
  import order does not matter. index.css imports themes.css.

### Catalog

| id | name | scheme | pair |
| --- | --- | --- | --- |
| `catppuccin-mocha` | Catppuccin Mocha | dark | catppuccin-latte |
| `graphite-dark` | Graphite Dark | dark | graphite-light |
| `dracula` | Dracula | dark | |
| `gruvbox-dark` | Gruvbox Dark | dark | gruvbox-light |
| `nord` | Nord | dark | |
| `tokyo-night` | Tokyo Night | dark | |
| `rose-pine` | Rosé Pine | dark | rose-pine-dawn |
| `atom-one-dark` | Atom One Dark | dark | atom-one-light |
| `solarized-dark` | Solarized Dark | dark | solarized-light |
| `monokai-pro` | Monokai Pro | dark | |
| `github-dark` | GitHub Dark | dark | github-light |
| `kanagawa-wave` | Kanagawa Wave | dark | |
| `everforest-dark-hard` | Everforest Dark Hard | dark | |
| `ayu-mirage` | Ayu Mirage | dark | |
| `catppuccin-latte` | Catppuccin Latte | light | catppuccin-mocha |
| `graphite-light` | Graphite Light | light | graphite-dark |
| `gruvbox-light` | Gruvbox Light | light | gruvbox-dark |
| `rose-pine-dawn` | Rosé Pine Dawn | light | rose-pine |
| `atom-one-light` | Atom One Light | light | atom-one-dark |
| `solarized-light` | Solarized Light | light | solarized-dark |
| `github-light` | GitHub Light | light | github-dark |

## Graphite and index.css

Graphite Light/Dark are the pre-engine neutral themes. The converter reads their values
(and the variable list) from index.css's `:root` and `.dark`, so the stylesheet fallback
and the catalog cannot drift, and a variable added to index.css fails the drift test
until the converter derives it. `:root`/`.dark` stay as they were (Graphite, oklch): they
only show when no `data-theme` is set (unit tests, before `App` mounts), and the app always
sets one.

Graphite goes through the same guards, which change Graphite Light only (Graphite Dark is
identical to before):

| variable | index.css (sRGB) | Graphite Light |
| --- | --- | --- |
| `--muted-foreground` | #737373 | #6d6d6d |
| `--destructive` | #e40016 | #dc0015 |
| `--success` | #009669 | #007d57 |
| `--warning` | #da7700 | #a55900 |
| `--info`, `--link` | #0084c7 | #0073ae |

They were under 4.5:1 on the #f0f0f0 sheet (sidebar rows); thread.css compensated for the
thread only with its 15% black mix. Every catalog value is sRGB hex, so Tailwind's
wide-gamut oklch status colours are gamut-mapped (a shade less saturated on a P3 display
than index.css's oklch).

## Derivation (Ghostty themes)

Scheme: OKLab L of `background` < 0.6 is dark. Mixes are OKLab (`color-mix(in oklab)`),
lightness shifts are OKLCH L with hue and chroma kept (chroma drops only to stay in gamut,
never a clip that changes hue).

| variable | rule |
| --- | --- |
| `--pane`, `--card` | `background` |
| `--sheet`, `--background`, `--sidebar`, `--sidebar-border` | pane, L −0.05 (dark) / −0.045 (light) |
| `--popover` | pane, L +0.03 (dark) / +0.02 (light; white stays white) |
| `--foreground` and every surface's `-foreground` | `foreground` (guarded, below) |
| `--muted`, `--accent`, `--secondary` | pane mixed 14% (dark) / 7% (light) toward fg: about Catppuccin's surface0. `--accent` stays the hover surface, not the brand colour |
| `--muted-foreground` | fg 68% / pane 32% (guarded) |
| `--sidebar-accent` | sheet mixed 10% toward fg |
| `--pane-border`, `--border`, `--input` | fg at 11/11/15% (dark), 8/10/13% (light) painted over the pane |
| `--primary` | the override's `accent` (fg when none) |
| `--primary-foreground` | pane or fg, whichever reaches 4.5:1, preferring the darker (dark text on light accents) |
| `--ring`, `--sidebar-ring` | primary 65% / pane 35% |
| `--sidebar-primary(-foreground)` | primary (and its foreground) |
| `--destructive`, `--success`, `--warning`, `--info`, `--highlight` | ANSI 1-5 on light, bright 9-13 on dark, unless `slots` or `status` override (guarded) |
| `--link` | info |
| status `-foreground` | pane or fg, as primary-foreground |
| `--chart-1..5` | fg mixed 10/35/50/65/80% toward the pane (greys) |
| `--terminal-fg`, `--terminal-cursor`, `--terminal-ansi-*` | straight from the file (the terminal stays faithful, even where the UI fg is lifted) |
| `--terminal-cursor-accent` | `cursor-text` if it is 3:1 on the cursor, else pane or fg (GitHub Dark's and Monokai's cursor-text vanish on their cursors) |
| `--terminal-selection` | `selection-background` (guarded); `-inactive` = selection 50% into the pane |
| syntax | thread.css's aliases (PR 1), parsed from its `.cf-thread` / `.dark .cf-thread` blocks: light keyword ANSI 1, function 5, type 4, comment 7; dark keyword 5, function 4, type 3, comment 8; both string 2, number 6, shell command 4, flag 6, string 2, `--syn-fg` = `--terminal-fg` (then guarded) |

## Guards (automatic, in `guard()`)

| guard | rule | fires on |
| --- | --- | --- |
| foreground | lift/darken L until 7:1 on the pane (UI only, not `--terminal-fg`) | Solarized Dark (4.8), Solarized Light (4.1), Rosé Pine Dawn (6.7) |
| grey bright slot | on dark themes, a bright slot with less than half the normal slot's chroma uses the normal slot | Solarized Dark (also pinned with `slots: normal`) |
| status text | step L away from the pane by 0.005 until 4.5:1 on the pane **and** the sheet | every light theme's yellow/green, Nord/Dracula/Gruvbox/Kanagawa red, Graphite Light |
| muted text | mix toward fg until 4.5:1 on pane and sheet | most light themes, Graphite Light |
| primary text | if neither pane nor fg reaches 4.5:1 on the accent, step the accent's L away from the better one | Solarized Dark (#268bd2 → #3093da), Solarized Light (→ #0075ba), Atom One Light (#4078f2 → #356be4), Rosé Pine Dawn (#907aa9 → #7d6795) |
| inverted selection | selection under 3:1 against the terminal fg → fg at 25% over the pane. xterm keeps the cell's colour, so a fg-coloured selection hides the text | GitHub Dark/Light, Gruvbox Light, Nord, Kanagawa, Ayu Mirage |
| code tokens | every syntax colour except comments at 4.5:1 on the pane and on `--muted` (code blocks) | light themes |
| comment | ANSI 8 under 3:1, or above 85% of fg's contrast (as dark as body text) → muted-foreground | Catppuccin Mocha, Tokyo Night, Nord, Solarized Dark, Monokai, Ayu (too faint); Atom One Light, Solarized Light, Rosé Pine Dawn (as dark as the text) |

The converter prints a contrast table (fg, muted on sheet, statuses, primary text, ΔL) on
every run.

## Overrides

| id | accent | other | why |
| --- | --- | --- | --- |
| `catppuccin-mocha` | #cba6f7 mauve | `slots: normal`; keyword mauve, number peach | Ghostty's bright slots are re-saturated copies; the normal slots are the official palette. Syntax as Catppuccin's style guide |
| `catppuccin-latte` | #8839ef mauve | keyword mauve, number peach | as Mocha |
| `graphite-dark/-light` | (today's neutral) | | values from index.css; syntax from thread.css's aliases of its ANSI palette (the old One Dark / GitHub light set) |
| `dracula` | #bd93f9 purple | `slots: normal`; info ANSI 6 (cyan) | Dracula's blue slot is the purple accent; info/link/Working would look like buttons |
| `gruvbox-dark` | #fe8019 | | |
| `gruvbox-light` | #af3a03 | `slots: bright` | its bright slots are the darker "faded" set meant for light backgrounds |
| `nord` | #88c0d0 frost | | guards fix red and the selection |
| `tokyo-night` | #7aa2f7 | | |
| `rose-pine` | #c4a7e7 iris | success #95b1ac (leaf) | Rosé Pine has no green; its ANSI green is pine (blue-teal) |
| `rose-pine-dawn` | #907aa9 iris | success #6d8f89 (leaf), info ANSI 4 (foam) | as Rosé Pine |
| `atom-one-dark` | #61afef | | |
| `atom-one-light` | #4078f2 | | guards fix the pale yellow and the black comments |
| `solarized-dark` | #268bd2 | `slots: normal` | bright slots are greys (and bright red is orange) |
| `solarized-light` | #268bd2 | | guards lift everything to the floor |
| `monokai-pro` | #ffd866 yellow | info ANSI 6 (cyan), warning ANSI 4 (orange) | the accent is also its ANSI yellow; Monokai's ANSI blue is orange |
| `github-dark` | #4493f8 | | |
| `github-light` | #0969da | warning #9a6700 | its ANSI yellow is near-black brown #4d2d00 |
| `kanagawa-wave` | #7e9cd8 crystalBlue | | |
| `everforest-dark-hard` | #a7c080 green | `slots: normal` | its bright slots are the light variant's darker colours |
| `ayu-mirage` | #ffad66 orange | | distinct from its yellow warning |

## lib/theme.ts API (for PR 3)

```ts
setThemePreference(p: "system" | "dark" | "light")   // unchanged (appearance.theme)
setThemeSlots({ light?: string, dark?: string })      // ids; unknown or other-scheme ids fall back to
                                                      // catppuccin-latte / catppuccin-mocha; a missing key keeps the slot
themeSlots(): { light: string; dark: string }
useThemeSlots(): { light: string; dark: string }
activeTheme(): Theme                                  // the effective scheme's slot
useActiveTheme(): Theme
syncDocumentScheme(): () => void                      // App.tsx; sets data-theme, .dark (from the theme's scheme), color-scheme
```

`src/themes`: `themes`, `themeById`, `themesFor(scheme)`, `DEFAULT_LIGHT`, `DEFAULT_DARK`,
`type Theme { id, name, scheme, pair?, source, vars }`. Slots are not persisted yet; PR 3
adds the settings and calls `setThemeSlots` from `stores/settings.ts` the way
`setThemePreference` is called today. `DEFAULT_THEME = "default"` is gone.

## What the tests assert

- `themes/convert.test.ts` (Node environment): the committed `catalog.json` and
  `themes.css` equal a fresh in-memory build (drift fails CI); every theme has exactly
  index.css's colour variables plus the syntax ones; every Ghostty file is vendored, with
  the licence; pairs point both ways across schemes; table tests for the parser, scheme
  detection, slot fallback, status overrides, the fg, selection, comment and primary guards.
- `src/themes/contrast.test.ts`, for every catalog theme: all values `#rrggbb`; fg ≥ 7:1 on
  the pane; muted-foreground ≥ 4.5:1 on pane and sheet; destructive, success, warning, info,
  highlight and link ≥ 4.5:1 on pane and sheet; primary-foreground ≥ 4.5:1 on primary;
  sheet/pane ΔL ≥ 3%; popover ΔL ≥ 1% from the pane (except a white pane: Graphite Light and
  GitHub Light rely on the shadow and border, as before); terminal fg ≥ 3:1 on the
  selection; comments ≥ 3:1; the scheme matches the background. Plus: 21 themes, dark
  first, Catppuccin first in each, defaults exist with the right scheme.
- `src/lib/theme.test.ts`: slot validation (table), active theme per preference, and the
  document sync following preference, slots and the macOS appearance.
- `src/terminal/theme.test.ts`: a `data-theme` flip repaints the terminal palette.

## Gotchas

- **Launch flash.** `gui/main.go`'s window `BackgroundColour` is still black (Graphite's
  sheet), so the window shows black before Mocha's #131222 sheet paints (and before Latte
  in light, as Graphite Light did). PR 3 sets the window colour from the active theme.
- **The user bubble** (PR 1, #122) is `color-mix(var(--primary) 8%/11%)` light and
  14.5%/15.5% dark, so it takes the accent. Checked on the most saturated accents (Mocha
  mauve, Dracula purple, Gruvbox orange, Monokai yellow, Ayu orange, Latte mauve): a tint,
  not loud. Gruvbox's orange is the strongest (a warm brown) and stays readable, so the
  thread.css alphas are unchanged.
- **Syntax follows thread.css.** PR 1 made `--syn-*`/`--sh-*` aliases of terminal slots,
  picked by the `dark` class. The converter parses those aliases (so the slot choice lives
  in one place), resolves them on each theme's palette, guards them, and emits only the
  tokens that changed, on `html[data-theme] .cf-thread`, which outranks `.dark .cf-thread`.
  `syncDocumentScheme` sets `.dark` from the active theme's scheme, so a dark theme always
  gets the dark slots. Light thread status tones still mix 15% black over the (already
  guarded) tokens, a step darker than needed; thread.css's call, left as is.
- **JSON imports** needed `resolveJsonModule` in `tsconfig.app.json`.
- **The Haiku model id** `claude-4.5-haiku[1m]` (the work laptop's Bedrock id) is refused
  on this machine; the live thread used `claude-haiku-5-5[1m]`.
- Vitest's jsdom returns CSS imports empty (theme-1's gotcha), so the drift test runs in the
  Node environment and reads files with `fs`.

## Verified

- `make check` green.
- `make gui-e2e` (before the rebase onto PR 1): 786 passed, 40 skipped, 6 failed:
  `archive.spec.ts:135`, `snooze.spec.ts:150` and `:251` in both browsers. They fail the
  same way on a clean `origin/main` (they still expect the thread to stay selected after
  archiving/snoozing, which #119 changed to the dashboard): not this PR.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, a Haiku thread in a scratch repo, a
  bottom shell printing ANSI 0-15): default dark is Catppuccin Mocha (mauve New thread and
  send buttons, Mocha surfaces, Catppuccin syntax, Mocha ANSI), `settings set
  appearance.theme light` repaints the window and the shell to Latte live.
- Other themes: Vite dev server against the same daemon in Playwright WebKit, calling
  `setThemeSlots` + `setThemePreference` in the page: Dracula, Gruvbox Dark, Nord, Rosé Pine
  Dawn, Solarized Light. Terminal, syntax and primary follow each switch.
