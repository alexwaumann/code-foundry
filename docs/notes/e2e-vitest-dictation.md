# e2e → vitest: dictation

Part of the plan in `e2e-unit-duplicates.md`: write the component tests e2e alone covered, then
drop the e2e tests. `e2e/dictation.spec.ts` had 19 tests; 13 moved down and 6 stay.

## Moved

* `src/components/settings/DictationSettings.test.tsx` renders the real General › Dictation
  section (`SettingsSection` with the daemon's field and section text, plus `ConfirmDialog`):
  Needs the model, Download, progress and the Downloading line, the size, switch on and Ready
  once it finishes; the switch with no model downloads instead of saving (and does nothing
  more while it downloads); one download error with a line per source; progress, speed and
  Cancel; the M1 chip and warning, Unloaded, the engine's failure on the chip (not the Model
  row), and Remove through the confirm dialog to the confirmed re-invoke.
* `src/components/settings/KeybindingsPage.test.tsx`: a keybinding row shows the command's
  title and its chord (⇧⌘M). dictation.toggle's title and chord are already checked in Go.
* `src/components/thread/ThreadComposerDictation.test.tsx` renders the real `ThreadComposer`:
  Listening… as the placeholder, Send while listening (flush, the last phrase in the draft,
  then the send), Send off in an empty prompt when not listening, Loading model… while Start
  waits, the mic disabled with the engine's failure in its label, the microphone-denied line
  and link, and a session held elsewhere stopped (with flush) before this one starts.
* `src/components/pr/PrReviewComposer.test.tsx`: the review composer's mic. A phrase lands
  after the typed text with a space, the first Escape only stops dictating and the second closes.
  `ReviewButton.test.tsx` gains "choosing a verdict hands it on and shuts the menu" (the e2e
  test checked the menu was gone).

`src/test/dictation.ts` is the shared fake of `@/api/dictation` (Watch, Session, Start and
Stop over pushable streams, calls recorded the way the mock daemon records them).
`dictationSnap()` builds a snapshot. The real store and `runStream` run over it.

## Kept in e2e, and why

* The settings search: the hit scrolls the Model row into the viewport.
* No mic while off or without the model: the mic's place left of attach (geometry).
* Listening: phrases at the real ProseMirror caret and the CSS fade of the tint.
* Escape in the prompt: Escape inside the real editor (auto-stop and disabling are in the same test).
* One composer at a time: cmd+N to the new-thread composer across routes.
* ⌘⇧M: a global chord through the keymap and the focused region.

A later PR can split the last four: the logic goes to vitest and the browser part stays.

## Gotchas

* A snapshot reaches the store a tick after `publish` (the fake stream yields
  asynchronously). Tests wait for `useDictationStore.getState().snapshot` to be the published
  object before they assert, or the chip still shows the previous state.
* A `vi.mock` factory for `@/stores/threadActions` that awaits `import("@/stores/compose")`
  hangs the whole file at load, because compose imports threadActions. Import it lazily inside
  the faked function.
* The fake's methods referring to the fake object itself (`sessionId = fakeDictation.sessionId`)
  made it `any` to the type-aware linter. It uses module functions and an explicit interface.
* No product code changed.
