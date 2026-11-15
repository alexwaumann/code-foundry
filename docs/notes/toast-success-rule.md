# When a success gets a toast (PR 3 of 3 on toasts)

PR 1 (toast-levels.md) gave every toast a level and one function, `notify`. This one decides
which success toasts stay. Errors, warnings and info toasts are untouched.

## The rule (agreed with a user)

An action is assumed to succeed; the UI speaks up when something went wrong. Success shows
where the action happened: a copy button's icon turns into a green check, a list shows its
new row, a dialog closes onto the thing it made. A success toast is only for:

1. **The place is gone and nothing else shows the result.** The test is not where the
   action ran from but whether the screen shows its result afterwards. A menu closes as it
   runs, but a row it was opened on that leaves or changes (Archive, Remove, Convert to
   draft, Run in) is the result: no toast. A result nothing shows (a copy, a pin from the
   header's menu with the sidebar hidden) keeps its toast. Where the result shows from some
   of the places a menu opens from and not others, the item toasts only from the others.
   The palette and keybindings still toast: they have no place, and the thread or row they
   acted on need not be on screen.
2. **Background work that finished after the user moved on**: push, create a pull request,
   prepare a worktree (gitops, progress toast → its result in place). Unchanged.
3. **A next step**: the toast carries a button (Open, Undo, Show in Finder).

Anything else that only repeats the screen is silent.

## How a new call site decides

- Ask what the screen shows after the action, from every place it can be started. If the
  control is still there and changed (a switch, a renamed title, a row that went or came, a
  strip that closed), no toast. If it was a menu, ask the same of what the menu was opened
  on: its row or page still shows the result, no toast; nothing does, toast. The palette or a
  key: toast.
- A helper reached both ways takes the caller's word: `CommandSource` (`{ inView?: boolean }`,
  stores/commands.ts). `runCommand(name, args, ctx, { inView: true })` and
  `runCommandForResult(name, args, { inView: true, ... })` skip the success toast; a failure
  still toasts. Helpers with mixed callers take `source: CommandSource = {}` and pass it on
  (removeWorktree, initGitIn, cleanupMergedWorktrees, archiveThread, snoozeThread,
  setPullRequestDraft); helpers with only an in-view caller set it themselves (renameThread,
  renameProject, renameWorkspace, setThreadModel, setThreadPermission, setAutoMerge,
  setReviewRequest, submitReview).
- The default (nothing passed) toasts: a caller that does not know stays as before.
- `SHOWS_ITSELF` in commands.ts lists commands whose result is another app, window or tab
  coming forward (reveal, open in an editor, open a URL, terminal.new, thread.interrupt):
  they never toast success, from anywhere. bindings.ts's `quietCommands` moved there.

## Menus (decided after the first draft of this PR)

