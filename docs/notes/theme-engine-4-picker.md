# Theme engine 4: the Themes page

PR 4 of 4 of the theme engine (1: thread.css cleanup, 2: catalog and engine, 3: theme slots
in settings and the window background, 4: this). A main-pane page to pick a theme for each
slot by looking at it first: the window keeps its theme while you browse, and changes only
on Apply.

## Layout

Variant C's control bar on top of variant A's list + gallery (sketch: `docs/sketches/
theme-picker`, not in the repo).

- **Header**: "Themes" and a close (×), like Settings.
- **Control bar**: the Scheme segmented control (System / Light / Dark, `appearance.theme`),
  then two slot chips, "Dark theme: Aa Catppuccin Mocha" and "Light theme: Aa Catppuccin
  Latte". The chip of the slot showing now carries an "in use" badge; the chip being edited
  is outlined in the primary colour (`aria-pressed`). Clicking a chip edits that slot. A
  line says what the scheme does now: "Follows macOS: dark now, showing Catppuccin Mocha",
  or "Always light, showing …".
- **Left column (300px)**: a search box (`/` focuses it, placeholder "Search 14 dark
  themes") and the editing slot's themes only, in catalog order. A row: an "Aa" chip in the
  theme's pane/foreground/pane-border, the name, a 5-swatch strip (destructive, warning,
  success, info, primary), and a check on the slot's current theme. 14 or 7 rows: not
  virtualized. A footer lists ↑↓ preview, ↵ apply, esc close with `Kbd`.
- **Right**: a preview bar ("Previewing Gruvbox Dark · dark theme is Catppuccin Mocha",
  "Back to current", and **Apply to dark ↵**), the pairing hint when there is one, and the
  gallery in the previewed theme.

### The gallery (`components/themes/ThemeGallery.tsx`)

One component, rendered `inert` inside a theme scope:

- a mini app on the sheet: sidebar rows in every state (pinned + selected, Asked a question
  amber, Error red, Finished green with the 2 PRs chip, a workspace chip, the Working section
  with 3 agents, the Snoozed section) and a `.cf-thread` pane with the real `UserBubble`, three
  tool rows (ok chip + duration, `+42 −7`, `exit 1`), the real `ThreadMarkdown` (bold, inline
  code, a link, and its real `CodeBlock` with the lowlight syntax colours), the Worked-for
  footer and the composer card;
- a terminal strip: prompt, status words, a selection, the cursor and ANSI 0–15 as cells
  (`var(--terminal-ansi-N)`, no xterm);
- cards: buttons (default, secondary, outline, destructive, disabled, link), inputs (plain,
  focused ring drawn statically, invalid, Select trigger, checkboxes, Switch on/off, segmented
  RadioGroup), badges and chips (the new shadcn `Badge` ×4, the sidebar's tinted status chips,
  `Chip`, the thread's `.chip` variants, `Kbd`), text (foreground, muted, secondary, link, mono,
  the five status colours, an open tooltip), a menu open inline (DropdownMenuContent's
  classes on plain divs: label, check, highlighted row, shortcuts, separator, destructive),
  a dialog card inline, and feedback alerts (warning, destructive, info).

Store-bound pieces (sidebar row, tool rows, composer) and portalled ones (menu, dialog,
tooltip) are their markup with the same classes; the rest are the real components with
static props. No contrast readout. At 1440×900 the mini app, the terminal and the top of
the cards show; the rest is one scroll.

## Preview scoping

`themes/convert.ts` now writes each theme's block with two selectors:

```css
html[data-theme="dracula"],
[data-theme-scope][data-theme="dracula"] { color-scheme: dark; --sheet: …; … }
html[data-theme="dracula"] .cf-thread { …only the patched syntax tokens… }
[data-theme-scope][data-theme="dracula"] .cf-thread { …all ten syntax tokens… }
```

`components/themes/ThemeScope.tsx` renders `<div data-theme-scope data-theme={id}
class="dark|light bg-sheet text-foreground">`. Why each part:

- `[data-theme-scope][data-theme]` is (0,2,0): on the scope element it beats index.css's
  `.dark` (0,1,0), which the scope element also matches when it carries `dark`. The
  descendants inherit the scope's variables.
- The scoped `.cf-thread` block carries every syntax colour, not only the patched ones, at
  (0,3,0). Otherwise the window theme's `html[data-theme="mocha"] .cf-thread` patch (0,2,1)
  would leak into a preview of a theme that has no patch of its own.
