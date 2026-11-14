# Shell review fixes, GUI side

A review of the whole `shell` branch found these in the window shell's GUI. Each was traced
through the code first; each has a test that fails without its fix. Two were data loss.

## 1. Unsaved File-tab edits thrown away when a thread's tabs left its space

**Cause.** `stores/fileEdit.ts` `prune` ended every edit session whose tab was no longer in its
target's place (`thread:<id>`, which only looks at the thread's own space), and `end()` forgets the
draft. Closing the thread's tab, closing a pane holding it, snoozing, archiving, removing a space,
dragging the File tab to another space and a model's `tab.close` all removed the File tab from that
place, so the draft went with no question. The comment there still named `resetThreadPanels` and
`unsavedTabs`, which kept dirty tabs on `main` and no longer existed in the shell.

**The rule now.** Unsaved edits are never discarded unless the user says so.

- The session key stays the thread's panel key ("" for an unlinked tab) and the File tab's seam id
  (its path): it follows the file's identity, not its place. `fileEditKeyOfTab` computes it for any
  layout tab, in any space.
- `prune` keeps a session while any File tab in the layout has its key, and otherwise ends it only
  when it is clean (and not mid-write). A dirty one waits: its draft stays in the library, and the
  tab that next opens that file for that thread finds it, dirty. It runs when the tabs change and
  when a session turns clean (a save of a tab that was put away ends it then).
