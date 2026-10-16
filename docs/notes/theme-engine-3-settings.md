# Theme engine 3: theme slots in settings, a window background that follows the theme

PR 3 of 4 of the theme engine (1: thread.css cleanup, 2: catalog and engine, 3: this,
4: the picker page and follow-ups). The two theme slots PR 2 added to `lib/theme.ts` are now
settings the daemon owns, validated against the catalog; the CLI and the palette can switch
them; the native window paints the active theme's sheet and opens in it next time.

## Settings

| key | title | type | default |
| --- | --- | --- | --- |
| `appearance.theme` | Scheme | enum `system`/`dark`/`light`, labels System/Dark/Light | `system` |
| `appearance.theme_dark` | Dark theme | enum of the catalog's 14 dark ids, labelled with their names | `catppuccin-mocha` |
| `appearance.theme_light` | Light theme | enum of the catalog's 7 light ids, labelled | `catppuccin-latte` |

`appearance.theme` keeps its key (it predates the slots) and becomes the scheme: "Scheme"
reads better than "Appearance" inside a group already called Appearance, and next to "Dark
theme"/"Light theme". The three rows open the Appearance group in that order. The group
description now starts "Scheme, themes, …".

### Validation and fallback

- The slot fields are plain `Enum` fields built from `internal/theme` (`IDs(scheme)`,
  `Names(scheme)`, `Default(scheme)`), so the generic settings editor renders a labelled,
  scheme-filtered select with no custom editor, and the daemon rejects anything else.
- `Field.unlisted` (new, optional) explains an enum value outside the list in place of the
  generic "want one of …". The slots use `theme.Check`:
  `Catppuccin Latte ("catppuccin-latte") is a light theme; the dark theme must be one of "catppuccin-mocha", …`
  and `unknown theme "sepia"; light themes are "catppuccin-latte", …`. Update rejects with
  `*ValidationError` (CLI exit 2) and the file is unchanged.
