# The File tab's pencil keeps the reader's place

A user scrolled a file (or stepped to a match with the tab's find), clicked the Edit pencil, and
the view jumped back to line 1. Leaving edit mode on a short file did the same, and so did Discard.

## Cause (reproduced with `make drive`, a 120-line and a 600-line file)

Two separate things, each confirmed by turning off the other's fix in the drive and in the e2e test.

1. **Entering edit mode: the focus scrolled.** The pencil asked the next editor to take the keyboard
   (`focusNextEditor`), and when the editor attached `noteEditor` called the library's
   `editor.focus()` with no options. `@pierre/diffs` (1.5.2, `dist/editor/editor.js` `focus` and
   `#focus`) then focuses its contenteditable with `preventScroll: false`, which scrolls the
   caret (line 1, column 0 of a new document) into view. Both short (not virtualized) and long
   (virtualized) files jumped. The library's attach path does not scroll a new document:
   `#initSelections` is never set, and `setViewState` with `#scrollToPrimaryCaret` only runs for a
   resumed draft (`restoreEditorStateOnSync`). We never pass `ownsVerticalViewport`.
2. **Leaving edit mode, and Discard/Reload: the box was emptied for a moment.** Turning the editor
   off re-renders the library's rows, and Discard/Reload remount the `File` (`key={revision}`).
   While its rows are swapped, a box laid out whole (a short file) is momentarily short, and the
   browser clamps `scrollTop` to 0. There is no scroll call at all: no focus, no `scrollIntoView`,
   and the scroll event comes after the mutations. A long file kept its place on leaving
   (CodeScroll keeps its height), but lost it on Discard, whose remount starts the virtualizer over.

## Decisions

- **The library is not patched.** `editor.focus({ lineNumber, character, preventScroll: true })`
  already places the caret without scrolling (`#focusAtPosition` with `preventScroll`), so the
  fix is ours: `EditorHandle.focusInPlace(at)` in `lib/codeEditor.ts`. `focus(at)` keeps scrolling to
  the caret, for the callers that want that: a thread's `--focus` line (`focusEditorLine`), a clean
  document following the file with the caret it had (`follow`), and Save/Keep editing
  (`focusEditor`).
- **Where the caret goes**, worked out when the pencil (or Discard/Reload) is clicked, while the old
  view is still on screen: `components/files/readerPlace.ts`, a pure function. If the tab's find is
  open and its current match is wholly inside the box, the caret goes at the match's start, so
  typing starts where they found it. Otherwise it goes at the start of the first line whose top is
  on screen. A line cut off above is skipped: a caret half hidden would scroll as soon as the user
  types.
- The place is read through the tab's find host (`stores/fileFind.ts` `readerPlaceOf`, the code
  surface's `place` in `useFileFind.ts`). The host is already registered for every code body
  that shows, bar open or not, and already knows the current match and the rendered rows. Rendered
  markdown has no `place` (the pencil switches it to source, a new body that opens at its top), so
  the caret goes where the library puts it, still without scrolling.
- `focusNextEditor(key, here)` always means "stay put" now. Its three callers (pencil, Discard,
  Reload) all want that. `nextFocus` carries `{ here }` beside the existing place and `{ lineEnd }`
  forms.
- **The re-render clamp** is handled by `useKeepTopLine`, which already notes the top line after
  every scroll and puts it back after a width change. It now also takes a `view` key (CodeBody
  passes `active:revision`). When the key changes, a layout effect starts the same restore loop.
  A layout effect runs in the commit that re-rendered the rows, so it runs before the scroll event
  that would have noted line 1 as the new top. When nothing moved, the loop sees a delta of 0 for
  three frames and stops.
- A tab opened at a line with `edit=1` is unchanged: that path never asks for focus, and
  `useScrollToLine` puts the line a third down as before (checked in the drive with `:300`).

## Tests

- vitest: `readerPlace.test.ts` (match on screen, off screen, cut off or not rendered; first whole
  line; nothing on screen), `codeEditor.test.ts` (`focusInPlace` passes `preventScroll`, `focus`
  does not), `fileEdit.test.ts` (the next editor gets `focusInPlace` once, and `focusEditorLine` still
  scrolls), and `FileTab.test.tsx` (the pencil and Discard hand the find host's place to the next
  editor and never call `focus`).
- e2e (`file-edit.spec.ts`, "the pencil keeps the reader's place…"): in a 600-line file it scrolls
  down, clicks the pencil, types, and checks that the character lands on the first whole line on
  screen and that the view did not move. It then does the same after Discard. In a 120-line file
  it turns the editor on and off and checks the top line. It fails without either half of the fix:
  without the focus change the typing lands on line 1; without the `useKeepTopLine` change Discard
  loses the place.

## Gotchas

- An e2e check that only polls the top line after the pencil can pass before the jump happens:
  the editor attaches a frame or two after its contenteditable shows. Typing a character first
  waits for the focus, which is the moment the old code scrolled.
- The mock's `fs/write` takes the text in the query string, and Node refuses a request line over
  about 16 KB (HTTP 431). A long test file needs short lines (`line N`).
- In `FileTab.test.tsx`, the real CodeBody registers its find host again whenever the editor's
  document changes (its surface depends on the draft key). A stand-in host registered by a test
  is replaced at that point, so it has to be registered again after the pencil.
