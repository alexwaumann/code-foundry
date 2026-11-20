# Dialog open flags that cannot go stale

An audit of the frontend's effects found three dialogs whose "open" flag lives in a store,
apart from the data that decides whether the dialog shows, and a view effect that cleared the
flag after the fact when that data went. The merge and review flags are in stores so the
confirm queue can see them (`registerOwnDialog`: a page's guarded question waits behind the
app's own dialogs). The page modal's flag is in the thread store so it outlives the card's row.

The rule now: a flag is set only while its dialog can show, and it is cleared where the thing
that decides it changes, in the stores, not by the view that draws it. Cleared means gone: the
subject coming back never reopens a dialog. The confirm queue keeps reading the flags as before
(`registerOwnDialog` is unchanged).

## The suspected bug: reproduced

"A merge starts elsewhere while the merge dialog is open" was real in the store, though no
surface reaches it today (the busy button is inert, and the dialog's own Merge clears the flag
before it merges). Calling `mergePullRequest` with the dialog open (the test
"#142: a merge started elsewhere while its dialog is open shuts the dialog..." in
`PullRequestSurface.test.tsx`) showed on the old code both halves: the dialog hid
(`open={dialogOpen && merging === null}`) while its flag stayed set, so a guarded question
stayed queued behind nothing on screen; and once the merge was refused the dialog came back by
itself. The test passes now.

## Per dialog

- **Merge** (`stores/mergeDialog.ts`, `MergeButton.tsx`). The flag records the pull request
  along with the button: `{ button, pr }`. `openMergeDialog(button, ref)` does nothing while a
  merge runs on `ref`, and the store subscribes to `usePrPanelStore`, clearing the flag the
  moment a merge starts on its pull request (from anywhere). The `!a.visible` effect is gone:
  `MergeButton` now returns null or renders `ShownMergeButton`, which owns the dialog id and its
  unmount cleanup, so the button stopping to show is an unmount and the existing cleanup
  covers it. (Through its one caller, ReadinessBox, the button is only rendered for an open
  pull request, so `!a.visible` while mounted did not happen in practice either.) The dialog's
  `open` is the flag alone.
- **Review** (`stores/reviewDialog.ts`, `ReviewDialog.tsx`). `reviewDialogShows(detail,
  viewer, busy)` is the one rule, used by the view and the store. `openReviewDialog` does
  nothing when it is false, and the store subscribes to the detail resource, the viewer
  resource and `usePrPanelStore` and clears the flag when it turns false. Same behaviour as
  the effect, without a render in between and without depending on the host being mounted.
- **Page modal** (`stores/thread.ts`, `InlineHtml.tsx`). Not registered with the confirm
  queue. Items leave a log only through a snapshot, so `applyWatchBatch` drops the thread's
  page modals whose item is not an html item in the new log, in the same update. A log being
  let go (leaving the thread, the kept-log budget) is not the item going, so the modal is up
  again on return, as before. The modal's other guard, `modal.thread !== threadId`, now only
  renders nothing: every pane scope is derived from its thread, so a modal of another thread
  can never show in that scope and never needs closing there.

## Gotchas

- The stores' subscriptions run inside the `setState` that changed the subject, so the confirm
  queue's own listener (subscribed to the dialog store) sees the cleared flag at once; the
  store tests check a guarded question opens with no view rendered.
- `reviewDialog.ts` reads the viewer from `viewerResource`'s entry, the same data
  `useViewerLogin` returns. Component tests that mock `useViewerLogin` must also seed the
  entry (and the detail resource) for `openReviewDialog` to open (`ReviewButton.test.tsx`).
