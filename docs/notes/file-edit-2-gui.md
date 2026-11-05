# Editing a file: the GUI (PR 2 of 3)

The File tab edits a text file in place, on `@pierre/diffs`' own editor, and saves through
`FilesystemService.WriteFile` (PR 1). PR 3 adds the agent's `view.panel.file --edit --note`;
a tab opens with its editor on through `FileTarget.edit` (the `edit=1` tab param), which is
all it needs from here.

## Files

| Path | What |
| --- | --- |
| `src/stores/fileEdit.ts` | one session per tab per panel: the version being edited, dirty, conflict, failure; every rule below |
| `src/lib/codeEditor.ts` | the lazy `@pierre/diffs/edit` chunk (182 KB) and the library's draft memory; nothing else imports it |
| `src/components/code/CodeFile.tsx` | `edit` prop; without it nothing changes for thread rows and diffs |
| `src/components/files/FileEditBar.tsx` | row two's status and buttons, the conflict and failure bands |
| `src/components/files/FileTab.tsx` | the pencil, and reads routed through `observeRead` |
| `src/api/files.ts` | `writeFile`, `canEdit`, `FileReadView.lossless` (a fatal decode of the bytes) |
| `src/keys/bindings.ts`, `src/lib/keyTarget.ts` | keys inside the shadow root |
| `src/surfaces/types.ts` | `beforeClose`, `useUnsaved`: how the panel asks without knowing about files |
| `internal/command/commands_view_file_save.go` | `file.save`, cmd+s |

## Decisions

* **The draft is the library's.** Its `EditStateManager` holds each `editStateKey`'s document
  and undo history in memory, on or off screen. The session only compares. So Save works on
  a tab that is not showing, and the close dialog needs no mounted editor.
* **Nothing feeds a document it did not start from.** A new `file` prop replaces the
  document, so while a session has one the tab renders `session.seed`, which never changes
  for that document, not even after a save (it would reset caret and undo). Every read,
  whatever triggered it, goes to `observeRead`: dirty compares size and time and at most
  raises the band; clean follows the file with a new document.
* **A new document is a new `stateKey` and `revision`.** Discard, Reload and a clean re-read
  remount the editor on a fresh key; the old key is dropped once the library has let go.
* **Reads and writes race.** A read that left before a save and answers after it reports the
  old version, a false conflict. Reads are stamped with `editClock()` when they leave;
  a session ignores any older than its last write.
* **Keys are `panelKey + tab id`,** so two panels showing a file never share a draft; the
  library also refuses one key on two editors.
* **Where a draft goes.** On Save the document stays while on screen (undo still works) and
  is dropped when the tab leaves. A clean session keeps edit mode without contents and reads
  again on return. Only a dirty draft outlives its editor. Closing a tab, however it goes
  (a panel dropped with its thread too), drops it: the store watches the panel store.
* **Memory only, on purpose.** Unsaved edits are lost on quit. Nothing here is persisted or
  logged; `file.save` has no args, and the intent is its name alone.
* **Save the focused group's active tab.** `file.save` needs no target because the window
  knows which that is. It is always available (only a window knows what is editing); the
  palette lists it only over an editing tab.
* **Discard during a conflict is Reload:** the baseline is stale, so going back to it would
  show a version that is gone. Against a deleted file it leaves edit mode.
* **Source for this tab only.** Entering edit overrides the mode locally, so the remembered
  Rendered stays. Rendered while clean leaves edit mode; dirty, the switch is hidden.
* **The meta is the last saved version's,** not live: counting bytes per keystroke buys little.
* **A long file stays on the path it started on.** `virtual` comes from the seed's line
  count: flipping it would remount the editor mid-session.
* **Theme.** The pale box around the active line is the library's: with no
  `editor.lineHighlightBackground` it draws `box-shadow: inset 0 0 0 1px` in a bg/fg mix.
  `lib/codeTheme.ts` sets the Shiki theme's editor colours, which `tokenizer.js` turns into
  the `--diffs-editor-*` variables, so caret, selection, find matches and active line come
  from every theme's slots. Find matches were hard-coded orange.

## Keys

Inside a shadow root `e.target` is the host at any listener outside it, so
`isEditable(e.target)` is false and the app took cmd+f, and the side panel took bare letters
(typing `d` opened the Diff tab). `keyTarget()` reads `composedPath()[0]`.

`handleKeyDown` treats the editor like a thread prompt: it types, and cmd chords bound to
commands still fire (cmd+s, cmd+j, cmd+p), except `codeEditorChords`: cmd+f, cmd+alt+f, cmd+g,
cmd+shift+g, cmd+d, cmd+[, cmd+] and cmd+/, which are the library's. So Back and Forward do
not work from the editor, on purpose: those chords indent there. The global view actions
(cmd+k, cmd+b, cmd+1..9, zoom) still win; the library binds none of them.

## Gotchas

* `onEditComplete` with no handler reverts, which is what we want: the tab never accepts,
  it writes, and the viewer takes its text from the read.
* Turning `edit` off releases the key into the library's memory rather than dropping it, and
  `EditStateManager.clear` refuses a key still attached. Hence `onDetached` from a passive
  effect, after the commit in which the library lets go.
* That effect's cleanup also runs under StrictMode on a new component whose editor stays:
  a clean session then lost its document with the tab still up, stuck in the viewer. The check
  waits a microtask for the effect to run again. Only reachable from a rendered file, whose
  editor mounts rather than flips.
* The dialog's focus restore cannot reach into a shadow root (the host is not focusable), so
  Keep editing puts the caret back itself.
* `ConfirmDialog` gained a third button (`requestChoice`). There Save is the default and
  autofocused, so Enter never loses work, and the alternate is the destructive one.
* The library's document keeps every line ending as it was (`codeEditor.test.ts`, mixed
  ones too); Enter and a paste take the first line's ending.
* The library's retained states are an LRU of 100: a 101st dormant draft would push out the
  oldest. Not handled.

## Not tested

* **The Wails window.** Everything ran in WebKit, not WKWebView. cmd+V there should reach the
  `paste` event through the Edit menu's role, as the composer's does, so the library's
  `clipboard` option stays unset (it would call `navigator.clipboard`, which prompts).
* **A real paste.** The e2e dispatches a `paste` event: a real cmd+V would use the machine's
  own clipboard.
* **IME.** The library handles composition and `handleKeyDown` skips composing keys, but
  Playwright cannot compose.

## Checked

Vitest for the states, guards and calls; `e2e/file-edit.spec.ts` for the editor itself. A
scratch dev daemon (own `HOME` and `CODE_FOUNDRY_HOME`) took a 0600 CRLF `.env`: the save left
mode and endings alone, Refresh after it raised nothing, a 0400 file failed with the daemon's
message and the draft kept, a write from outside raised the band on its own within seconds of
the worktree event, Overwrite won, a deleted file came back at 0600, a Latin-1 file and a
BOM file offered no pencil, a 700-line file saved through the virtualizer, and a README saved
from Rendered. No contents appeared in the daemon's logs.