- The scheme class: a light preview inside a dark window still sits under `html.dark`, so
  every `.dark X` rule and every `dark:` utility would apply. `dark:` is now
  `&:is(.dark *):not(:where(.light, .light *))` (index.css), and thread.css's eleven
  `.dark .cf-thread …` rules and index.css's `.dark .cf-markdown …` are
  `.dark .cf-thread:not(:where(.light *)) …`. `:where()` keeps the specificity unchanged,
  so nothing else in the app moves; `<html>` never carries `light`. The converter reads the
  dark aliases from the new selector (`DARK_THREAD`; `cssBlock` now escapes every regex
  character).
- `text-foreground` on the scope: `color` inherits as a computed value from the window's body.

The drift test is unchanged in shape (committed files equal a fresh build); the syntax unit
test now checks the patch block and the scoped block separately. `catalog.json` and the Go
catalog did not change.

## State model (`stores/themePicker.ts`)

`{ slot, preview, query, hint, returnTo, applying }`, page state only.

- `slot`: the slot being edited; on open, the one asked for or the scheme in use.
- `preview`: the previewed id, or null meaning the slot's applied theme. Previewing the
  slot's own theme stores null; a theme of the other scheme is ignored. Switching slot
  clears it.
- Apply (`applyPreview`): `theme.set-dark` / `theme.set-light` (quiet; a failure toasts),
  then `preview = null` and, if the theme has a `pair` the other slot does not already use,
  `hint = { slot, themeId, fromId }`. The window repaints when the settings snapshot lands
  (lib/theme's slots), which is what "current" reads: `useThemeSlots()`.
- The hint's button runs the other slot's set command; the hint also hides once that slot
  equals the pair by any route. × dismisses. Never auto-filled.
- `returnTo: "settings"`: opened from Settings (its Choose… buttons, its Themes link, or any
  open while Settings shows); closing goes back there. Otherwise closing returns to the
  selection and asks the prompt for focus, like Settings.
- Close (× / Esc / selecting anything in the sidebar) resets the store: the preview is gone.

The views store has `themesOpen` beside `settingsOpen`/`usageOpen` (at most one open);
`selectPageOpen` counts it, so the side and bottom panels hide and their commands no-op as
for the other pages.

## Commands and entry points

| entry | does |
| --- | --- |
| `theme.pick [dark\|light]` ("Choose Theme…", Settings) | new, `internal/command/commands_theme_pick.go`. Emits `ShowView` `themes`, `themes.dark` or `themes.light`. CLI: `code-foundry theme pick [slot]` opens the page in every window, on that slot |
| palette | presented locally (`keys/bindings.ts`), so only this window opens, on the slot in use; listed in `paletteSupplied` so the palette does not prompt for the optional slot |
| Settings → Appearance, Dark theme / Light theme rows | the select stays; a **Choose…** button beside it opens the page on that slot (`components/settings/ThemeSlotEditor.tsx`, registered in `keyEditors`). These two selects drop the " (default)" suffix (`EnumEditor`'s `markDefault={false}`): beside the button it clipped to "Catppuccin Latte (", and the reset arrow already marks a changed value |
| Settings group nav | a **Themes ›** link under the groups (a separator above it) |

No sidebar icon. `showView("themes…")` opens rather than toggles (Esc and × close; a second
`theme pick light` moves the open page to the light slot). The mock daemon has `theme.pick`.

Keyboard (page root is `data-keys-local`, so bare keys never reach command chords): ↑/↓
move the preview through the filtered list (the list has focus on open; also from the search
box), Enter applies, `/` focuses the search, Esc closes (`useEscapeCloses`; in the search a
non-empty query is cleared first, as in Settings). Double-clicking a row applies it.

## Also in this PR

- **`components/ui/badge.tsx`**: shadcn's Badge (new-york). `destructive` mirrors the
  Button's destructive instead of shadcn's fixed light text, which the palette guard refuses.
- **Stale e2e specs since #119** (`archive.spec.ts:135`, `snooze.spec.ts:150` and `:251`):
  they expected the archived/snoozed thread to stay selected. #119
  (`put-away-focuses-dashboard.md`) made putting away the selected thread select the
  dashboard. The specs now assert the start page, no thread pane and the Dashboard button
  current, then open the thread again from its Archived/Snoozed section and keep their
  original checks (composer, Unarchive/Unsnooze, no panels, the snooze note, sending
  unsnoozes). No app change.

## e2e (`e2e/themes.spec.ts`, WebKit + Chromium)

1. Choose… in Settings opens on that slot; only the scheme's themes; switching slot; the
   in-use badge and the scheme line; × goes back to Settings.
2. A preview paints the gallery (its computed `--pane` is Dracula's) and not the window
   (`html[data-theme]` and its `--pane` stay Mocha, setting untouched); Back to current;
   Apply writes `appearance.theme_dark` and the window follows; no hint for Dracula.
3. Esc discards and closes back to Settings; the next visit starts from the applied theme.
4. Pairing: Apply Gruvbox Dark → "Gruvbox Light is this theme's light companion. Use it
   for light?" with the light slot untouched → the button writes it; dismissing works.
5. Keyboard via the palette: list focused, ↓↓↑ preview, Enter applies, `/` + "nord" filters,
   ↓ previews Nord, Esc clears the query, Esc closes without applying.
6. A light preview inside the dark window: scope has `light`, html keeps `dark`; the scope's
   `--syn-*` equal Solarized Light's catalog values; a shadcn Input is transparent (no
   `dark:bg-input/30`).
7. The scheme control writes `appearance.theme`, and the in-use slot and line follow.
8. `ShowView themes.light` (the CLI path) opens on the light slot and closes back to the
   selection; the Settings Themes link opens it.

Unit: `stores/themePicker.test.ts` (pair hint table, filter table, scheme line table,
preview rules, Apply/accept through the command, failed Apply, close/return, ShowView names,
pages exclusive); `internal/command/commands_theme_pick_test.go` (ShowView per slot, bad
slot refused, no message); the command count test.

## Gotchas

- **Playwright cannot import the catalog** (`src/themes` imports JSON without an import
  attribute, which Vite accepts and Playwright's loader refuses). The spec reads
  `catalog.json` with `fs`.
- **Option names.** `toHaveText` on the rows includes the "Aa" sample (aria-hidden does not
  change textContent); rows carry `aria-label={name}` and the spec reads `theme-name`.
- **Go test cache across worktrees.** `go test` without the Makefile's `CGO_CFLAGS`/
  `CGO_LDFLAGS` reused a cached link line pointing at another worktree's libghostty-vt. Use
  the Makefile's environment (`MACOSX_DEPLOYMENT_TARGET=13.0`, both `CGO_*` flags and
  `PKG_CONFIG_PATH`), or `make check`.
- **inert gallery.** It also keeps Radix popovers from opening: their portals render at
  `<body>`, outside the scope, so they would show the window's theme.

## Verified

- `make check` green (Go: `theme.pick` table, command count; frontend: 3360 tests before
  the picker store tests, 21 more after; the drift test with the new selectors).
- `make gui-e2e`: 810 passed, 40 skipped, 0 failed (WebKit + Chromium, 24 min) on the final head, a clean run with nothing else on the machine. That includes the 16 new picker tests (8 × 2) and the three #119 specs. An earlier run that overlapped with the GUI build, the live check and a second Playwright run had 5 one-off failures (`thread.spec.ts:360`, `usage-page.spec.ts:79`, `zoom-popovers.spec.ts:35` in WebKit; `addproject.spec.ts:50` and `:208` in Chromium); all 16 cases passed when rerun on their own, and the clean run had none. `settings.spec.ts:63` failed once the same way while the full suite ran in parallel and passed on a rerun.
- Live (`make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cf-te4`, scheme dark, a bottom shell in a
  scratch project printing ANSI 0–15 on the Projects page):
  - Settings → search "theme" → the Dark theme row's **Choose…** opened the page on the dark
    slot (list focused).
  - ↓↓↓ previewed Gruvbox Dark, ↑ Dracula: the gallery repainted each time, the window
    stayed Mocha, settings.toml unchanged.
  - Enter applied Dracula: the window repainted, `theme_dark = "dracula"` in settings.toml,
    `window-background.json` moved to Dracula's sheet `#1c1e29`.
  - Applying Gruvbox Dark showed "Gruvbox Light is this theme's light companion. Use it for
    light?"; its button wrote `theme_light = "gruvbox-light"` and the hint went.
  - The page's Scheme → Light: `theme = "light"`, the window went Gruvbox Light (host file
    `#ece2b9`) while the gallery kept previewing the dark slot (a dark scope in a light
    window).
  - Esc went back to Settings; closing it showed the bottom shell repainted from Mocha's
    ANSI to Gruvbox Light's.
  - CLI: `code-foundry theme set-light catppuccin-latte`, then `code-foundry theme pick
    light` opened the page on the light slot in the window; ↓×5 previewed Solarized Light.
  - Screenshots at 1440×900: dark (Mocha applied, previewing Gruvbox Dark) and light (Latte
    applied, previewing Solarized Light), on the `t3code/theme-engine-4-shots` branch.
  - Before quitting, the scratch daemon was put back to Alex's scheme (dark) and the default
    slots, so the shared `cf.theme` matches the real app; the scratch repo was deleted.
- Needs a daemon restart after merge: `theme.pick` is a new command in the daemon's
  registry (the palette and the CLI list it from there). The GUI ships with it.
