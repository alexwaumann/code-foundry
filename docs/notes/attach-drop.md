# Attach by drop and pick: GUI half

Files dropped on a composer from Finder, or picked with its attach button, reach the
composer as absolute paths from the Wails host. The five kinds the daemon stages (png,
jpg/jpeg, gif, webp, pdf) are staged by path (docs/notes/attach-by-path.md) and attached;
any other file, and any folder, goes into the prompt as its path at the caret.

## Wails mechanics (v3.0.0-beta.28)

- `WebviewWindowOptions.EnableFileDrop: true` (gui/main.go) installs a native overlay view
  over the WKWebView (`webview_window_darwin_drag.m`) registered for file drags. It takes
  every file drag from the OS: the page gets no DOM `dragover`/`drop` with File objects
  for them any more. The overlay passes mouse events through (`hitTest` returns nil), so
  clicks and hover are unaffected.
- During a drag the overlay calls the runtime's `handleDragOver(x, y)`; it finds the
  nearest ancestor of `elementFromPoint` with `data-file-drop-target` and gives it the
  class `file-drop-target-active` (removed on leave and after the drop). On drop Go calls
  `window._wails.handlePlatformFileDrop(paths, x, y)`; the runtime finds the target the
  same way and posts the paths plus the element's id, classList and attributes back, and
  Go fires `events.Common.WindowFilesDropped` on the window
  (`ctx.DroppedFiles()`, `ctx.DropTargetDetails()`). A drop outside any target is
  ignored by the runtime. `_wails.flags.enableFileDrop` is injected by the host from the
  option; nothing else is needed.
- Points are view points; the app zooms with CSS `zoom` on the body, and
  `elementFromPoint` takes viewport coordinates, so zoom does not move the target.
- `gui/filedrop.go`: `forwardFileDrops` turns the window event into the Wails event
  `app:files-dropped` with `{paths, target}`, `target` being the element's
  `data-drop-id` (`filesDropped`, table-tested). `AppService.PickFiles(startDir)` is the
  native open panel: files and folders, several, no filter, attached to the window,
  aliases resolved, `[]` on cancel; it opens at startDir when that is an existing
  absolute directory, else home (`filesStart`).
- Unhosted (browser dev, Playwright) nothing changes: the composers keep their DOM drop
  and `<input type="file" accept=…>` paths for File objects.

## Routing by drop id

