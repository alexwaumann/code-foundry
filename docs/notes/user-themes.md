# User themes (2026-10-22)

PR 2 of 4 of the user themes series (1: derivation hardening and `src/themes/contrast.ts`,
built alongside; 2: this, themes as files the user and the model own; 3: the editor and the
contrast report; 4: "Describe a theme" on the Themes page). A theme is one file; the user
(or a thread) saves one, copies a curated one to start from, deletes one, and picks it for
a slot like any curated theme. The daemon stores and validates the files and derives no
colour: the GUI resolves a user theme's slots with the same rules as the catalog's
(theme-slots-1-engine.md).

## The file

`$CODE_FOUNDRY_HOME/themes/<id>.json` (`paths.Themes`), the catalog's format plus two keys:

```json
{
  "id": "ocean-dusk",
  "name": "Ocean Dusk",
  "scheme": "dark",
  "from": "catppuccin-mocha",
  "created_by": "s-5f963f4547cc",
  "base": { "canvas": "#0b141c", "surface": "#16232f", "text": "#d7e3ea", "accent": "#5fb3b3",
            "success": "#8fc79a", "warning": "#e8c07d", "error": "#ec7f8a", "info": "#7fb4e0",
            "highlight": "#c3a6e8",
            "terminal": { "foreground": "#cdd6f4", "ansi": ["#45475a", "…16 colours"] } },
  "overrides": { "--cf-sidebar-row-selected": "#1e2e3c" }
}
```

* `from` (optional): the theme it was copied from, curated or user. A slot naming this theme
  falls back to it when this one is gone.
* `created_by` (optional): the thread that wrote it. `theme save` and `theme duplicate` fill
  it from the calling thread (`$CODE_FOUNDRY_THREAD`, the CLI's ActiveThreadID, so
  `Context.CallerThreadID`); from the user's terminal the file's own value is kept, from the
  GUI none is set.
* `pair`, `source`, `base.link` and the terminal's `cursor` / `cursorText` / `selection` are
  optional, as in the catalog (`source` is required there, not here).
* Rules (`theme.ParseFile`, `internal/theme/file.go`): one JSON object, at most 64 KiB, **no
  unknown fields** at any level (a typo like `acent` is refused, not dropped); `id`, `pair`,
  `from` are `[a-z0-9]` words joined by single dashes, at most 64; a name of at most 80
  characters; scheme dark or light; the nine base colours and the terminal foreground
  `#rrggbb`; 16 ANSI colours; at most 256 overrides, each named `--cf-…`, `--terminal-…`,
  `--syn-…` or `--sh-…` with a `#rrggbb` / `#rrggbbaa` value. Hex is lowercased. The
  daemon cannot tell a real slot from a well-formed name: `--cf-not-a-slot` is kept, and
  the GUI's `resolveSlots` never reads it (PR 1's `staleOverrides` reports such names).
* The id must match the file name and must not be a curated id.

## Store (`internal/store/usertheme`)

Named `usertheme`, not `store/theme`: every file that uses it also uses `internal/theme`, and
two packages called `theme` meant an alias at each import.

