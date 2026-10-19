# Custom backdrop images

Users add their own pictures as the backdrop behind the start page and the new-thread
composer. `appearance.backdrop` gains `custom`; the image it shows is a copy kept by the
daemon.

## Layout and naming

- `$CODE_FOUNDRY_HOME/backdrops/` (`paths.Backdrops`), created 0700 on the first import.
- Each import is copied in as `<first 32 hex of the content's SHA-256>.<ext>`, the
  extension from the sniffed type (`.png`, `.jpg`, `.webp`, `.gif`). The same picture added
  twice keeps one copy (the second import only selects it again; its added time stays the
  first). The original is never referenced again: moving or deleting it changes nothing.
- The copy is written to a hidden `.import-*` temporary file in the same directory, hashed
  while copying, then renamed; `List` skips hidden files, so a crash mid-copy leaves at most
  a stray temporary file that nothing shows.
- `List` returns regular, non-hidden files with an image extension (`.jpeg` too, for a file
  dropped in by hand), oldest first by modification time (the import time), with the pixel
  size read from the header (`image.DecodeConfig` for PNG/JPEG/GIF, a small VP8/VP8L/VP8X
  header reader for WebP, which the standard library cannot decode). Unknown size is 0.

## Settings

- `appearance.backdrop`: `forest` (default), `none`, `custom` ("Custom").
- `appearance.backdrop_file` (String, default ""): the file name inside the backdrops
  directory that `custom` shows. Its check accepts "" or a plain, non-hidden name (no `/` or
  `\`), so a hand edit cannot point outside the directory. Older settings files simply
  lack both changes and load the defaults; no migration.
- The schema has no hidden fields, so the GUI owns the key instead: `OWNED_KEYS`
  (`components/settings/ownedKeys.ts`) lists keys another field's editor edits;
  `pageSections` and `searchSettings` leave them out. The key stays in the file, the CLI
  (`settings get`/`set`), the guide's settings reference and the schema, with a title and
  description written for those.

## Daemon

- `internal/store/backdrop`: `List`, `Import(path)`, `Remove(name)`, `Read(name)`. No
  state but the directory; it takes a `Settings` interface (`Snapshot`, `Update`), which
  `*settings.Store` satisfies, and writes the selection through it, so the settings store
  publishes the change on the bus like any other edit. A mutex serializes import and
  removal.
- `SettingsService.ListBackdrops / ImportBackdrop / RemoveBackdrop / ReadBackdrop`
  (`internal/api/settings_backdrop.go`, wired with `WithBackdrops`; Unimplemented without a
  store). InvalidArgument and NotFound map from the store's sentinels; anything else goes
  through `settingsError` (a failed selection is a settings error).
- Import: absolute path only; stat before open (a FIFO would block); directory, non-regular,
  empty, or over 24 MiB is InvalidArgument; missing is NotFound. The type is sniffed from
  the first 512 bytes (`http.DetectContentType`), the name's extension is ignored; the copy
  is limited to 24 MiB + 1 so a file growing after the stat is refused too.
- Read: the name must be a plain, non-hidden file name, the file regular (a symlink is
  NotFound, never followed), at most 24 MiB, and sniff as one of the four types.
- No command and no CLI verb: like attachments, the settings page drives the RPCs, and an
  agent can still set `appearance.backdrop`/`appearance.backdrop_file` with `settings set`.

## Fallback rules

- Import selects: `backdrop = custom`, `backdrop_file = <name>`, in one Update.
- Removing the file `backdrop_file` names clears `backdrop_file`; if `backdrop` was
  `custom` it becomes `forest`. With `none` or `forest` it stays as it is.
- Removing any other image leaves the settings alone.
- `custom` with an empty `backdrop_file`, or a file gone from the directory (removed by
  hand), renders nothing: no forest flash, no error.
- Choosing Custom in the select when no listed image is selected (empty, or the remembered
  one is gone) selects the newest image; with no images it saves `custom` alone (nothing
  shows until one is added).

## GUI

- `Backdrop.tsx`: `custom` renders `CustomBackdrop`, which loads the image through
  `stores/backdrops.ts` (ReadBackdrop once per name for the window's life, kept as an object
  URL, the `stores/attachments.ts` pattern) and sets both `--cf-backdrop-narrow` and
  `--cf-backdrop-wide` to it. Nothing renders while loading. `backdrop.css` is unchanged:
  the same mask, opacity and `background-size: cover`.
- `BackdropEditor` (`keyEditors["appearance.backdrop"]`): the Forest/None/Custom select,
  a three-column gallery of 16:9 thumbnails (`object-cover`, `rounded-md` inside the
  `rounded-lg` card; the shown one has a primary ring and `aria-pressed`), and "Add image…".
  A thumbnail click saves `custom` + its name. The × (on hover or keyboard focus, shadcn
  Tip "Remove") deletes at once without a confirm: the original is untouched and re-adding
  is one click; the repo confirms only destructive commands (threads, worktrees), not
  settings edits. After an import or removal the editor lists again (a second window does
  not re-list until it remounts the row, which the brief accepted).
- "Add image…" calls the host's `pickFiles`, starting in `~/Pictures`: the GUI does not know
  home, so it asks `FilesystemService.ListDirectories("~/Pictures")` for the folder's
  absolute path and passes "" (the host then opens home) when there is none. The first
  picked path is imported. In a browser (no host) the button is disabled with the tooltip
  "Available in the app": a file input gives no path.
- Refusals show under the gallery as `<picked file name>: <daemon message>` with the
  `invalid argument: ` / `not found: ` prefix removed, e.g. `notes.txt: not a PNG, JPEG,
  WebP or GIF image (its content is text/plain; charset=utf-8)`. The select keeps its
  normal border (`invalid={false}`): the refusal is the import's.
- `tallKeyEditors` (`keyEditors.ts`): rows whose editor is taller than one control align to
  the top, so the title and the reset arrow sit beside the select instead of the middle
  of the gallery.

## Gotchas

- The open panel is the attach panel (`PickFiles`): titled "Attach files" with an "Attach"
  button, and it can choose folders. A folder picked (or double-clicked, which picks it)
  is refused by the daemon ("…is a directory") and shown inline. A dedicated image panel
  would need a host change; not done here.
- In the panel, the start folder (Pictures) stays selected in the home column; clicking
  another folder there selected both and showed no contents. Clicking a sidebar location
  first cleared it. Only matters for driving the panel with synthesized clicks.
- `JSON.stringify` on a proto message with `bigint`s throws after the mock's `writeHead`,
  which crashed the mock server; its `/__mock/backdrops/import` returns only the name.
- jsdom has no `URL.createObjectURL`; the tests stub it.

## Tests

- Go: `internal/store/backdrop` table tests (import of PNG, JPEG named `.jpeg`, WebP, GIF,
  a PNG named `.txt`; text named `.png`, PDF, empty, missing, relative, directory, over the
  cap, exactly at the cap; duplicate; remove: selected falls back to forest, another keeps
  the selection, the remembered one with none/forest stays; remove/read refusals for
  `../`, absolute, `sub/`, hidden, symlink, folder, missing, non-image; list order and
  strays; WebP header sizes). Handler: the real store end to end, and the error codes
  (plus Unimplemented without a store) on the fake. Settings schema table: `custom`,
  `backdrop_file` names.
- vitest: `BackdropEditor.test.tsx` (gallery, marked selection, select, remove, add from
  ~/Pictures, cancel, refusal text, Custom picks the newest, browser disabled, empty),
  `Backdrop.test.tsx` (forest, none, custom loading/loaded/shared/gone/empty),
  `model.test.ts` (owned key left out of the page and search).
- e2e: `settings.spec.ts` (gallery from two mock imports, select, remove the shown one
  falls back, Add disabled in the browser) and `start.spec.ts` (custom behind the start
  page and the composer; a gone file renders nothing). The mock (`mock/backdrops.ts`) takes
  types from extensions and serves one small PNG for every image.

## Verified live

`make build && make gui-build`, isolated (`CODE_FOUNDRY_HOME=/tmp/cf-bd/home`), a scratch
folder `~/cf-backdrop-scratch` (deleted afterwards) with two self-generated pictures
(`aurora.jpg` 1920x1080, `dunes.png` 1600x900, procedural, no third-party art) and
`notes.txt`.

- Settings › Appearance showed the Backdrop row with the select and "Add image…", and no
  "Backdrop image" row. "Add image…" opened the native panel in `~/Pictures`. Picking
  `aurora.jpg` copied it to `backdrops/39a482b8fc4c3f7483cb935037befdcd.jpg` (directory
  0700) and wrote `backdrop = "custom"`, `backdrop_file = "39a4….jpg"`; the thumbnail
  appeared selected. The start page showed the aurora behind it.
- `dunes.png` the same way (`3dc07633….png`, selected); the start page and the new-thread
  composer showed the dunes.
- Clicking the aurora thumbnail selected it in the file; choosing Forest in the select wrote
  `backdrop = "forest"` and kept `backdrop_file`. × on the aurora deleted its copy and
  cleared `backdrop_file` (Forest stayed). Selecting the dunes, then × on it, deleted it and
  fell back to `backdrop = "forest"`; the directory was empty.
- Refusals inline: a folder picked by a double-click ("Desktop: …is a directory") and
  `notes.txt` (not a PNG, JPEG, WebP or GIF image); nothing was copied.
- Screenshots (dark and light editor with two images, the start page and composer with a
  custom backdrop in dark) are in the PR body.
