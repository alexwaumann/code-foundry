# Theme 1: semantic colour tokens and the terminal palette

First of five PRs towards a theme engine (users import Catppuccin, Dracula, ...). Goal of
this one: every colour the app needs has a CSS variable on `<html>`, so a theme is a set
of variable values. Frontend only; nothing visibly changes.

## What changed

- **Status tokens** in `gui/frontend/src/index.css`, `:root` (light) and `.dark`, exposed
  in `@theme inline` like the shadcn ones (`--color-x: var(--x)`), so `text-success`,
  `bg-warning/15`, `border-info` work as utilities: `--success`, `--warning`, `--info`,
  `--highlight` (each with `-foreground`), `--destructive-foreground`, `--link`.
- **Link colour**: `.cf-markdown a` uses `var(--link)`; the two hardcoded oklch rules
  (light and `.dark`) are gone.
- **Terminal palette** from variables: `--terminal-fg`, `--terminal-cursor`,
  `--terminal-cursor-accent`, `--terminal-selection`, `--terminal-selection-inactive`,
  `--terminal-ansi-0` .. `--terminal-ansi-15` (black, red, green, yellow, blue, magenta,
  cyan, white, then bright). The background is `--pane` itself; `--terminal-bg` is gone
  and its three users (`TerminalHost`, `ActionRunDialog`, `ActionTabParts`) use `bg-pane`.
- `src/terminal/theme.ts` builds the xterm `ITheme` from `getComputedStyle(<html>)`;
  `watchTerminalTheme` re-reads it on a `MutationObserver` over `<html>`'s `class`,
  `style` and `data-theme` and hands a changed palette to the renderer.
  `XtermRenderer` owns that watch, so the `colorScheme` option, `setColorScheme` and the
  scheme effect in `TerminalHost` are gone.
- **Theme root**: `syncDocumentScheme` (`src/lib/theme.ts`) also sets
  `data-theme="default"` on `<html>`. Nothing reads it yet; it is what the engine flips.
- **Menus**: `dropdown-menu.tsx` and `context-menu.tsx` drop `dark:bg-neutral-950` and
  use `bg-popover` like every other floating surface.

## Decisions

- **Names are shadcn's** (`success`, `warning`, `info`, `destructive-foreground`, ...)
  as theme generators (tweakcn and friends) emit them, so a published theme maps one to
  one. `--highlight` (violet: plan/agent accents) and `--link` have no shadcn
  equivalent; they are ours.
- **Values are the shades the components already use**: grep shows `text-X-600
  dark:text-X-400` is the dominant pair for every status colour, so the token is the
  600 shade in light and the 400 shade in dark (emerald, amber, sky, red, violet), in
  oklch copied from Tailwind's `theme.css`. `--destructive` already was red-600/red-400.
  `--link` is sky-600/sky-400, exactly the two removed link rules.
- **Foregrounds** (text on a solid fill; nothing uses them yet): near-white on the light
  600 fills, near-black on the dark 400 fills; warning is dark in both, white on
  amber-600 is too weak.
- **Terminal variables are hex**, not oklch. xterm 6 parses `#rgb`/`#rrggbb`/`rgba()`
  itself and everything else by painting a 1x1 canvas and reading the pixel back, which
  throws on anything not fully opaque. Hex is what terminal themes (Ghostty, iTerm,
  base16) ship in, and the canvas path stays a fallback only. `--pane` is hex for the
  same reason (it already was). Custom properties compute to their declared text, so
  `getPropertyValue` returns the hex as written; `--terminal-cursor-accent: var(--pane)`
  resolves to the pane's hex.
- **Popover colour**: dark `--popover` was `var(--pane)` (#080808) while the menus
  painted neutral-950 (#0a0a0a, measured live: 10,10,10 vs 8,8,8). Following "adjust the
  variable, not the component", dark `--popover` is now `oklch(0.145 0 0)`
  (neutral-950), so menus look exactly as before and popovers, tooltips, dialogs and the
  palette moved from #080808 to #0a0a0a (2/255, not visible). Light is unchanged
  (`var(--pane)`, white).
- **Watching the document, not the React scheme.** The scheme effect could run before
  `syncDocumentScheme` toggled the class (child effects run before `App`'s, and listener
  order on the media query is registration order), and would then read the old scheme's
  variables. A `MutationObserver` reads after the class flips whatever the order, and
  will also follow a later `data-theme` flip or inline variables. It compares the
  palette and skips no-op mutations (the zoom writes `--cf-zoom` to the same `style`).

## Gotchas

- Vitest returns an empty string for CSS imports, even `?raw`, and the frontend has no
  Node types, so a unit test cannot read `index.css`. `theme.test.ts` uses a stand-in
  stylesheet; jsdom does resolve custom properties from a `<style>` through
  `getComputedStyle`.
- The `.cf-markdown` task-list checkbox `accent-color` is still a literal (sky-600 in
  both schemes); pointing it at `--link` or `--info` would make it lighter in dark. Left
  for PR 2.
- Live check side effect: the isolated copy shares WebKit localStorage with the
  installed app, and on connect it hides open bottom panels whose shells its own daemon
  does not have (`closeEmptyPanels`).

## Verified

- `make check`; `make gui-e2e` (WebKit + Chromium): 757 passed, 36 skipped, 1 failed:
  `panel.spec.ts:851` on Chromium (the click on the Files tab after a drag did not
  activate it within 5 s). Unrelated to colours; it passed 5 of 5 with
  `--repeat-each=5` on its own.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`): an ANSI 0-15 test in a bottom
  shell plus the project row menu, dark and light (`theme-1-tokens/dark.png`,
  `light.png`). Terminal and pane both sample 8,8,8 in dark and 255,255,255 in light;
  switching `appearance.theme` with the shell open repaints it live both ways.

## PR 2

Sweep the ~300 hardcoded `text-amber-*`, `text-red-*`, `text-emerald-*`, `text-sky-*`,
`text-violet-*` (and their `bg-`/`border-` tints and `dark:` pairs) in components onto
`text-warning`, `bg-success/15`, `border-info/30` etc., where a `X-600 dark:X-400` pair
collapses into one token class. Shades that are not the 600/400 pair (amber-300 on dark
surfaces, amber-700, sky-500, `/90` alphas) need a decision per site: the token, or a
`color-mix` of it.
