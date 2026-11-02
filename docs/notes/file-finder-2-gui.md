# File finder 2: the cmd+P dialog

Status: PR 2 of 2 for the file finder, on branch `cf/file-finder-2-gui`. PR 1
(`docs/notes/file-finder-1-search.md`) gave `SearchFiles` several sources, `files_only`, one
ranked list and code-point positions. This PR adds the command and the dialog. The design
was agreed from sketches (A for one project, W1 for a workspace: flat list, label on the
right).

## What landed

| Path | What |
|---|---|
| `internal/command/commands_view_file_find.go` | `file.find`, "Go to File…", View, `cmd+p`; emits ShowView `file.find` |
| `gui/frontend/src/api/filesystem.ts` | `findFiles` (sources + files_only) and `FinderMatchView`; generated types stay in `src/api` |
| `gui/frontend/src/lib/fileFinder.ts` | pure: `parseFinderQuery` (`:line`, 8 words), `highlightRuns`, `splitMatchPath`, `searchRows`, `emptyGroups` |
| `gui/frontend/src/stores/recentFiles.ts` | per-panel recently shown File tabs, persisted (`code-foundry.recent-files`) |
| `gui/frontend/src/stores/fileFinder.ts` | the presenter, Enter (`openFoundFile`) and ⌥⏎ (`tagFoundFile`) |
| `gui/frontend/src/components/palette/FileFinder.tsx`, `useFileFinder.ts` | the palette page and its data hooks |
| `stores/ui.ts`, `CommandPalette.tsx`, `keys/bindings.ts`, `stores/views.ts` | the palette's `files` page, the presenter, the CLI's ShowView |
| `components/compose/PromptEditor.tsx`, `stores/cite.ts`, `thread/ThreadComposer.tsx` | `insertTagAtCaret` (insertCite's body for any tag), reached through the cite target |
| `mock/world.ts` | the mock lists `file.find` with the same availability |

## Decisions

* **Availability.** A thread view whose context has a project or a workspace (a workspace
  thread that runs in the workspace's folder sends no project but its workspace). A thread
  without a project (cwd ~) has an empty context for both, so the daemon lists it
  unavailable: the chord is unbound and the palette leaves it out. The subagent view
  (`thread.agent`), the composer and pages are not "thread". The CLI may always ask (no
  view); every window then decides, and one without a thread with a project on screen
  ignores the ShowView. The presenter always reports "handled", so a window never invokes
  the command again from a ShowView.
* **A palette page, not a new dialog.** `PalettePage` gains `files` (with `palette.threadId`,
  like Run in…). That gives the cmd+K chrome as is: the same Dialog, scrim and blur, top
  position, `max-w-xl`, the 44px input row, and the focus hand-back on close. cmdk runs with
  `shouldFilter={false}`: the daemon ranks.
* **Sources.** `useThreadCheckouts` (what `@` and `/` read): primary first, then the
  thread's order, each at the checkout the thread records. A project without a known
  checkout falls back to its main worktree, and the GUI always sends a path, so a match's
  `checkout` is the one sent. A workspace's folder is no project, so it is never a source.
* **Rows.** Text only. The name is at the label role's weight (500) with the matched letters
  semibold in the foreground colour, as in the sketch. The directory uses the caption role,
  muted and cut from the left (`[direction:rtl]` with LRM marks, the Changes tab's trick).
  Directory positions are not drawn: the dimmed directory stays plain. On the right come
  `open`, the project label (only with 2+ checkouts, its matched letters bold) and the status
  letter (`statusColor`). The status column is always reserved with 2+ projects, so the
  labels line up as in W1. With one project it shows only when there is a letter, as in A.
  The row key is the file's absolute path (the File tab's key too). A file found twice (a
  checkout nested in another) is listed once.
* **Empty query.** "Changed in this thread": each git checkout's worktree detail
  (`worktreeDetailResource`, the Changes tab's: uncommitted and against the merge base),
  watched while the finder is open, deleted files left out. "Recently opened": the panel's
  recent files, most recent first, kept only when inside one of the thread's checkouts (the
  most specific one), minus those under Changed, at most 8. A group without rows is left out.
  With neither group: "No changed or recently opened files. Type to search."
* **Recent files.** A separate persisted store keyed by panel key, beside the panel store
  rather than inside `PanelEntry`, so the panel's sanitizer and reducers are unchanged. A
  file counts when its File tab becomes a group's active tab, however it got there (path
  chip, finder, `view.panel.file`, a tab click, a neighbour after a close). A thread's page
  (`view.panel.page`) does not count. 10 kept per panel, so 8 can still show after the
  Changed ones are dropped. It is fed by a `usePanelStore` subscription started in App's
  `startApp`.
* **Search.** Debounced 80 ms like the composer's `@`. A newer query or a closed finder
  aborts the one out (AbortController). The last answer stays on screen until the next lands
  (no flicker). The limit is 50. More than 8 words sends nothing and shows "At most 8 words".
  A failure shows "Cannot search: …" above the stale rows.
* **`name:42`.** A trailing `:<digits>` is split off: the name is searched and Enter opens
  at that line. `name:` while typing searches the name. A colon elsewhere stays in the query.
* **Enter.** `openFileInPanel` on `thread:<id>` with project, base = the match's checkout
  and the relative path. It opens in the focused group, opens a shut panel, and only
  activates an open tab. Always a File tab, even for a changed file. The palette's
  `returnTo` becomes `panel`, so the panel takes the keyboard.
* **⌥⏎.** The same `cf-file` tag the `@` completion inserts (`{tagKind: "file", projectId,
  path}`), at the prompt's caret. PromptEditor's `insertCite` body became `insertAtCaret`
  for any tag (same spacing, one undo step), reached through the thread composer's existing
  cite target (`insertTagInto`). `returnTo` becomes `content` and the insert runs a frame
  after the close.
* **Selection.** The highlighted row is controlled. When a search answers, its first row
  takes the highlight. So does the first row whenever the highlighted one leaves the list.
  An effect does this, not a render-phase update: cmdk's own `selectFirstItem` (run on
  every input change, before the answer) and a render-phase reset fought, and the row ended
  up unselected.

