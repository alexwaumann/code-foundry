# Theme engine 1: last literal colours onto tokens

First of four theme engine PRs. The five theme PRs (`theme-1-tokens.md` ..
`theme-5-cleanup.md`) put every colour behind a CSS variable; a few literals and
scheme-bound tints were left in the thread's stylesheet and in a handful of classes. This
PR moves them onto tokens, so a theme that sets the variables on `<html>` recolours them
too. No visible change in the default theme (measured, see Verified). Frontend only;
index.css is untouched (PR 2 restructures it).

## What changed

| Where | Was | Now |
| --- | --- | --- |
| `thread/thread.css` `--syn-*`, `--sh-*` | hex copies of the terminal palette | `var(--terminal-fg)` / `var(--terminal-ansi-N)`, the slot each hex already was (table below) |
| `thread/thread.css` `--t-bubble`, `--t-bubble-border` | `oklch(0 0 0 / 7%)`, `/ 10%`; dark `oklch(1 0 0 / 13%)`, `/ 14%` | `color-mix(in oklab, var(--primary) N%, transparent)`: light 8% / 11%, dark 14.5% / 15.5% |
| `thread/thread.css` `--t-hover` and the ten other tints (code background, tool chips, question header, terminal box, diff header, command box, outline button, interrupt) | `oklch(0 0 0 / x)` light, `oklch(1 0 0 / x)` dark | `color-mix(in oklab, var(--foreground) x, transparent)`, same alpha |
| `ui/radio-group.tsx` tile, `actions/ActionDialog.tsx` command row | `dark:bg-white/[0.035]` | `dark:bg-foreground/[0.035]` |
| `ui/button.tsx` destructive | `text-white` | `text-destructive-foreground dark:text-foreground` |
| `lib/palette.test.ts` | TypeScript only; `white`/`black` classes not caught | also white/black classes and the component stylesheets (below) |
| `vite.config.ts` | | `test.css.include: [/\.css\?raw$/]` so the guard can read stylesheets |

`lib/usage.ts`'s model colours stay as they are: a colour there identifies a model, not a
theme. It was already on the guard's allowlist (`light: ` entry), so nothing changed there.

### Syntax slots

The thread's highlighter colours were drawn from GitHub light and One Dark, and the two
use different ANSI slots for the same role, so the alias is per scheme (as the hex was):

| Variable | Light | Dark |
| --- | --- | --- |
| `--syn-fg` | `--terminal-fg` | `--terminal-fg` |
| `--syn-kw` | ansi-1 | ansi-5 |
| `--syn-fn` | ansi-5 | ansi-4 |
| `--syn-type` | ansi-4 | ansi-3 |
| `--syn-str` | ansi-2 | ansi-2 |
| `--syn-com` | ansi-7 | ansi-8 |
| `--syn-num` | ansi-6 | ansi-6 |
| `--sh-cmd` / `--sh-flag` / `--sh-str` | ansi-4 / 6 / 2 | same |

`.cf-thread` declares the light slots, `.dark .cf-thread` overrides kw, fn, type and com.
The variables resolve on `.cf-thread`, so a `[data-theme]` block that sets
`--terminal-*` on `<html>` recolours code blocks, shell commands and the terminal at once.

### Bubble alphas

