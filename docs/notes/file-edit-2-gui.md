# Editing a file: the GUI (PR 2 of 3)

The File tab edits a text file in place, on `@pierre/diffs`' own editor, and saves through
`FilesystemService.WriteFile` (PR 1). PR 3 adds the agent's `view.panel.file --edit --note`;
a tab opens with its editor on through `FileTarget.edit` (the `edit=1` tab param), which is
all it needs from here.

## Files

| Path | What |
| --- | --- |
| `src/stores/fileEdit.ts` | one session per tab per panel: the version being edited, dirty, conflict, failure; every rule below |
| `src/lib/codeEditor.ts` | the lazy `@pierre/diffs/edit` chunk (182 KB) and the library's draft memory; nothing else imports the chunk |
| `src/components/code/CodeFile.tsx` | `edit` prop; without it nothing changes for thread rows and diffs |
| `src/components/files/FileEditBar.tsx` | row two's status and buttons, the conflict and failure bands |
| `src/components/files/FileTab.tsx` | the pencil, and reads routed through `observeRead` |
| `src/api/files.ts` | `writeFile`, `canEdit`, `FileReadView.lossless` (a fatal decode of the bytes) |
| `src/keys/bindings.ts`, `src/lib/keyTarget.ts` | keys inside the shadow root |
| `src/surfaces/types.ts` | `beforeClose`, `useUnsaved`: how the panel asks without knowing about files |
| `src/stores/archiveCleanup.ts` | a thread put away keeps its dirty tabs; a removed one drops them |
| `internal/command/commands_view_file_save.go` | `file.save`, cmd+s; its Run refuses every caller |

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
* **A write and a reload never overlap.** `busy` covers both: while one is out the band's
  buttons are off and the store refuses the other, and a write that answers for a document
  the session has let go touches nothing. Overwrite then Reload once left the disk, the
  document and the baseline on three different versions.
* **A session is bound to its file.** `session.path` is the resolved path it started on.
  While a session exists the tab reads exactly that path, with no `findMissing`, `observeRead`
  ignores a read of anything else, and `found.current` is pinned to it so the tab stays there
  afterwards. Without this a deleted file's read could move an editing tab to a namesake and
  Save would write there.
* **A deleted file says so, clean or dirty.** The document stays, Overwrite makes the file
  again, and row two's Discard is enabled to leave. Reload never gives a draft up: a file gone
  by then raises "Deleted on disk", one that is no longer editable says Could not reload.
* **Keys are `panelKey + tab id`,** so two panels showing a file never share a draft; the
  library also refuses one key on two editors.
* **Where a draft goes.** On Save the document stays while on screen (undo still works) and
  is dropped when the tab leaves: the library refuses to clear a key still attached. A clean
  session keeps edit mode without contents and reads again on return. Only a dirty draft
  outlives its editor. Closing a tab drops it: the store watches the panel store.
* **A thread put away keeps its draft.** Archive and snooze reset the panel with no dialog,
  and can come from another window or the CLI, so `resetThreadPanels` keeps dirty tabs and
  leaves the panel open, for the user to find on return. Removing a thread is the user's
  explicit, destructive word, and nothing could reach its drafts after: they go.
* **Memory only, on purpose.** Unsaved edits are lost on quit, and on Restart Now, whose
  dialog does not list them. Nothing here is persisted or logged.
* **Only the window saves.** A draft is the user's to save: a thread's model must not land a
  half-typed one on disk. The GUI presents `file.save` itself, so its chord and palette entry
  never reach the daemon, and `Run` refuses everything that does: the CLI, a thread, a page's
  bridge, a plugin. A context check would not do, since a page and a plugin send a window's
  view. There is no intent and no arg. PR 3 does not need it from the CLI.
* **What cmd+S means.** The editor with the keyboard, read from the DOM (`data-code-editor`
  holds its draft key), even if it is clean: group focus moves without the keyboard, so the
  focused group's tab may be another file. With no editor focused, the focused group's active
  tab, only if the panel is open and its editor is on screen. Otherwise nothing.
* **Tab-local controls.** Pencil, Discard, Reload and Overwrite have no commands, like
  Refresh and the wrap toggle: commands would hand the CLI a way to wipe a user's draft.
* **Discard during a conflict is Reload:** the baseline is stale, so going back to it would
  show a version that is gone. Against a deleted file it leaves edit mode.
* **A clean re-read keeps the keyboard.** It remounts the editor, so the store takes the
  caret from the old one if it had focus and hands it to the next (`nextFocus`).
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

`file.save` is `editorOnly`: a thread prompt and a shell do not yield it, so cmd+S in a prompt
stays the prompt history picker's scope switch. In a text field it does nothing.

## Gotchas

* `onEditComplete` with no handler reverts, which is what we want: the tab never accepts,
  it writes, and the viewer takes its text from the read.
* Turning `edit` off releases the key into the library's memory rather than dropping it, and
  `EditStateManager.clear` refuses a key still attached. Hence `onDetached` from a passive
  effect, after the commit in which the library lets go.
* That effect's cleanup also runs when the key is not really let go: under StrictMode on a new
  component, and for a tab moved to the other group, whose new editor resumes the key in the
  same commit. A clean session then lost its document (and undo) with the tab still up. So
  `CodeFile` counts the views holding each key and asks a microtask later, with the commit over.
* The dialog's focus restore cannot reach into a shadow root (the host is not focusable), so
  Keep editing puts the caret back itself.
* `ConfirmDialog` gained a third button (`requestChoice`). There Save is the default and
  autofocused, so Enter never loses work, and the alternate is the destructive one.
* The library's document keeps every line ending as it was (`codeEditor.test.ts`, mixed
  ones too); Enter and a paste take the first line's ending.
* The library's retained states are an LRU of 100. A 101st dormant draft pushes out the
  oldest with no warning, so an editor opening on a dirty session with no draft
  (`editorOpening`) and a Save that finds none both say the edits are gone, on the last
  version known, rather than showing the seed marked Unsaved.

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

After review the same setup took: `file save` refused from the CLI, with and without
`--context-thread`; archive and snooze from the CLI over a dirty tab, the draft there on
return; a removed thread's session gone; `src/a.ts` deleted beside `lib/src/a.ts`, the tab
staying put and Overwrite making it again; a clean document's "Deleted on disk"; Reload after
the file went keeping the draft; Overwrite and Reload clicked together; a split panel where
cmd+S saved the editor with the keyboard, not the focused group's dirty tab; nothing saved with
the panel closed; a clean re-read from the worktree event keeping keyboard and caret.

Each of 24 mutations fails a test, among them the read stamps, the clock bumps after a write
and in `adopt`, the editor being given `seed`, and `onDetached` (the e2e asks the library
through `draftText`, which `__cfModule` exposes for that).
