# File viewer 3: File and Diff panel tabs

PR 3 of 5 of the file viewer (1: daemon RPCs, 2: code and diff rendering, 3: this, 4: path
chips, 5: PR Code tab). Frontend only. The side panel's File (`files`, F) and Diff (`diff`, D)
surfaces, placeholders until now, become real tabs on `FilesystemService.ReadFile` and
`ProjectService.GetWorktreeFileDiff`; the worktree overview's Changes rows open them.

Update 2026-10-18 (`binary-read-cap-and-mcp-settle.md`): ReadFile reads a non-text file
(an image, a PDF) up to the max_bytes asked for, at most 32 MiB; text stays capped at
1 MiB, and max_bytes 0 is still 1 MiB for everything. The File tab still asks for the
default until the PDF PR raises it.

## Files

| Path | What |
| --- | --- |
| `src/api/files.ts`, `src/api/fileDiff.ts` (+ `files.test.ts`) | ReadFile → `FileReadView` (UTF-8 text, image bytes, flags); GetWorktreeFileDiff → `FileDiffView` (two `FileSideView`s, base, status, error) |
| `src/surfaces/fileTarget.ts` | the tabs: `fileTab`/`fileOfTab`, `diffTab`/`diffOfTab`, `FILE_KIND`, `DIFF_KIND` |
| `src/surfaces/files.ts`, `diff.ts` | the specs (titles "File", "Diff"; kinds and letters unchanged); `Placeholder.tsx` is gone |
| `src/stores/filePanel.ts` | `openFileInPanel`, `openDiffInPanel`, `diffOfChange`, `lastTabOf`: GUI state, no daemon command |
| `src/components/files/` | `FileTab`, `DiffTab`, `FileHeader` (header A and its actions), `CodeBody` (line mark + scroll), `MarkdownPreview`, `HtmlPreview`, `ImagePreview`, `states` (empty states, notice bar), `fileKind` (pure helpers), `fileActions` (editor / Finder), `useTabRead` (reads and refresh triggers), `useBlobSrc`, `files.css` |
| `src/components/code/CodeFile.tsx` | `selectedLines` passes through to the library |
| `src/stores/codeView.ts` | `preview: { markdown, html }` (`rendered` / `source`), `setPreviewMode` |
| `src/stores/panel.ts` | `openTab` refreshes an open tab's params as well as its title |
| `src/components/overview/WorktreeOverview.tsx`, `files.ts` | Changes rows open the Diff tab (click, Enter, Space); `FileRow.uncommitted`; `statusColor` moved to `files.ts` |
| `src/lib/nav.ts` | Space activates a row like Enter (every NavRow list) |
| `src/lib/filePath.ts` | `normalizePath`, `resolvePath`, `fileName`, `dirPart`, `extOf`, `relativeTo` |
| `mock/files.ts`, `mock/server.ts` | ReadFile and GetWorktreeFileDiff fixtures; `POST /__mock/fs/write`, `GET /__mock/fs/calls` |
| `e2e/file-tabs.spec.ts` | 5 tests + a SHOTS-gated screenshot run |

## How tabs are keyed

One tab per file. A tab's id comes from the params that name the file, not from all of them
(`makeTab` derives the id from every param, so these build the `Tab` themselves with `tabId`):

| Tab | params | id from |
| --- | --- | --- |
| File | `project`, `base` (the thread's checkout, home for no-project), `path` (made absolute against base when it is relative), `line?` | `path` |
| Diff | `project`, `worktree`, `path` (worktree-relative), `oldPath?`, `scope` (`working` / `branch`) | `project`, `worktree`, `path` |

Opening the same file again finds the tab, and `openTab` now hands it the new params (it
used to refresh the title only): a second open at another line moves the mark, and the
scope switch is `openDiffInPanel` with the other scope (the tab stays, its read re-runs). A
Changes row always opens with its own default scope (working when `FileChange.uncommitted`,
else branch), so clicking the row again also resets a switched scope.

Titles are the file name. The tab strip's icon tells File (`FileText`) from Diff (`FileDiff`).

F and D: the empty list's File and Diff entries are live (and the letters open) only while
the panel has a tab of that kind; they bring back its last one. Otherwise dimmed, and hidden
without a project (Diff always; File until the panel has a File tab, since path chips in a
no-project thread will open File tabs against home). There is nothing sensible to open
from scratch: no file picker in this PR.

## Entry points in this PR

- Worktree overview → Changes row (click, Enter, Space) → Diff tab, in whichever panel shows
  the overview (a thread's, or the Projects page's).
- Diff tab → Open file (row one, `FileText`, only when the new side exists) → File tab at the
  first change's line (`firstChangeLine`: the first `change` block's `additionLineIndex + 1`).