The brief suggested 12% / 18% of `--primary`. Measured against today's greys over the pane
(#fff light, #080808 dark), that darkens the light bubble from 237 to 227 and its border
from 230 to 213, which you can see. The alphas that land on today's values with the
default's neutral primary (oklch 0.205 light, 0.922 dark) are 7.7% / 11% light and
14.5% / 15.6% dark; rounded to 8% / 11% and 14.5% / 15.5%. With a coloured `--primary`
(PR 2) the bubble becomes a faint accent tint, a bit stronger in dark.

## `dark:` variants

None of the remaining `dark:` classes names a literal colour. Every one picks a different
token or alpha for the dark scheme:

- **`components/ui/` (shadcn's own, kept as generated):** `dark:bg-input/30`,
  `dark:hover:bg-input/50`, `dark:border-input` (button outline, input, textarea, select,
  checkbox, radio-group, tabs), `dark:aria-invalid:ring-destructive/40`,
  `dark:bg-destructive/60` and `dark:focus-visible:ring-destructive/40` (destructive button),
  `dark:data-[variant=destructive]:focus:bg-destructive/20` (dropdown and context menu),
  `dark:hover:bg-accent/50` (ghost button), `dark:aria-[checked=false]:bg-input/80` and the
  thumb's `dark:group-aria-*:bg-primary-foreground` / `bg-foreground` (switch),
  `dark:aria-checked:bg-primary` (checkbox), `dark:[[data-slot=tooltip-content]_&]:bg-background/10` (kbd),
  `dark:data-[state=active]:border-input` / `bg-input/30` (tabs). Keeping shadcn's
  classes keeps `pnpm dlx shadcn add` diffs small, and they are all token alphas.
- **radio-group tile** (`dark:border-transparent`, `dark:bg-foreground/[0.035]`,
  `dark:aria-checked:*`) and **ActionDialog's command row** (`dark:border-transparent
  dark:bg-foreground/[0.035]`): the dark look swaps a hairline for a faint fill.
- **The new `dark:text-foreground` on the destructive button:** dark's
  `--destructive-foreground` is near-black (for text on solid red-400), but this button is
  `bg-destructive/60` in dark, a dim red where light text reads. `--foreground` is the
  0.985 the old `text-white` was.
- **Panel and toolbar toggles** (`SidePanel`, `PanelToggle`, `PanelExpand`, `BottomToggle`,
  `BottomPanel`, `ActionsMenu`, `ActionTabParts`, `McpSurface`, `SidebarToolbar`,
  `SidebarStatus`, `AgentsStrip`, `PullRequestSurface`, `ReviewButton`, `HelpOverlay`): a
  stronger `accent`/`input`/`muted`/`info` alpha (or `sidebar-accent`) in dark, because the
  dark pane is only 8/255 above the sheet and light's alpha disappears there.
- **Usage chart** (`usage.ts`, `UsageChart.tsx` `dark:fill-(--sw-d)`, `dark:bg-(--sw-d)`):
  the model colour table's dark column (allow-listed data).

The `.dark .cf-thread …` rules in thread.css are the same kind: each sets a
`--foreground` alpha (or a shadow strength) for the dark scheme. `.dark .cf-backdrop-art`
(opacity 0.38 vs 0.22) is an image strength, not a colour.

## Guard

`palette.test.ts` adds:

- **white/black classes** (`text-white`, `bg-black/40`, `dark:bg-white/[0.035]`) in
  TypeScript, with allowlist entries: the dialog scrim (`ui/dialog.tsx` `bg-black/40`), the
  two image lightbox scrims (`AttachmentPreview`, `UserBubble` `bg-black/80`), the remove
  button on an attachment thumbnail (`Composer` `bg-black/70 text-white`: it sits on an
  image) and the initials on a project's identity tile (`ProjectRows` `text-white` on the
  hashed hue);
- **component stylesheets** (`src/components/**/*.css`): hex, colour functions
  (`oklch(`, `rgb(`, `lab(`, ...) and bare `white`/`black`, comments ignored, with
  `CSS_ALLOW`: thread.css's five black box-shadows, its three `85%, black` light status
  tones (darken the token a step for 4.5:1), and backdrop.css's radial mask (alpha only).
  `index.css` (the palette) and anything outside `components/` (PR 2's `src/themes/`) are
  not scanned;
- a check that the stylesheets were read (non-empty), and self-tests for both patterns;
- the stale-entry check covers both allowlists.

## Gotchas

- **Vitest hands back CSS as empty, even with `?raw`** (the old comment in the guard said
  so). `test.css.include` makes Vitest run matching CSS through Vite; the regex matches the
  module id with its query, so `/\.css\?raw$/` gives the guard the text while the
  components' plain `import "./thread.css"` stays empty in tests. Without it the CSS scan
  would pass on nothing; the "reads the sources" test fails if that ever regresses.
- **`palette.test.ts` has no Node types** (`tsconfig.app.json` is `vite/client` only), so
  reading the files with `node:fs` would not typecheck; the glob above avoids that.
- **`white`/`black` classes slipped past the old palette regex** (it only knew hue-shade
  pairs). That is how `dark:bg-white/[0.035]` survived theme-5.
- **Live check:** `claude-4.5-haiku[1m]` (the work Bedrock id) 404s on this machine;
  `claude-haiku-5-5[1m]` worked. A system TCC dialog from another app sat over the window,
  so the shots use `screencapture -l <CGWindowID>` (id from a small Swift
  `CGWindowListCopyWindowInfo` filter on the GUI's pid), which captures the window alone.
  A shell's output printed before the GUI attaches scrolls out of view on the first resize,
  and an interactive zsh clears the screen; the ANSI shell was `sh -c 'sleep 3; …; exec
  sleep …'`. System Events could not click (-25208), so the tool row is a live one from a
  follow-up running `sleep 45`.

## Verified

- `make check` green (frontend 150 files, 2998 tests).
- Guard mutation: an `oklch(1 0 0 / 5%)` in agents.css and `dark:bg-white/[0.035]` back in
  radio-group each fail their test with the line.
- `make gui-build` green.
- Live (isolated `CODE_FOUNDRY_HOME`, daemon from this branch, scratch repo under `~`,
  haiku 5.5 / medium): a thread with two user bubbles, a Go code block and a bash block, a
  running Bash tool row, and a thread-owned bottom shell printing ANSI 0-15 (fg and bg),
  `git log --color` and `grep --color`; then the Usage page. Dark and light.
  - Pixels: bubble 40,40,40 dark and 237,237,237 light (today's 40 and 237); its top
    border 69 / 213 (today's 70 / 213); dark code block 20 (8 + 5% of 242); pane 8 / 255.
  - Syntax colours match the slots (light: keyword red, function purple, type blue,
    string green, comment grey; dark: keyword mauve, function blue, type yellow).
  - Daemon log: no WARN or ERROR. Thread removed, GUI and daemon stopped, home, repo and
    `~/.claude/projects` entry deleted.
- Not seen live: the destructive button (confirm dialog) and the action editor's icon tiles
  (sub-perceptual: foreground 0.985 for white; 3.5% of 250 for 255).
- Screenshots: `theme-engine-1-cleanup/thread-dark.png`, `thread-light.png`,
  `usage-dark.png`, `usage-light.png`.
- No daemon change: no restart needed.

## For PR 2

- thread.css reads `--primary` (bubble), `--foreground` (tints), `--terminal-fg` and
  `--terminal-ansi-1..8` (syntax, shell), `--info`/`--warning`/`--success`/`--destructive`
  (status tones, darkened 15% toward black in light), `--card`, `--sheet`, `--input`,
  `--border`, `--ring`, `--muted(-foreground)`. A theme block that sets those on `<html>`
  recolours the thread.
- The syntax slot swap is keyed on `.dark`; a dark theme must keep the `dark` class (or
  the light slots apply: keyword = ansi-1 red, function = ansi-5 magenta).
- The bubble alphas assume a mid-contrast `--primary`; a very saturated accent at 14.5%
  in dark may want a lower alpha, worth a look per theme.
- Scrims stay black (allow-listed); an `--overlay` token would be the place if a theme
  wants otherwise.