## Gotchas

* The Write tool turned ` `-style escapes in a regex literal into the real characters.
  U+2028 inside a regex literal is a line terminator, so oxlint reported an unterminated
  regex. The word splitter's class is written with escapes again (the same class as the
  mock's `SPACE`).
* Radix keeps the dialog's content mounted during its close animation in jsdom, so the unit
  tests assert `palette.open` and not the DOM.
* `stores/fileFinder.ts` is imported by `keys/bindings.ts` and `stores/views.ts`. Importing
  `threadDraftKey` from `stores/threadActions.ts` pulled the compose store into everything
  that imports those, and `Code.test.tsx` (which mocks `@/api/threads` without
  `ATTACHMENT_MIME_TYPES`) failed at import. `threadDraftKey` moved to `lib/threadDraft.ts`;
  `threadActions` re-exports it.
* `insertAtCaret` lives inside the `useImperativeHandle` factory. Outside it, the hook's
  dependency rule wanted it in the dependency array, which would rebuild the handle on every
  render.

## Tests

* Go: `TestFileFindAvailability` (project, workspace, the workspace's folder, no project,
  subagent view, composer, pages, CLI), `TestFileFindWhyUnavailable`,
  `TestFileFindKeybinding`; `file.find` added to the registration and ShowView tables.
* Vitest: `lib/fileFinder.test.ts` (query parsing, 8 words, Go's spaces, code-point runs,
  directory split, labels only with several projects, open and status, the empty groups),
  `stores/recentFiles.test.ts` (order, cap, page tabs, a closed tab staying listed, the
  persisted merge), `components/palette/FileFinder.test.tsx` (presenter, placeholder,
  no-project and pages, the chord through `handleKeyDown`, unavailable leaves the chord and
  the palette alone, both empty-state layouts, sources primary first, highlights, `:line`,
  8 words, stale rows during a search and the debounce, errors, Enter into a shut panel at
  a line, a changed file opening a File tab, ⌥⏎ calling the composer's tag insert).
* Playwright `e2e/file-finder.spec.ts` (one test): cmd+P from a thread's focused prompt opens
  the finder with the input focused; typing and Enter open the File tab in the panel that was
  shut; ⌥⏎ lands a tag in the real ProseMirror prompt, which is focused.

## Verified

* `make check` green; `make gui-e2e` green.
* Real daemon (`make build`, `CODE_FOUNDRY_HOME=/tmp/cf-ff`, `daemon --dev`), two scratch
  git repos under `~/cf-ff-scratch` with uncommitted and staged changes, a one-project
  thread, and a workspace thread (`terminal-port`: ghostty-playground primary,
  code-foundry). Driven with the Vite dev frontend through `?daemon=…&token=…` in Playwright
  WebKit, dark and light:
  * cmd+P opened the finder over each thread. Enter opened `docs/ARCHITECTURE.md` in the
    shut panel with the keyboard in the panel, and `readme:2` opened README.md at line 2.
  * The empty state listed the changed files (M and A, deleted ones left out), then README
    (open), PLAN and ARCHITECTURE.
  * `tree` listed both projects' files with labels. ⌥⏎ put `tree.ts` in the prompt as a tag.
  * Nine words showed "At most 8 words".
  * The placeholder was "Go to file in terminal-port…" for the workspace thread.
  * `readme code` found code-foundry's README through the project word.
  * The CLI's `file find` with no window said "No app window is open".
* Cleanup: both threads were removed, the daemon and Vite stopped, and the scratch repos and
  `/tmp/cf-ff` deleted. Starting the threads made Claude Code record the two scratch folders
  under `projects` in `~/.claude.json` (trust). That shared file was left alone; the two keys
  point at folders that no longer exist.