- PR 4's path chips call `openFileInPanel("current", { project, base, path, line })`.

## Header A

Ours, outside the library (`disableFileHeader` stays). Row one: file-type icon, name
(`text-heading`), directory muted in mono, truncated from the left (rtl box), relative to the
worktree for project files, tildified otherwise; the full path (and a rename's source) is the
tooltip. Actions as ghost `icon-xs` Buttons with Tips: (Open file,) Copy path (a check for
1.5 s), Open in editor (`worktree.open.editor --file --line`), Reveal in Finder
(`worktree.reveal --file`), Refresh. Editor and Finder go through `runCommand` with a
`worktreeContext(project, base)` context, so they work for a no-project file too (the
command only needs an absolute directory). Row two: the mode switches (the Usage page's
`Segmented`, reused as is), muted meta, a spacer, the wrap toggle (`aria-pressed`).

- File meta: `N lines · size · Language` (the library's `getFiletypeFromFileName` id mapped
  to a name), `saved 2m ago · size` when rendered, `W × H · size · PNG` for an image,
  `Binary · size`.
- Diff meta: status letter in the Changes colours (`statusColor`), `+N −M` from the library's
  parsed hunks (`diffStats`), `vs <base>` (`shortRef` of `base_ref`; `HEAD` without one).
  At the default 420px width the meta truncates after the counts; the brief accepts that
  (Split and the full meta are for a maximized panel).

## Bodies

- **Code / Source**: `CodeFile` with line numbers in a scroll box filling the tab; above
  400 lines inside `CodeScroll` (the virtualizer).
- **Markdown Rendered**: `components/pr/Markdown` with the thread's code blocks and table
  frame (wrapped in `.cf-thread`, so `thread.css` styles them), the file's HTML allowed
  (sanitized as GitHub bodies are), relative images read with ReadFile against the file's
  directory and shown from an object URL. A `max-w-3xl` reading column; `files.css` puts
  the body on `text-body` and h1/h2/h3+ on `text-title`/`text-heading`/`text-subheading`
  through `@apply` (with `@reference "../../index.css"`).
- **HTML Rendered**: `<iframe sandbox="" srcdoc referrerpolicy="no-referrer">` on a white
  canvas (allowlisted in the palette guard), the document prefixed with `<meta
  http-equiv="Content-Security-Policy" content="default-src 'none'; style-src
  'unsafe-inline'; img-src data:">`, and the muted shield footer. The frame has an
  `aria-label`, not a `title` (the tooltip guard forbids native titles).
- **Image**: `<img>` on a checker (`.cf-checker`), scaled to fit; SVG too (an `<img>` runs no
  script).
- **States**: binary placeholder with Open in editor / Reveal; truncated notice bar
  ("Showing the first 1 MiB of 4.2 MB"; ReadFile returns at most 1 MiB, so a truncated read
  is exactly that); `not_found` "File not found" with the path and Retry; `is_dir` "This is
  a folder" with Reveal; a failed first read "Cannot read the file" with Retry; a failed
  re-read keeps the old contents under a "Refresh failed" bar.
- **Diff**: `CodeDiff` with both full sides (an absent old side is `null`, an absent new side
  empty text), so the library's separators expand into the whole file. `error` → "Cannot
  compare" with the message; a binary side → "Binary file"; status "" → "No changes" (which
  scope says what); a pure rename → "Renamed"; a truncated side → a notice. Above 400
  rendered lines (`unifiedLineCount` summed) inside `CodeScroll`.

## Refresh triggers (`useTabRead`)

Data lives in the tab component's state: only the visible tab holds any, unmounting frees
it, nothing is cached beyond the tab. A read runs:

- when the tab mounts, which is every time it becomes the active tab or its panel shows
  (SidePanel keys the body by tab);
- on Refresh, and on Retry;
- when the window becomes visible again (`onVisibilityChange`);
- when the daemon recomputes the file's worktree: the tab watches `worktreeDetailResource`
  for it (which also keeps the daemon recomputing that worktree, the condition for it to send
  `worktree_detail_updated`) and re-reads when the detail's `computedAtMs` changes. A File
  tab with a project uses its `base` as the worktree; a no-project file has no such trigger;