* `Load` reads the directory: `*.json` (any case), skipping dot files (a write's temp file)
  and directories, at most 500 files. Each is valid (`Snapshot.Themes`, by name then id) or an
  `Issue{File, Message}` (a bad file, an id that does not match its name, a curated id). A
  file is never deleted or rewritten by a read. New issues log a WARN once.
* `Watch` is the memory store's fsnotify watch (memory-fixes-2.md) on this directory:
  debounced 100 ms, a missing directory looked for every 2 s.
* Writes: `Save` (round trip through `ParseFile`; a curated id is `ErrCurated`; the same id
  is replaced), `Duplicate(id, name, createdBy)` (`<id>-copy`, then `-copy-2`, …; name
  "<name> copy", then "<name> copy 2"; colours, overrides, pair and source copied; `from` is
  the original), `Delete(id)` (user themes only). Atomic (temp file + rename), dir 0700,
  files 0600. Each write reads the directory again before it returns.
* `OnChange` hooks run synchronously under the store's lock, before the bus event: the
  daemon's hook is `settings.SetThemes`, so `theme save --apply` can set the slot to the
  theme it has just written.
* **Gone themes.** The snapshot's `Set()` (`theme.Set`, `internal/theme/set.go`) is the
  user's themes plus the catalog plus `gone`: every user theme id seen valid in this daemon's
  lifetime that is not valid now, with its `from`. A file that does not validate but has a
  readable `id`/`from` (`theme.ReadHeader`) counts as gone too, so a slot on a theme whose
  file a hand edit broke falls back to its from even at the first read. Not persisted: a file
  deleted by hand while the daemon was down falls back to the default.

## Settings

* `appearance.theme_dark` / `theme_light` take a user theme of the matching scheme. The
  fields are built per call from the store's `theme.Set` (`Field.withThemes`, `fieldsFor`):
  Enum and labels list the user's themes first (by name), then the catalog. The settings
  field type has no option groups, so "first" is the grouping; the labels are the plain names.
* The daemon opens the theme store before the settings (`openStores`), and passes its set as
  `settings.Options.Themes`, so a slot on a user theme is valid in the first snapshot and
  `Open` logs no false "value ignored".
* **Fallback**: a value naming a gone user theme is rejected like any value (Issues, the file
  keeps it, WARN `settings: value ignored` once per new issue from `SetThemes`) and shows its
  `from` (following a chain of gone themes, cycle-safe) when that is a theme of the scheme,
  else the default. Issue text: `theme "ocean-dusk" is gone: its file in the themes directory
  was deleted or no longer reads; showing Catppuccin Mocha ("catppuccin-mocha"), the theme it
  was copied from`. When the file comes back the slot shows it again (the file kept the value).
* `theme.Check` messages now list the user's ids first: `unknown theme "sepia"; dark themes
  are "ocean-dusk", "github-dark", …`.
* The settings file's own comments ("One of: …") still list only the catalog; the static
  fields are unchanged.

## API

`ThemeService` (`proto/codefoundry/v1/theme.proto`, `internal/api/theme.go`):

* `List` → `ThemeSnapshot { curated: [CuratedTheme{id, name, scheme, pair}], user:
  [UserTheme{id, name, scheme, pair, from, created_by, source, base: ThemeBase{…, terminal:
  ThemeTerminal{foreground, cursor, cursor_text, selection, ansi}}, overrides, path}], issues:
  [ThemeFileIssue{file, message}], dir, version }`.
* `Watch` → the snapshot, then the whole snapshot per change (`ThemeEvent`).
* EventService source `EVENT_SOURCE_THEME` (17), `Event.theme` (18). Its snapshot is sent
  after gitops and **before settings** (settings name user themes). The GUI reads the themes
  there, not from `ThemeService.Watch`: it holds one events stream, and a second always-open
  stream would take one of the five stream slots for good.

## Verbs (`internal/command/commands_theme.go`)

| verb | CLI | what |
| --- | --- | --- |
| `theme.list` | `theme list [--json]` | each scheme's themes, the user's first, tagged `[yours, from <id>, by thread <id>]`; the themes directory; files that did not load. JSON entries gain `user`, `from`, `created_by`; the list gains `dir`, `issues` |
| `theme.set-dark` / `set-light <theme>` | as before | the enum now lists the user's ids too |
| `theme.show <theme>` | `theme show nord` | the file as JSON (curated or user): the format `save` reads |
| `theme.save` | `theme save --file ocean.json [--apply]`, `theme save --data - < ocean.json` | validate, write `<id>.json` (replacing yours), print `saved\|replaced <Name> (<id>), a <scheme> theme` / `from: <Name> (<id>)` / `pinned: N slots` / `written to: <path>`, and with `--apply` `applied: dark theme = …` |
| `theme.duplicate <theme> [--name]` | `theme duplicate gruvbox-dark` | copy into yours (`<id>-copy`, …), same lines as save |
| `theme.delete <theme>` | `theme delete ocean-dusk --yes` | yours only; confirms ("… It is your dark theme; the dark theme becomes Catppuccin Mocha."); a slot on it is **moved first** to its fallback, then the file goes |

* **`ArgSpec.EnumFunc`** (new): an enum whose values are listed again at every List, Get
  and Invoke (`Registry.effective`). The slot commands, `show` and `duplicate` use it, so
  the palette and the CLI offer and check the current ids. Not with `Enum` or a `Default`.
* `--data`, not `--json`: `json` is a reserved CLI flag name.
* `delete` moves the slot before removing the file rather than leaving it to the settings
  fallback: the move is written to settings.toml (it survives a restart, which the in-memory
  gone list does not), and nothing logs a "value ignored".
* `show` and `save` are `NoKeybinding` (they print or need input); `duplicate` and `delete`
  can be bound.
* The save output has no contrast line yet: the report is the GUI's (`contrast.ts`, PR 1), so
  PR 3 adds it (a TODO in `theme.save`).

## GUI

* `src/api/theme.ts` maps the snapshot to `ThemesSnapshotView` (user themes as
  `UserThemeFile`: a `ThemeFile` plus `from`, `createdBy`, `path`); `stores/themes.ts`
  applies each event: the files go to `setUserThemes` (src/themes), the issues and the
  directory stay in the store. When the list of ids/names/schemes changes it fetches the
  settings schema again, so the Settings selects list them.
* `src/themes/index.ts`: `themeById` covers both kinds; `themesFor(scheme)` is the user's
  then the catalog's; `userThemes()`, `subscribeUserThemes()`. A user `Theme` has `user:
  true`, `from`, `createdBy`, and resolves lazily like a curated one. A file whose JSON is
  unchanged keeps its `Theme` object (and resolved slots), so a no-op event republishes
  nothing.
* **First paint**: the last user themes are kept in localStorage (`cf.themes.user`) and
  loaded at module start, so a launch on a user theme resolves it before the events stream
  connects (index.html's inline script already paints the stored slots).
* `lib/theme.ts` keeps the ids the settings asked for (`wanted`) apart from the slots it
  shows: a user theme not known yet shows the default and is picked up when it arrives;
  one that goes shows the default; an edit to the active theme's file repaints.
* **Themes page**: the list has "Yours · N" above "Curated · N" (`text-overline` headings;
  Yours is hidden only when a search matches none of them; empty, it says "Customise a theme
  to make one of your own."). A user row has a `text-caption-sm` second line, "from
  <name> · by a thread" or "from <name>". Files that did not load are listed under Yours in
  the warning colour. Row actions replace the swatch strip on hover and on keyboard focus
  (folded to zero width and transparent otherwise, so Tab still reaches them; not on the
  previewed row, where they truncated the name): **Customise** on every row
  (`theme.duplicate`, then the copy is selected and previewed once its event lands;
  `whenTheme`), **Delete** on user rows, a trash icon with a "Delete" tooltip
  (`theme.delete`; the daemon's confirm is the standard dialog; the toast names the theme
  the slot moved to). Preview, Apply, the keyboard and the pair hint work on user themes unchanged. The
  editor's Edit action goes in `RowActions` (PR 3); no `theme.edit` stub was added.
* Mock daemon: `mock/userThemes.ts` (three seeded themes, a broken file, the four verbs, the
  theme source, `POST /__mock/themes?set=empty|seed`); the mock settings list user themes
  first in the slot selects.

## Gotchas

* `Invoke` sets `CallerThreadID` from `ActiveThreadID`: a test that wants "from a thread"
  sets `ActiveThreadID` with no `ActiveView`.
* The mock's EventService lists its default sources by hand: a new source must be added
  there, or the GUI never gets it in e2e.
* On a hovered row the actions sit where Playwright clicks an option by default (its
  middle); the specs click the row's name.
* The guide's size margin after the topic split (`internal/guide/topics_test.go`) was
  exactly at 25,000 bytes; the four new verb names in the `settings` topic line took it to
  25,054. The margin is 25,500 now; the hard cap (29,000, guide_test.go) is unchanged.
* A long origin line truncates in the 300 px list ("from Catppuccin Moc…" hides "· by a
  thread"); left as is.
* `localStorage` is shared by every Code Foundry window whatever its home (as `cf.theme`):
  a scratch home's user themes are cached in the real app's WebKit storage until its events
  stream replaces them, a fraction of a second.

## Verified

* `make check` green. New tests: `internal/theme` (ParseFile table, curated files validate,
  ReadHeader, Set order/Check/Fallback/Without); `store/usertheme` (read table, save /
  duplicate / delete with hooks and bus, invalid file counts as gone, watch); settings (slot
  fields with user themes, resolve table with the fallback, the store across SetThemes);
  `command` (EnumFunc, the verbs end to end over real stores, delete's confirm, no themes);
  `api` (List, Watch, the event source); frontend (user themes in the registry, a slot
  waiting for its theme, the picker's Customise/Delete, the API mapping). e2e:
  `user-themes.spec.ts` (5) and `themes.spec.ts` (8) pass.
* CLI against a daemon on an isolated `CODE_FOUNDRY_HOME` (`make gui-build`): `theme list`
  (no themes: the directory line), `theme show catppuccin-mocha` edited into Ocean Dusk and
  `theme save --file … --apply` from a thread (`created_by` recorded, the slot set), `theme
  save --data - <` a light file, `theme duplicate gruvbox-dark --name "Gruvbox, warmer"`,
  then again (`gruvbox-dark-copy-2`, "Gruvbox Dark copy 2"); a hand-written `broken.json`
  listed under "not loaded"; a full file with id `nord` and `theme set-light ocean-dusk`
  refused (exit 2); deleting the active theme's file by hand: the slot showed Catppuccin Mocha
  with the issue and one WARN; saved again, the slot showed Ocean Dusk; `theme delete
  ocean-dusk` without `--yes` printed the confirm (exit 2), with it moved `theme_dark` to
  `catppuccin-mocha` in settings.toml and removed the file; `theme delete nord` refused. No
  ERROR lines.
* The built GUI on the same home: the Themes page with Yours (Gruvbox, warmer and Ocean Dusk
  with their origin lines, the broken file's line) and Curated, the window painted in Ocean
  Dusk, then the light scheme on Latte, softer (shots in the PR body). Customise and Delete
  were exercised in the e2e (WebKit) only. Before quitting, the scratch daemon went back to
  the dark scheme and the default slots and its themes were removed, so the shared WebKit
  storage holds no scratch theme.
* Needs a daemon restart: the store, ThemeService, the event source, the settings and the
  verbs are all in the daemon (the GUI and CLI ship with it).
