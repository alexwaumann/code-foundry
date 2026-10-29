# Dictation 4: the GUI (2026-10-29)

PR 4 of five (design: the dictation brief, 2026-10-29; daemon: `dictation-2-daemon.md`).
The settings section, the composers' mic, the landing of phrases, ⌘⇧M, and the mock
daemon's DictationService. The microphone itself is the Wails host's (PR 3).

## What shipped

* `src/api/dictation.ts`: view models for the snapshot and session events; Watch,
  Session, Start and Stop. Download, cancel and remove are user actions, so the settings
  section runs them as the `dictation.*` commands (Remove confirms through the command's
  confirm flow).
* `src/stores/dictation.ts`: the snapshot from one shared Watch (held by refcount), this
  window's session (`active`: client, phase starting|listening|stopping, session id), the
  composers' registry for phrases and ⌘⇧M, level listeners outside React, and
  `presentDictationToggle`.
* `src/components/compose/useComposerDictation.ts` + `DictationMic.tsx`: one hook and two
  components every composer uses: the mic (left of attach), the listening pill, "Loading
  model…", and the line under the composer (microphone denied, or why Start failed).
  Composers: ThreadComposer (thread, Ember, a plugin's inline thread), the new-thread
  Composer, and PanelComposer (the PR panel's Ask and Review; a textarea).
* `dictationLanding.ts`: a TipTap extension with a ProseMirror plugin. A landed phrase is
  an inline decoration (`cf-dictated`) that fades over 1 s, then its range is dropped;
  the marker after the caret is a widget decoration while listening. Nothing reaches the
  draft's text, so no schema change and no mark to serialise.
* Settings › General › Dictation: the switch's editor (`DictationToggleEditor`), a chip
  beside its title and "Needs the model below." after its description (two new small
  registries in `keyEditors.ts`: `keyTitleChips`, `keyDescriptionTails`), and the Model
  row registered in `sectionLinks` (the trailing-row registry the Themes link uses).
  `sectionRowSearch` makes that row findable: "whisper", "voice", "model" etc. find
  General › Dictation as a section hit; "dictation" and "microphone" find the switch.
* ⌘⇧M: `dictation.toggle`'s presenter (keys/bindings.ts) and its ShowView (stores/views.ts)
  both call `presentDictationToggle`: the composer that has the keyboard, else the one
  dictating (it stops), else the content pane's composer. Added to `fieldYielded` so it
  fires from a plain textarea (the PR review composer) too.
* Mock: `mock/dictation.ts` (state, scripted sessions, a 1.5 s download, the commands),
  `/__mock/dictation[?state=…&m1=…&denied=…]`, `/__mock/dictation/script`,
  `/__mock/dictation/end`. Settings mock has the field and section.

## Decisions

* **The Watch is held only when it is needed.** WebKit gives the origin six connections
  and `streamSlots` grants five; a permanent sixth stream would cost a slot for users who
  never dictate. Composers hold it while the `dictation.enabled` setting says on (from the
  settings snapshot the GUI already has), at "inline" priority (a core stream may take its
  slot; the mic then hides until it gets one back). The settings section holds it at
  "core". The Session stream is "core" while dictating.
* **Client ids** are `<draftKey>@<useId>`: two views of one thread (the pane and a
  plugin's inline thread) are two clients, and phrases go to the one that pressed.
* **Switching composers**: Stop (flush) this window's session, or the session someone
  else holds (`snapshot.session`: another window, the CLI), then Start. Unmounting the
  dictating composer (switching threads) stops without flush: there is nowhere to land.
* **Send while dictating** stops with flush and waits for `ended` (bounded at 2 s past the
  Stop; the daemon bounds its own wait at 1.5 s), then sends what the draft holds. Send is
  enabled while listening even with an empty prompt (the flush may bring text). The PR
  composer re-reads its latest onSubmit after a tick so it sends the text the phrase made.
* **Escape** goes to the prompt's own Escape handler, after the completion card and the
  previous-prompts picker have had it, so an open popover keeps it. In the new-thread
  composer it stops dictation before its "go back" Escape; in the PR composers before
  Cancel.
* **Microphone denied**: when the snapshot says so while this window listens, the session
  is stopped (nothing will be heard) and the line shows under the composer that last
  pressed. The link opens `x-apple.systempreferences:…Privacy_Microphone` through
  `openExternal` (Wails' Browser.OpenURL, which runs `open`); the daemon's
  `view.open.url` refuses anything but http(s), so it is not the path here.
* **Start failures** show in the same line, in error colour (no toasts, per the brief).
  An engine ERROR shows the mic disabled with the failure in its tooltip.
* **Spacing**: a space before the phrase unless the caret starts the line or follows
  whitespace, one after only when a letter or digit follows straight on; the engine's
  capitalisation is kept (`lib/dictation.ts phraseAtCaret`).
* **Level bars**: seven, newest on the right, pushed by `level` events and drawn by a rAF
  loop writing heights directly (no React render per event). They fall back (half-life
  140 ms) only once events stop for 120 ms; decaying between events made a ramp, not a
  waveform.
* **The marker** is hidden in an empty prompt, where "Listening…" is.
* **Tooltip chord** reads the command's current binding and formats it the app's way,
  "⇧⌘M" (macOS order), as the Keybindings page shows it.
* **The reset arrow** beside the switch is the generic settings row's (like every bool
  whose value differs from its default). The sketch drew none; kept for consistency.
* **Model directory** in the "Downloaded once, kept in …" sentence is next to the
  settings file (`<home>/dictation`), so a `CODE_FOUNDRY_HOME` run says where it really is.

## Gotchas

* WebKit leaves focus on a closing Radix menu for a moment; an e2e that types into the
  PR review composer right after choosing a verdict must click the textarea first.
* `react-refresh/only-export-components`: the hook lives in its own file
  (`useComposerDictation.ts`); constants are in `lib/dictation.ts`.
* A composer's toolbar `ml-auto` moved from the attach button's span to a wrapper around
  mic + attach, so a hidden mic leaves the layout as it was.

## Verification

`make check` green; `make gui-e2e` green (`e2e/dictation.spec.ts`: 18 tests over the
settings states, search, keybinding, mic states, landing, Escape, Send, loading,
failure, denied, switching composers, a session held by the CLI, ⌘⇧M, the PR review
composer). Vitest: `lib/dictation.test.ts` (spacing, level decay, formatting).
Screenshots (dark and light) are in the PR body.

The real thing, once (`make build && make gui-build`, `CODE_FOUNDRY_HOME=/tmp/dict4-home`,
the model copied from PR 2's run, Apple M3 Pro): `settings set dictation.enabled true` went LOADING then READY in about 4 s; the
section showed the switch's Ready chip, "874 MB on disk" with Remove, and "This Mac: Apple
M3 Pro · 36 GB" without the M1 line. The search found the switch for "dictation" and the section
for "whisper". In the new-thread composer (No project) the mic sat left of attach; ⌘⇧M
in the prompt opened a real session (`dictation status`: listening, for `home:@…`), the
pill and the marker showed, and the bars stayed flat: the host does not stream audio
until PR 3. About 30 s later the daemon ended it for silence and the mic went back to
idle with no message. Not exercised for real: phrases landing (no microphone yet), the
denied line (PR 3's MicDenied), Loading model… after an away unload.