- A value on disk the catalog does not have (a theme removed later) or of the wrong scheme
  takes the existing path for rejected values: the default applies, the key is listed in
  `Snapshot.Issues`, `Open` logs `settings: value ignored` once (hand edits picked up by the
  watcher do not log, as for every setting), and the file is not rewritten at read time. As
  for any rejected value, the next save from the app drops it ("Saving from the app rewrites
  this file").
- The frontend validates again (`setThemeSlots` falls back per slot), so a stale value can
  never select a missing `data-theme` block.

### Migration

None needed, and none written: `settings.toml` has no schema version, and a missing key is
its default. A file from before this PR loads with the Catppuccin defaults, keeps its scheme,
reports no issues, and the next render lists `# theme_dark = "catppuccin-mocha"` commented
out (`TestOlderFileGetsThemeDefaults`, the same pattern as the notifications group). The
on-disk migration rule applies to SQLite (`db.Migrate`); nothing there changed.

## The daemon's catalog (`internal/theme`)

`themes/convert.ts` writes a third file, `internal/theme/catalog.json`:
`{ "defaults": { "dark", "light" }, "themes": [{ id, name, scheme, pair? }] }`, no colours.
The defaults sit in the file so Go never hard-codes an id; they come from the new
`src/themes/defaults.ts` (re-exported by `src/themes/index.ts`), which the converter imports
instead of the generated catalog it is about to replace. The drift test compares the Go copy
too and checks it has no colour fields. `internal/theme` embeds it: `Themes`, `For`, `IDs`,
`Names`, `ByID`, `Default`, `Valid`, `Check`. It imports nothing from the repo, so both
`internal/store/settings` and `internal/command` use it (settings imports command, so the
command package repeats the three keys as constants, as notifications does).

## Commands

| command | CLI | what |
| --- | --- | --- |
| `theme.list` | `code-foundry theme list [--json]` | the scheme and every theme by scheme, `*` on the slot's theme |
| `theme.set-dark <theme>` | `code-foundry theme set-dark dracula` | sets `appearance.theme_dark` |
| `theme.set-light <theme>` | `code-foundry theme set-light rose-pine-dawn` | sets `appearance.theme_light` |

Two set commands rather than one `theme.set <slot> <id>`: each takes an `Enum` arg of its
scheme's ids, so the palette shows a pick list of the right themes, and a wrong-scheme id is
refused before the daemon is asked (`argument "theme": want one of catppuccin-mocha, …, got
"catppuccin-latte"`, exit 2). `settings set appearance.theme_dark …` reaches the daemon and
gets the specific message above. Setting the slot of the scheme not in use says so: `…; the
scheme is light, so it shows after code-foundry settings set appearance.theme dark`. Names
are kebab-case like `thread.set-model`. The mock daemon has the fields and the commands.

## Frontend

- `stores/settings.ts` maps `appearance.theme_dark`/`theme_light` to `setThemeSlots`, passing
  only the keys the snapshot has (lib/theme resets a slot given `undefined`).
- `lib/theme.ts` keeps the last applied `{ scheme, light, dark }` in localStorage
  (`cf.theme`, written on every change) and starts from it, so the app renders the user's
  theme before the daemon's settings arrive, then the snapshot confirms or replaces it.
  `themePreference()` and `onThemeChange(cb)` are new.
- `index.html` has a small inline script in `<head>` that reads `cf.theme` (defaults when
  absent or garbled), resolves `system` with `matchMedia`, and sets `data-theme`, `.dark` and
  `color-scheme` before the stylesheet paints. Without it the first frame is index.css's
  fallback (Graphite, black) until `App` mounts. `lib/firstPaint.test.ts` runs the script
  against stored values and checks it uses lib/theme's key and defaults.
- `lib/windowBackground.ts` (`syncWindowBackground`, started in `App.tsx` next to
  `syncDocumentScheme`) reports `{ scheme, dark, light, active }` to the host on start and on
  every change: `dark`/`light` are each slot's `--sheet` from the catalog, `active` the scheme
  the page shows. Deduplicated by value; a no-op without a host.

## Host: the window background

`AppService.SetWindowBackground(WindowBackground)` (gui/windowbg.go; binding regenerated):

- validates (`#rrggbb` colours, known schemes), sets the window colour to the active sheet
  (`window.SetBackgroundColour`), and saves `{ scheme, dark, light }` to
  `$CODE_FOUNDRY_HOME/window-background.json` (atomic write, only when changed). `paths.
  WindowBackground()` names it. Not under `app/`: an update replaces that directory, and the
  host had no per-host state file before (zoom lives in the daemon's settings).
- At start `main.go` opens the window with `launchBackgroundColour`: the saved file's sheet
  for its scheme, `system` resolved from `AppleInterfaceStyle` (a few lines of cgo in
  windowbg_darwin.go; Wails' own `Env.IsDarkMode()` returns false until `app.Run` creates the
  platform app, after the window options are built). Missing or invalid file: Mocha #131222 /
  Latte #e0e2e6, the default themes' sheets (`TestDefaultWindowBackground` reads the frontend
  catalog to keep them equal).
- **The webview's own background.** Wails shows the window once the page has loaded
  (`WebViewDidFinishNavigation`), but WebKit composites the page a moment later, and until
  then an opaque WKWebView paints its empty-page colour over the window's: `#1e1e1e` in dark
  mode (white in light). Probe: with the saved dark colour set to pure red, no launch frame was
  ever red, and one in three launches showed a `#1e1e1e` frame before the page. So the window
  now starts `Hidden`, and on that same event the host turns the webview's `drawsBackground`
  off (KVC, the switch Wails' transparent backdrop uses; wrapped in `@try`) and then shows the
  window. The page paints its own `--sheet` over it; anything unpainted shows the window
  colour. Same probe after the change: the pre-paint frame (2 of 5 launches) was red, never
  `#1e1e1e`.
- Titlebar: nothing to change. The title bar is hidden-inset, the page draws the band, the
  traffic lights are native and read on both sheets. The NSWindow appearance still follows
  macOS (native menus and the folder picker), not the forced scheme; Wails has no window
  appearance setter on `WebviewWindow`, left for PR 4 if it matters.

## Gotchas

- **Shared WebKit storage.** `cf.theme` lives in the user's WebKit localStorage, shared by
  every Code Foundry window whatever `CODE_FOUNDRY_HOME` it uses (like the panel state). A
  scratch run with another theme makes the real app's next launch paint that theme until its
  settings arrive (a fraction of a second), and then rewrite it. The live check put the
  scratch daemon back to Alex's scheme (dark) and the default slots before quitting.
- **Capturing launch frames.** `screencapture -l` on a window that is not on screen yet
  returns its offscreen backing (a uniform `#1e1e1e`), which looks exactly like the webview
  flash. Only windows from `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` count; the first
  measurements here were wrong for that reason.
- `go build`/`go test` outside make picked up a stray `libghostty-vt.pc` from another
  worktree; export `PKG_CONFIG_PATH=$PWD/third_party/ghostty-vt/share/pkgconfig` (the
  Makefile does), and rewrite the copied `.pc` prefix to this worktree.
- `tsconfig.node.json` needed `resolveJsonModule` because the mock now imports
  `src/themes` (which imports `catalog.json`).
- The e2e `pick` helper matches option labels exactly, so the Scheme picks are now "Light"
  and "Dark".

## Verified

- `make check` green. New tests: `internal/theme` (catalog shape, pairs, defaults, `Check`
  table); settings parse rows for both slots (valid, wrong scheme, unknown), slot fields from
  the catalog and their order, old file gets defaults, on-disk fallback (default value, issue,
  file byte-identical, one log line per key, `Read` agrees), Update accepts/rejects/resets;
  `theme.*` command table (list marks, set, follow-up list, wrong scheme, unknown, missing,
  the other-scheme hint); command count; gui `windowbg` (colour per scheme/active, validate
  table, file round trip, junk files, default equals the catalog); frontend store mapping
  (slots applied, missing key kept), window background reports and dedupe, stored-theme
  write and seed (table), first-paint script (table). e2e `settings.spec.ts` +
  `zoom-popovers.spec.ts`: 46 passed (WebKit, Chromium), including a new test that the slot
  rows list only their scheme's themes and apply live.
- CLI against a scratch daemon (`make build`): `theme list` (defaults marked), `theme
  set-dark dracula`, `theme set-light rose-pine-dawn`, `theme list --json`; `theme set-dark
  sepia` and `theme set-dark catppuccin-latte` refused (exit 2); `settings set
  appearance.theme_dark catppuccin-latte` and `settings set appearance.theme_light nope`
  refused with the specific messages; a hand-edited `theme_dark = "retired-theme"` served
  Mocha live, and after a daemon restart logged `settings: value ignored` once with the file
  unchanged.
- Live (`make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cf-te3`, a bottom shell in a scratch
  project printing ANSI 0-15): Settings showed Scheme / Dark theme / Light theme with names;
  the Dark theme select listed only the 14 dark themes and the Light one only the 7 light
  ones; picking Dracula from the row repainted the window and the open shell (Dracula ANSI),
  picking Rosé Pine Dawn and flipping the Scheme row to Light repainted both to Rosé Pine
  Dawn, back to Dark to Dracula. The host file followed each change. The macOS appearance
  itself was not flipped (it is the user's whole desktop); `system` resolution is covered by
  the unit tests and the launch helper.
- Relaunch on Rosé Pine Dawn, five launches, first on-screen frames sampled: every launch
  went from the theme's sheet `#ebe5de` straight to the page; no dark or white frame. Dark
  scheme (Dracula) likewise, `#1c1e29` first. Captures are about 100 ms apart, so a flash
  shorter than that would not show; the red probe above is the stronger evidence that the
  pre-paint frame is now the window colour.
- Needs a daemon restart after merge (new settings keys and commands live in the daemon); the
  GUI and the CLI ship with it.