- A thread's menu (ThreadMenuItems) opens from the sidebar row (`contextMenuKit`) and the
  header's ⋯ (`dropdownMenuKit`). `MenuKit.rowInView` says the row is on screen. Silent from
  both: Regenerate name (the row and the tab), Snooze presets, Save for later, Unsnooze (the
  row; the pane's snooze strip), Run in (the row's queued move; the header's chip). Silent
  from the row only: Pin, Clear flags, Archive/Unarchive (only the row shows them; the
  sidebar can be hidden). Fork and Remove are the row's own: silent. Restart Claude shows
  nowhere: toasts from both. The row's Snooze button (SnoozePresetItems) is silent too.
- Projects menus (components/projects/menus.ts): Remove project, Remove workspace (the row
  goes, or the page falls back to the index without it), Remove worktree (checkout and
  leftover rows), Initialize git (the kind changes), Resume (the thread opens): silent. Clean
  up merged worktrees is silent from the page's ⋯ (its leftover rows go) and toasts from the
  index's row menu (the index lists no worktrees); "No merged worktrees to remove" always
  toasts. Copy path / Copy branch name keep their toast.
- The pull request menu's Convert to draft waits until the panel shows Draft: silent. Link
  to this thread toasts (the link shows only in the thread card or the sidebar's PR tag,
  neither of which need be on screen).
- The thread card's Run in list and its Remove (Delete on a project): silent.
- Kept as they were: the snooze dialog (also opened by the palette and a chord), Save as
  workspace, Publish, Merged #N, and every copy from a menu.

## Thread started

`startPrThread` (Ask, Explain, Fix findings) toasts "Thread started" + Open only when the new
thread did not become the selected one. The daemon's FocusThread travels on the event stream,
apart from the command's answer, and may wait for the thread to reach the list, so
`unlessSelected` waits up to FOCUS_GRACE_MS (1 s) for the selection to become the thread:
it does, no toast; it moves elsewhere first, the toast at once; neither, the toast after
the wait. A result that names no thread toasts at once. Component tests with no FocusThread
set `focusGrace.ms = 0` (PullRequestSurface.test.tsx).

## Plugin copy actions

A plugin element's `copy` action (`copyElementText(text, at)`) shows the check on the element
for COPIED_MS (stores/pluginCopied.ts, components/plugin/copied.tsx) and nothing is toasted:
a button and a chip swap their icon (or glyph) for the CopyIcon check (an icon-only button is
named "Copied" meanwhile); a list row (and a master-detail row) shows it after its title, a
table row in its first cell, a stat card beside its label, a bar in its tooltip. A copy from
a plugin menu (a row's ⋯ or right-click, the header's ⋯, a menu button's items: `useRunAction({
menu: true })` in PluginMenu's `usePicked`) toasts "Copied". A failed copy toasts "Copy
failed" (before, the rejection went unhandled).

## Settings › Plugins and Settings › Skills rows

Their store actions (pluginRegistry `act` and the install's plugin.enable, skill `act`) run
`inView`: the row shows the switch, Installed, the version, a row that goes, setup's
terminal tab. Failures still toast and stay under the row; the "Disabled <skill>" restart
warning is a warning and stays. Refresh marketplaces is not a row action and still toasts.

## The generic command toast

`runCommandForResult`'s success toast is `commandSuccessNotice(title, message)`: a daemon
message of one line and at most 64 characters is the title, first letter raised and a
trailing full stop dropped ("Approved #5", "Converted #145 to a draft"); a longer or
multi-line one goes under the command's title as before.

## The shared copy piece

- `lib/useCopied.ts`: `{ copied, copy(text) }`. `copied` for COPIED_MS (1.5 s), a recopy
  restarts the wait. A failed copy now toasts "Copy failed" (it showed nothing before).
- `components/copy/CopyButton.tsx`:
  - `CopyButton`: a muted ghost icon Button (shadcn), Tip and aria-label "Copied" while
    copied, `data-copied`; `text` may be a function read on press. Used by Details' Copy
    path, the File header's Copy path, a diff's Copy diff and the plugin `CopyIconButton`.
  - `CopyIcon`: the icon alone, `icon` at rest (Copy by default) and a check in
    `text-cf-success-text` while copied, the same size so nothing moves. For controls
    styled their own way: the code blocks' Copy (keeps its "Copied" text), Copy answer and
    the thread card's branch row (GitBranch → check, row named "Copied" for the moment).
- Every copy button now turns green; before only Copy path on Details and the code blocks
  did.

## Gotchas

- The copy piece lives in `components/copy`, not `components/ui`: every file under
  `components/ui` is re-exported to pages as `@cf/ui` (src/pagelib/ui.test.ts fails on one that
  is not), and widening the page API was not this PR's to do.
- `CopyIcon` sets the colour on the svg itself, so a button's `hover:text-…` cannot turn the
  check back to the muted colour.
- The branch row is a `role="button"` div: its name comes from its text, so the copied state
  sets `aria-label="Copied"` for the moment rather than relying on a live region inside it
  (a button's children are presentational).
- `toastCleanupResult(json, { inView })` still says "No merged worktrees to remove": nothing on
  screen changes in that case.
- Add Project: `noticeAdded` (stores/addProject.ts) toasts only when the dialog was opened to
  `stay` (by a page or the CLI), where the window does not move to what was added.
- The project page tests used `[data-sonner-toast]` absence to say "no toast" without a
  Toaster mounted; they mock notify now.

## Tests

- vitest: components/copy/CopyButton.test.tsx (check, name, timing, function text, failure toast),
  useCopied.test.tsx (failure toasts), commands.test.ts (title shape, inView, SHOWS_ITSELF),
  and the call sites' tests (ThreadInfoCard, ProjectPage, CleanupWorktreesDialog,
  PullRequestSurface, PrTasks, prPanel, threadActions, SidebarRow, RememberedSection,
  SettingsPage, themePicker, themeEditor, addProject, WorkspacePage, prTasksRun).
- vitest for the decided items: ThreadMenuItems.test.tsx (row menu vs header menu sources),
  RowMenu, SidebarRow, menus.test.ts, ProjectPage (Initialize git from the menu: no toast),
  PullRequestSurface (Convert to draft: no toast), prThreads.test.ts (Thread started only
  when not selected, the grace), components/plugin/copied.test.tsx (each element kind's
  check, no toast; the menu's toast; the failure), menu.test.tsx (a menu copy names no
  element), pluginRegistry, skillConfirm, PluginsPage, SkillsPage (`inView`).
- e2e `copy-feedback.spec.ts`: the check's computed colour is the success slot in both
  schemes (only the real theme CSS shows it); `SHOTS=<dir>` saves the PR screenshots,
  the hello demo's Copy error button among them.