- So a linked File tab put away with its thread (cmd+w on the thread, its pane closed, a snooze)
  comes back dirty when the thread and the file are opened again; a File tab moved to another space
  keeps its session; a close by something else (a thread's model, the CLI, a page) keeps the text.
- When the user ends a dirty file for good they are asked Save, Discard or Keep editing, and a
  refusal closes nothing:
  - cmd+w or × on the File tab, and closing its pane: the surface's `beforeClose`, as before. Discard
    now ends the session at once (`discardEdit`): the tab's going no longer does.
  - archiving the thread (a button, a menu, the palette, a key: anything through
    `runCommandForResult` without a plugin `caller`), for each dirty file of that thread, open or put
    away: `stores/fileEditGuards.ts`, run by a new command-guard registry (`stores/commandGuards.ts`).
  - removing a space with its threads archived (`spaceActions.removeSpace`).
- Removing a thread still drops its drafts (`dropPanelDrafts`): removing is the user's word.
- `unsavedTabs` and the dead comment are gone.

`guardCommand` answers `true` at once when no guard asks, so a command with no guard still reaches
the daemon in the same tick (the pane's Allow relies on it: `PendingPrompt.test.tsx`).

## 2. Sending a draft with attachments could turn another draft into the thread

**Cause.** `sendDraft` read the focused pane's active compose tab (`shell/composerTab.ts`) after
`await stageAttachment(...)`. Focusing another draft during the upload made that one `--compose`:
the thread took the other draft's tab and the daemon ended that draft, its text with it.

**The rule now.** The composer passes its own tab id (`ComposeTab` → `Composer tabId` →
`sendDraft(…, { composeTab })`). Nothing about a send reads the focus. `composerTab.ts` is deleted,
and so is the selection bridge's `replace-composer` route (`SelectOptions.sent`), which replaced the
focused composer for a send that named none: the only thing that replaces a composer is the send's
own `--compose`.

## 3. "New thread on this branch" never ended its draft

**Cause.** The like-send passed no `--compose` (`thread.new-like` had no such arg), and the fallback
that replaced the composer compared draft keys that never match once the composer's key carries a
draft id. The thread was made, the text cleared, and the tab and its sidebar row stayed.

**The rule now.** `thread.new-like` takes `--compose` as `thread.new` does (checked before the thread
is made, the thread's tab takes the composer's place, a draft sent ends). The GUI passes it for
every send; the mock daemon mirrors it.

## 4. Typing during an emptied draft's clear lost the new text

**Cause.** `shell/composerDrafts.ts` checked emptiness before sending `composer.draft.clear` and ran
`clearDraft` on success without looking again; the layout prune also drops the text of a draft the
layout no longer lists.

**The rule now.** A clear in flight is remembered (`clearing`: the tab and the target key). Once the
layout shows the draft gone (or the clear answers after it does), `settleCleared` looks again: still
empty, the text goes; typed into, the text becomes a new draft on the same tab (now the space's
empty composer), or, its tab closed, goes to its target's composer. The prune skips drafts being
cleared. `start` moves a draft key's entry rather than copying it, so its attachments' object URLs
are not revoked.

## 5. The layout slice could go back to an older revision

**Cause.** In `stores/layout.ts` a snapshot that arrived during a resync neither stopped the resync
nor bumped `generation`, and `resync` then set `confirmed` to the Get's answer unconditionally.

**The rule now.** A snapshot during a resync ends it and bumps `generation`, so the running Get is
ignored and later deltas are not held behind it. A Get's answer is applied only when its rev is
above the slice's. A snapshot still replaces everything, even at a lower rev (a restarted daemon).

## 6. Needs you: a pinned asker last, and the keys in another order

**Cause.** `bandSortTimes` nulled `statusChangedAtMs` for pinned threads and `byRecent` puts nulls
last, so a pinned thread that asked was drawn last under Needs you; `getListThreads` (cmd+1…9,
cmd+shift+a) used the raw times and walked another order.

**The rule now.** One order, most recent ask first: `bandSortTimes` keeps the status time for a live
thread in the prompt group whether pinned or not (the classic pinned band sorts by other things, so
nothing else moves), and `getListThreads` is the list keys decoded, the same values the sidebar is
drawn from.

## 7. The two the review could not confirm

- **(a) A send whose composer tab closed meanwhile: real.** `thread.new` made the thread, then
  `open_thread --compose` failed (`tab "t-…": not found`) and the command returned an error; the GUI
  kept the draft and a resend made a second thread. Now `sentFrom` never fails the send: when the
  composer tab is gone the thread's tab opens as a new thread's does, and anything else that goes
  wrong is a warning (`internal/command/commands_thread_compose.go`). The GUI names a compose tab
  only while the layout still holds it, and a sent draft still listed once the layout has the
  thread (its tab was closed, so `--compose` did not end it) is discarded (`endSentDraft`).
- **(b) Unlinked File tabs' sessions never ended: real.** `prune` skipped every session with panel
  key "", so a clean unlinked session lingered and a reopened tab came back in edit mode from it.
  The new `prune` treats them like any other.

## 8. The Needs-you card allowed an edit after showing only its path

**Choice: the card shows the change.** For an Edit or a Write the hover card now shows what the
pane's card shows, the +/− summary and the diff, open from the start (the pane's starts folded),
inside the card's maximum height, which scrolls. `PromptDiff` moved to its own file
(`components/thread/PromptDiff.tsx`) and both cards use it. A diff reads well at the card's width
(up to 560px; @pierre/diffs wraps lines and virtualizes a long one), so offering only "Open…" for
those kinds would have taken a working quick action away for no reason.

## Daemon changes

Only what findings 3 and 7a need: `internal/command/commands_thread_new_like.go` (`--compose`),
`commands_thread_compose.go` (`sentFrom` returns a warning, falls back to opening the thread),
`commands_thread_lifecycle.go` (passes the options to `thread.new-like`, the warning into the
result), and their tests in `commands_thread_compose_test.go`.

## Tests

vitest: `stores/fileEdit.test.ts` (the tab going), `stores/fileEditGuards.test.ts`,
`stores/commands.test.ts` (guards), `stores/composeSend.test.ts`, `shell/composerDrafts.test.ts`,
`stores/layout.test.ts`, `stores/context.test.ts`, `components/needs/NeedsCard.test.tsx`. e2e (the
browser parts): `file-edit.spec.ts` (a dirty file through closing and reopening its thread) and
`shell-sidebar.spec.ts` (the send with an upload held by the new mock control
`POST /__mock/attachments/hold?on=true|false` while another draft takes the focus).
