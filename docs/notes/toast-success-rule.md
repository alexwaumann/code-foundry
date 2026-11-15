# When a success gets a toast (PR 3 of 3 on toasts)

PR 1 (toast-levels.md) gave every toast a level and one function, `notify`. This one decides
which success toasts stay. Errors, warnings and info toasts are untouched.

## The rule (agreed with a user)

An action is assumed to succeed; the UI speaks up when something went wrong. Success shows
where the action happened: a copy button's icon turns into a green check, a list shows its
new row, a dialog closes onto the thing it made. A success toast is only for:

1. **The place is gone.** The action ran from a context menu, the palette or a keybinding,
   which closes as it runs (or never had a place), so nothing on screen shows the result.
   Copies from a menu or the palette keep their toast.
2. **Background work that finished after the user moved on**: push, create a pull request,
   prepare a worktree (gitops, progress toast → its result in place). Unchanged.
3. **A next step**: the toast carries a button (Open, Undo, Show in Finder).

Anything else that only repeats the screen is silent.

## How a new call site decides

- Ask what the screen shows after the action, from where it was started. If the control is
  still there and changed (a switch, a renamed title, a row that went or came, a strip that
  closed), no toast. If it was a menu, the palette or a key, toast.
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

## The generic command toast

`runCommandForResult`'s success toast is `commandSuccessNotice(title, message)`: a daemon
message of one line and at most 64 characters is the title, first letter raised and a
trailing full stop dropped ("Approved #5", "Converted #145 to a draft"); a longer or
multi-line one goes under the command's title as before.

## The shared copy piece

- `lib/useCopied.ts`: `{ copied, copy(text) }`. `copied` for COPIED_MS (1.5 s), a recopy
  restarts the wait. A failed copy now toasts "Copy failed" (it showed nothing before).
- `components/ui/copy-button.tsx`:
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

- vitest: copy-button.test.tsx (check, name, timing, function text, failure toast),
  useCopied.test.tsx (failure toasts), commands.test.ts (title shape, inView, SHOWS_ITSELF),
  and the call sites' tests (ThreadInfoCard, ProjectPage, CleanupWorktreesDialog,
  PullRequestSurface, PrTasks, prPanel, threadActions, SidebarRow, RememberedSection,
  SettingsPage, themePicker, themeEditor, addProject, WorkspacePage, prTasksRun).
- e2e `copy-feedback.spec.ts`: the check's computed colour is the success slot in both
  schemes (only the real theme CSS shows it); `SHOTS=<dir>` saves the PR screenshots.
