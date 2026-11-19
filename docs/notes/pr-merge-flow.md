# PR page: the merge flow

Part of the pull request page redesign (agreed sketch v11). This slice covers the Merge and
Auto-merge split buttons, the merge dialog, the confirm's look, and how fast the page shows the
result of a user action.

## What changed

- **A pick is the default.** Choosing a method in the Merge menu (or the Auto-merge menu) makes
  it that repository's default at once: the main part's words change, the menu closes, nothing
  merges or turns on. The menu's heading says so ("Merge into main · your pick becomes the
  default here"), and the default has the tick (DropdownMenuRadioGroup, the tick in the success
  text colour). Before, a menu item merged at once, and the method became the default only after
  a merge succeeded. "Delete branch after merge" stays in the menu.
- **The main part opens a merge dialog** (`components/pr/MergeDialog.tsx`), not the generic
  confirm: the merge icon in a success-tinted circle, "<method label> #N" over the PR title, and
  rows Into (base, with what the method does on the right: `mergeOutcome`, "3 commits become 1"),
  From (head, wraps), Method (a segmented RadioGroup over the methods the repository allows; a
  change there is also the default), Branch (a checkbox, only when the branch can be deleted).
  Cancel and a success-coloured confirm with the method's words. The confirm has the focus, so
  Enter merges.
- **Busy words follow the method that runs.** `merging` now holds the method (not `true`), so the
  button says "Squashing and merging…", "Rebasing and merging…" or "Merging…" for the merge that
  actually runs. `useMergingMethod(ref)` is exported for the readiness box ("Merging into main…"),
  which another slice owns.
- **No flash back to green.** `mergePullRequest` stays busy until the detail shows the pull request
  merged (`detailShows`): the read is asked for at once; if it lands still open (a read begun before
  GitHub had it), it is asked for once more; 15s at most; and it stops waiting once nothing shows
  the detail. A merge GitHub did not finish (`merged: false`, e.g. queued) waits for the re-read only.
  A refusal or a declined question frees the button at once, with the error toasted as before.

## Persisting the default

Picked from the existing pattern for per-repository preferences of this window: the reviewer
picker's recents (`stores/reviewerRecents.ts`), a Zustand `persist` store in localStorage with a
`merge` that keeps only well-formed entries (`stores/persisted.ts`). The new store is
`stores/mergeDefaults.ts`, key `code-foundry.mergeMethods`, lower-case slug → method. Not a daemon
setting: nothing but the GUI's split buttons reads it, the CLI and agents always name `--method`,
and a daemon setting would turn a menu pick into a settings write. The in-memory `mergeMethods`
in `stores/prPanel.ts` and `rememberMergeMethod` are gone.

## One question, never an error's look

`pr.merge` stays the command and keeps its daemon-side confirmation (`Confirm` +
`DynamicConfirm`), so the CLI prompts (or takes `--yes`) and a page's call is asked through the
guarded dialog exactly as before. How the page asks exactly once:

- The merge dialog is the question. Its confirm calls `mergePullRequest(..., { asked: true })`,
  which passes `asked` to `runCommandForResult` → `invokeConfirmed`, and the first invoke goes
  out already confirmed with the exact args the dialog showed (method, delete-branch, the head
  SHA shown). So the daemon's own question is not asked a second time. A second-stage
  confirmation would still ask. `asked` is ignored when a `caller` is set (a plugin's or page's
  call never counts as the user's yes), and the bridge goes through `invokeConfirmed` with its own
  `ask`, so the guarded path cannot reach it. The head SHA guard means the dialog's yes cannot
  merge anything the user did not see.
- Everywhere else the daemon's question is still asked, and it never looks like an error: a new
  `Command.ConfirmTone` (`"success"`, validated at Register) travels as
  `ConfirmationRequired.tone`. `pr.merge` and `pr.auto-merge` set it. The generic ConfirmDialog
  draws a success-toned request with a success icon and a success-coloured, non-destructive
  confirm; with no tone it is the warning look as before. The tone comes from the daemon's command
  definition, never from whoever asks, so a page cannot make a destructive question look calm.
- The guarded path is not weakened: `useArmed`, Cancel focused and the queue are unchanged, and
  `.cf-guarded` keeps fixed colours. A success-toned guarded dialog gets a fixed green set
  (`.cf-guarded[data-tone="success"]`, plain hex values like the red ones), so a theme still cannot
  reach it.
- The merge dialog's open state lives in `stores/mergeDialog.ts` and is registered with
  `registerOwnDialog`, so a page's guarded question waits for it instead of opening over it. The
  button closes it on unmount or when it stops showing, so a stale "open" never blocks the queue.

## Refresh right after each action (stores/prPanel.ts)

The daemon marks the detail written after every write (`invalidateFull`: the next read goes to
GitHub), so the client only has to read again at once. Checked each path:

- merge: read at once, and now busy until the read shows it merged (above).
- auto-merge on/off, draft/ready (`changePullRequest`), review submit, task checkbox: already read
  at once and wait for that read on success.
- reviewers (`setReviewRequest`): reads the detail and the picker's candidates at once; the row
  waits for the candidates.
- revert: read the detail only on success. It now reads it in `finally`, so a refusal also shows
  GitHub's state at once.

## Gotchas

- The `menuItems` helper in `PullRequestSurface.test.tsx` finds `menuitem` roles; the method items
  are now `menuitemradio`, so the merge tests use their own `methodItems`.
- The mock daemon (`mock/`) and the test fakes (`test/prWorld.ts`, `commandErrors.ts`) send the
  tone too, so the mock asks like the daemon.
- `tsc -p tsconfig.app.json` reports a type error in `CodeFile.tsx` that `bun check -b` (the
  project's typecheck) does not. It was already there on main and is not from this change.
