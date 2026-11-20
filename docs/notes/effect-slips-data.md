# Effect slips: data copied or guessed

An audit of the frontend's effects found four that copied a value a reader could get
itself, or guessed at something a function already returned. Three are fixed; one is left.

## Find in an edited file reads the editor's text (fixed)

`useCodeFind` copied the editor's document into the find store's `draft` when the bar
opened, and `FileTab`'s `onDraft` wrote it on each change: two writers, one reader, and the
library already holds the text.

- `@pierre/diffs` 1.5.2 has no global change event: `EditStateManager` has no subscribe, and
  `TextDocument` has a `version` but no listener. Each `Editor` takes an `onChange` option,
  called on every change just before the component's `onEditChange`.
- `lib/codeEditor.ts`'s `createCodeEditor` wraps that option, so every editor the app makes
  reports changes by its state key (`subscribeDraft`). `draftSnapshot` reads the text
  once per change: `getText()` joins the piece table on every call, and
  `useSyncExternalStore` asks for the snapshot more than once per render.
- A null text (no document yet) is not cached. An editor that attaches fires no event, so a
  cached null would hide its document until the first edit. Every document that replaces
  another gets a new state key (`nextStateKey` in stores/fileEdit.ts), so a cached text
  never outlives its document.
- `useCodeFind` subscribes only while the bar is open, so typing with the bar closed
  re-renders nothing, as before.
- The store's `draft`, `setFileFindDraft` and `useFileFindDraft` are gone.
- e2e: `file-find.spec.ts`'s editor test now reopens the bar on an unsaved edit and types
  with it open; the count follows. Without the emit, it stays at the old count.

## The diff follows its detail's head in the store (fixed)

`PrDiffView` re-read the diff from an effect when the detail's head moved. Now
`stores/prDiff.ts` subscribes to both resource stores at import and runs the same rule
(once per new head) for every diff key someone watches.

- Only watched keys are checked: `invalidate` does nothing for others anyway, and a key
  checked while unwatched would mark its head as asked for. Its next watch's first read
  would then answer for the old head and never be re-read.
- Behaviour change: a diff the pull request's page warms (`warmPullRequestDiff`, no diff
  tab) now also re-reads once when the head moves. That is intended: the warm exists so the
  Diff button opens on the current diff, and `useDiffWarm` keeps holding the watch until it
  does. Before, the tab re-read it on opening.
- The subscription is installed when the module loads. Only modules that import it watch a
  diff, so it is always there first.

## The composer row's `since` stays on the bridge (left)

The live turn's `since` is read from the timeline's rows after `workerRuns`
(lib/workerRuns.ts). A turn a worker woke loses its header there (`runRows`), so the
row above the composer shows Working without a timer. A selector over the thread's
structure (the last turn's last user message) would add a timer to those turns. Matching
the rows exactly means `ComposerRow` builds them a second time (`buildTurns`, `buildRows`
and `workerRuns` over the whole thread on every structural change). The Timeline is the
one place that has the rows, so the bridge carrying a value from them is right.

## The floating composer collapses from the send's outcome (fixed)

`FloatingComposer` watched the draft's phase go busy then idle to guess that a send went
through. `ThreadComposer` takes `onSent` now, called when `sendThreadDraft` returns true, and
the card collapses from it under the same conditions (draft text empty, no error).

- Only `ThreadComposer` sends a `thread:<id>` draft. The other phase writers
  (`sendDraft`, the setup's Edit) write other keys, so no sender is lost.
- The floating composer no longer subscribes to the draft's phase, text and error.