- `components/compose/useHostFiles.ts`: each composer's drop surface (`composer-card`,
  the thread's `.ccard`) spreads `data-file-drop-target` and a `data-drop-id` from
  `useId()`, and subscribes to `app:files-dropped` (`api/app.ts onFilesDropped`, which
  validates the payload). A composer acts only on drops naming its own id, so two visible
  composers (or a plugin's thread node) never both take one. While the draft is sending
  the attribute is dropped (no highlight, the runtime ignores the drop), and
  `routePaths` also returns early unless the draft is idle.
- `routePaths`: `splitDroppedPaths` (by extension, case-insensitive, on the last path
  segment with a name before the dot); others go in with `PromptEditor.insertPlain`,
  then the attachable ones go through `stores/compose addAttachmentPaths` and get chips
  at the caret (`insertChips`, unchanged rule: only when the prompt has prose).
- The paperclip: hosted (`useHosted`, from `appInfo()`), it calls `pickFiles` with the
  thread's checkout (`worktreePath`; empty for a no-project thread, so home) or, in the
  new-thread composer, the chosen existing checkout, else the primary member's, else the
  project's main checkout, else home; the result is routed the same way. Its label is
  "Attach files" hosted (it takes anything) and stays "Attach images or PDFs" in a
  browser.
- Hover: the overlay fires no DOM drag events, so the runtime's class is styled like the
  DOM drag: `in-[.file-drop-target-active]:border-info/70 …bg-info/5` on the new-thread
  card's surface, `.ccard.file-drop-target-active` beside `.ccard[data-dragging]` in
  thread.css.

## Path attachments: staged at once

`addAttachmentPaths` stages each path when it is dropped (side by side,
`Promise.allSettled`), then reads the staged file back through the thread's loader
(`stores/attachments loadAttachment`, ReadAttachment) and adds an ordinary
`DraftAttachment` whose `file` is that blob named like the source and whose `stagedPath`
is already set. So the tile, chip, lightbox and pdf.js thumbnail work unchanged, the send
skips staging it (as for a retry after a failed send), and the sent message's chip finds
the blob in the loader's cache. The alternative, a file-less attachment staged at send
time, would have needed a second shape through every tile, chip, preview and cap.

- Caps: the count cap applies before staging (no more than the free slots are staged; the
  rest get "At most 10 attachments per message; N not attached"). The daemon refuses
  unsupported content (a `.png` that is text), over-cap files and vanished paths; each
  refusal is "<name>: <rawMessage>" in the composer notice, joined with " · ". After
  staging the size is known and `checkAttachments` runs again (type, size, count, inline
  cap). It now takes an optional `pages`: a PDF whose count is known (from the staged
  name, `-3p.pdf`) is held to the inline cap at once; an estimate (`-~4p.pdf`) is no
  count, as before. A long PDF gets the page-by-page notice at once; `settlePdf` (pdf.js,
  for the thumbnail) adds it only to a PDF that had no count, and never removes a staged
  attachment.
- A refused or removed path attachment leaves its staged copy in the attachments
  directory until the daemon reaps it (7 days), like a failed send's.

## Quoting rule (`lib/droppedPaths.ts`)

- A path with only `[A-Za-z0-9_@%+=:,./-]` (shlex.quote's safe set) goes in as it is.
  Anything else (spaces, non-ASCII, `'`, brackets, globs, `~`, …) is wrapped in double
  quotes, with `"`, `\`, `$` and `` ` `` backslash-escaped (what is still special inside
  double quotes in a shell). Several paths are joined with one space.
- Inserted at the caret (the end when the prompt was never focused), replacing a
  selection, with a space before it when the character before is not whitespace and one
  after when the character after is not whitespace (`spacedAtCaret`); at a line's start
  or end no space on that side. One undo step.

## Tests

- Go: `TestFilesDropped` (payload shaping, missing target or id), the JSON shape, and
  `TestFilesStart`.
- vitest: `lib/droppedPaths.test.ts` (split, quoting, spacing tables), the counted-PDF
  cases in `lib/compose.test.ts`, `api/app.test.ts` (payload validation, subscription,
  `pickFiles` with and without a host), `stores/composePaths.test.ts` (staging, refusals,
  count and inline caps, the long-PDF notice once), and `compose/hostFiles.test.tsx`
  (the real Composer: the drop surface's attributes, routing by id with two composers, a
  sending draft, the hosted paperclip and a cancel).
- e2e (`compose.spec.ts`): the browser runtime has `window._wails.dispatchWailsEvent`, so
  the test dispatches `app:files-dropped` for the card's id like the host would; the mock
  stages paths by extension. It checks another id is ignored, the inserted paths and
  chips, the two staged attachments, and that the send reuses the staged paths.

## Verified live

`make build && make gui-build`, run isolated (`CODE_FOUNDRY_HOME=/tmp/cf-attach-drop/home`),
a scratch repo `~/cf-attach-drop-scratch` (deleted afterwards) with `files/green square.png`
(a solid green 96px PNG) and `files/secret notes.txt` ("The secret word is periwinkle."),
threads on Haiku 5.5 at medium effort.

- **Drop, verified with a real Finder drag.** Both files selected in a Finder window
  (AppleScript `select`), then a synthesized left-button drag (CGEvent mouse down,
  dragged in steps, held over the target, released) from the PNG's icon onto the
  thread's follow-up composer. Finder carried both files; the overlay took the drag,
  the card got `file-drop-target-active` (its border turned info-blue) while hovered, and
  the drop gave the PNG tile and chip and `"/Users/alex/cf-attach-drop-scratch/files/secret
  notes.txt"` (quoted: it has a space) before the chip. Sent with "What colour is the
  attached image? Then read the text file at that path and tell me its secret word":
  Haiku answered "Green… The secret word in "secret notes.txt" is periwinkle" (one Read
  of the path). The same drag onto the new-thread composer's card highlighted it (the
  `in-[…]` variant) and gave the same tile, chip and path; that draft was not sent.
- **Pick, verified with the native panel.** The paperclip in the thread composer opened
  the panel, titled with an "Attach" button, at the thread's checkout. Both files were
  chosen by clicks (`files` in the column view, the PNG, Cmd-click the .txt) and Attach:
  same tile, chip and quoted path. Sent ("This came from the attach button. Again: the
  image colour, and the secret word…"): "Green, and the secret word is periwinkle."
- The scratch home's `attachments/` held two staged PNGs (one per message), copies made
  by the daemon from the paths; the GUI uploaded no bytes.
- System Events keystrokes into the open panel (Cmd+Shift+G, a path) did not reach it;
  clicks did.
- Appearance was switched through the isolated daemon's `appearance.theme` for the light
  screenshot and set back to `system`.

Not verified live: a folder drop (unit and e2e tests only), a PDF by path in the app
(the daemon half's note covers staging; the e2e covers the composer), and the daemon's
refusal notice for a mislabelled file (unit test with the daemon's message).