- when the selected thread finishes another Edit, MultiEdit, Write or NotebookEdit whose
  `file_path` (or `notebook_path`) is the file (`editsOf` over the visible thread's log, the
  path cached per item in a WeakMap, so the selector stays a cheap count).

Event-driven reads are debounced by 250 ms. `worktree_detail_updated` only fires when the
detail changes (`sameDetail`), so an edit that keeps a file's line counts is caught by the
thread hook, the window coming back, or Refresh, not by the worktree event.

## Library gotchas

- **`selectedLines`**: passing the prop at all (even `null`) makes the selection controlled
  (`controlledSelection = selectedLines !== undefined`), so a click does not change it; we
  do not enable the library's line selection, so nothing gets in the way and the mark stays
  until the line param changes (it is not cleared on the next click). The marked row carries
  `data-selected-line` in the shadow root. `CodeFile` only passes the prop when given, so
  the thread's rows keep the uncontrolled default.
- **Scrolling to a line**: the library does not scroll to a selection. `CodeBody` waits (rAF,
  up to 3 s: theme and grammar load first) for `[data-line="N"]` in the shadow root and sets
  the scroll box's `scrollTop` a third down. A virtualized file only renders rows near the
  viewport, so it first jumps to `(N − 1) × 19px` (the unwrapped line height), which makes
  the library render the row, then lands on it.
- **`additionLineIndex`** in a `parseDiffFromFile` result indexes the new file's lines from 0
  (both sides are whole files), so the first change's line is that + 1.
- A file with a final newline shows one more numbered (empty) line in the library than our
  "N lines" meta, which counts like `wc -l`.
- **Object URLs** for images are made in a callback ref with a cleanup (React 19), not in an
  effect with state: the React Compiler lint forbids synchronous setState in effects, and a
  `useMemo`'d URL revoked in an effect cleanup would break under StrictMode's double effects.

## Mock daemon

`mock/files.ts`: a fixed disk in the code-foundry main worktree (README.md, src/app.ts with
80 lines, docs/preview.html with a script that must not run, docs/logo.png 2×2, bin/tool
binary of 2.3 MB, docs/ folder, big.log of 4.2 MB truncated) and every worktree detail's
changed files (new side generated, old side derived from the status letter; the branch
scope of an uncommitted-only change is equal sides; `?`/`A` are absent on the branch).

## Verified

- `make check` green.
- Playwright on the mock daemon: `e2e/file-tabs.spec.ts` (5 tests) on Chromium and WebKit;
  `panel`, `worktree-panel`, `no-project`, `archive`, `snooze`, `thread`, `prs` specs on
  Chromium and `panel`, `worktree-panel` on WebKit. `worktree-panel.spec.ts`'s keyboard test
  asserted that Enter on a file row does nothing; it now asserts Space opens its Diff tab on
  the branch. `panel.spec.ts` expects the entry "File".
- Live (`make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cf-fv3/home`, scratch repo
  `~/cf-scratch-fv3` on `feat/viewer` with a bare origin, one commit ahead of main and three
  working-tree changes; a Haiku 5.5 / medium thread created without a prompt, so Claude did
  no work): Changes hover, README diff unified (working tree) and split (panel maximized),
  Open file → rendered markdown with the local `docs/logo.png`, Source with line 3 marked,
  `src/server.ts` at its first change (line 4), `docs/preview.html` rendered with its script
  not run and its remote stylesheet not loaded, dark and light. Editing `docs/preview.html`
  on disk while its tab was open re-read it within seconds (the worktree event). Window
  clicks were CGEvents from a small Swift helper, captures `screencapture -l <window id>`.
  The isolated copy shares the installed app's WebKit localStorage: the codeView store was
  left at its defaults (unified, no wrap, rendered) and `appearance.theme` back at system.

## Left out / follow-ups

- No way to open an arbitrary file in this PR besides Open file from a diff: path chips
  (PR 4) are the main entry point.
- Markdown rendered from a file does not turn paths into chips yet; the `code` extras hook is
  where PR 4 adds them.
- The worktree event does not catch an edit that leaves a file's line counts unchanged (see
  above); a per-file watch would need a daemon change.
