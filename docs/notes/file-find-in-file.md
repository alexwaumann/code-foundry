# Find in a File tab

cmd+F with the keyboard in a File tab finds in its file, viewed or edited, and in a
markdown file's Rendered page. Before, view mode had no find at all (cmd+F was the thread's)
and edit mode had only the editor's own panel. A user asked for one find in both modes.
Stacked on file-view-select.md (the read-only code became selectable).

## Files

| Path | What |
| --- | --- |
| `internal/command/commands_view_file_search.go` | `file.search`, `.next`, `.previous`: ShowView intents, SharedChords with `thread.find*` |
| `src/lib/fileFind.ts` | matching per line, the cap, stepping and which match is current (`pickCurrent`) |
| `src/stores/fileFind.ts` | one session per tab, the tabs that can search (hosts), the presenter |
| `src/components/files/FileFind.tsx` | the bar: `FindBarView`, docked |
| `src/components/files/useFileFind.ts` | the body's side: count, paint, reveal, finish, for code and for rendered markdown |
| `src/components/files/fileFindPaint.ts` | the two Custom Highlights, the union of every tab's ranges |
| `src/components/code/codeCss.ts` | the `::highlight` rules inside the shadow root |
| `src/keys/bindings.ts` | `fileScoped`, `fileCommand`, the cmd+alt+F hand-off |

## Decisions

### One find, both modes

The tab has one bar, the shared `FindBarView` (a new `docked` variant), whatever the pencil
says. It searches the text itself and paints matches with the CSS Custom Highlight API, on
the library's lines in its shadow root, in view and edit mode alike. The session is keyed
by the tab (`fileEditKey`: panel key and tab id), not by the mode, so the pencil keeps the
bar, its query, its current match and its paint (both ways, checked in e2e).

The library's editor search can not be driven from outside: `SearchPanelWidget` is created
and held in private fields of `Editor` (`#searchPanel`, `#matches`), and nothing public
opens it, sets its query or reads its matches (1.5.2; `readOnly` exists in neither 1.5.2
nor 1.6.4). So rather than drive it, the app does not need it for find: in edit mode the
text is the editor's document (`onChange`, kept in the session only while the bar is open)
and the DOM is the same lines the viewer renders, so the same painter works. What the
library still owns:

- **Replace, cmd+alt+F,** stays edit-only and stays the library's panel (find and
  replace). Pressed with the tab's bar open, the bar closes and its query is typed into the
  library's search field (it reads only `input` events; `handOff`). Opening the tab's bar
  again closes the library's panel (its close button). One find at a time.
- Inside the library's panel its own chords stay its own (`[data-search-panel]`).
- cmd+D, cmd+[ / ], cmd+/ stay the editor's (`codeEditorChords`, unchanged).

Escape in edit mode puts the editor's selection on the current match and gives it the
keyboard (`EditorHandle.select`, `Editor.setSelections`), as VS Code leaves it; typing
replaces the match. In view mode Escape focuses the code and makes the match the document
selection, so cmd+C copies it.

### Commands and keys

`file.search`, `file.search.next`, `file.search.previous` ("Find in File", …), not
`file.find*`: `file.find` is Go to File (cmd+P). They share `thread.find*`'s chords
(`command.SharedChords`, as `terminal.find*` do). The keymap picks by where the keyboard is,
at the key press:

- **Keyboard in a File tab that can search** (`fileFindTabAt`: its code box, its editor,
  its header buttons; not a text field of its own, and not the library's panel) →
  `file.search*`. The tab registers as a host while its body shows text it can search.
- **Anywhere else** → `thread.find*` as before (the thread's prompt included, with a File
  tab open beside it). A File tab that cannot search (an HTML page shown rendered, an
  image, a PDF, a binary) is anywhere else.
- Rebinding follows the terminal's rule: each command has its own chords. Move
  `file.search` away and cmd+F in the tab is the editor's own find in edit mode and the
  thread's in view mode, as before this change.
- The palette lists the three only while a tab that can search is on screen
  (`canSearchFile`, like `file.save`'s `canSaveFile`). From the palette or the CLI's
  ShowView they act on the tab that had the keyboard last, else one on screen.

The descriptions' first sentences are short on purpose ("Find in the File tab."): the
plugin skill's `reference/host-commands.md` lists every command's first sentence and was
176 bytes under its 32 KiB budget (`internal/skills` TestBudgets); the detail is in a
second sentence, which the palette and `help` show.

`TestKeybindingsAreUniqueAndNotReserved` compared pairs (`SharedChords[a] == b`), which two
commands sharing one base chord (terminal.find and file.search both on cmd+f) failed. It
now compares each command's root (`sharedRoot`).

### Holding the keyboard

The read-only code box has `tabIndex={-1}` (only when the tab can search), so a click in
the code focuses it rather than the panel's `<aside>`. It is not a text field, so the
panel's letters (`d` for Diff) still reach the panel from it, checked in the browser.
Rendered markdown's scroll box does the same. Tab order is unchanged.

### Where the bar sits

A band under the tab's two header rows, full width, before the request, conflict and
truncation bands, pushing the code down by its height. Sketched in the running app (the
thread's bar cloned in with `eval` under `make drive`); rejected:

- **Floating at the code's top right** (the terminal's): in a 420px panel it covers the
  end of the first lines, which is where unwrapped code is long.
- **Floating over row two's right side**: covers the wrap toggle and the meta, and in edit
  mode Save and Discard.
- **Floating full width over the code**: covers the first two lines entirely.

### Counting and painting

- Counted from the text, not the DOM: a long file's virtualizer renders about a hundred
  lines, and every match must count. Lines split as the library splits them
  (`/\r\n|\r|\n/`), so a match's (line, place in line) is the same on screen. Smart case and
  plain substrings, as the thread's find (`matchOffsets`). Capped at 10,000 ("1 of 10000+").
- Painted per rendered line: each line's DOM text is matched again and its n-th match is
  the data's n-th on that line, as the thread's find does per item. A MutationObserver on
  the shadow root (re-attached when the library replaces it) repaints a frame after the
  virtualizer swaps lines, the editor changes text or the theme re-renders; a highlight
  moves with its text by itself, so scrolling costs nothing.
- `::highlight` rules apply only in their own tree: the code's are in the shadow root's
  `unsafeCSS`, rendered markdown's in `files.css`, both the thread find's tints. One
  highlight name for every tab: two tabs in a split panel can both search, so the painter
  keeps each tab's ranges and sets the union.
- Which match is current (`pickCurrent`): opening starts at the first match at or below the
  top line on screen; typing goes on from the current match's line and column (through a
  query with none, from where it was); an edit of the text keeps the nearest match without
  scrolling; matches arriving after none take the first from the top, in place.

### Revealing a match

The current line rendered: its match's range is placed a third down if out of view, and
any element between it and the scroller that scrolls sideways (unwrapped long lines) is
scrolled so the match clears the sticky gutter. Not rendered (a long file): the scroller
jumps by the distance in lines from the nearest rendered line, at 19px a line, and looks
again next frame for up to 3 s, which converges with wrapped (taller) lines too. Rects are
viewport px and scroll offsets layout px, so distances divide by the zoom (`lib/zoom.ts`).
The highlights are the text's own ranges, so they sit on the glyphs at any zoom; checked
at 90%, 100% and 125%. No measurement of the library's is used, so this is apart from the
editor's DOM measurement under zoom another change is fixing.

Once, stepping back and forth through a wrapped 600-line file, the virtualizer was
scrolled to the very end with no line rendered until another scroll event; a reveal that
finds no rendered line now nudges the scroller by a pixel, which makes it render.

### Rendered markdown

Searched as the page shows it: `citeDom.plainText` over the rendered page (a line per
block), read again when the page changes (images, highlighting), with an image's
placeholder chip left out (`data-find-skip`). Not virtualized, so every match is in the
DOM; the k-th match in the text is the k-th range. HTML rendered is a frame of its own: no
bar, cmd+F stays the thread's (inside the frame the page has the keys). Switching
Rendered ↔ Source keeps the bar, which then counts the other text.

## Tests

vitest: `lib/fileFind.test.ts` (matching, line breaks, smart case, cap, stepping,
`pickCurrent`), `stores/fileFind.test.ts` (sessions, steps, finish order, hand-off, a closed
tab's session, the presenter), `keys/bindings.test.ts` (cmd+f/g/shift+g from the code, the
editor, the prompt, a field in the tab, the library's panel, cmd+alt+F, a tab that cannot
search, rebinding, the palette), `FileTab.test.tsx` (the bar's place, counting and stepping,
the pencil keeping it and counting the draft, Escape, kinds with nothing to search). Go:
`commands_view_file_search_test.go`, the chord and ShowView tables.

e2e `e2e/file-find.spec.ts` (WebKit): cmd+F from the code, the paint in the shadow root, an
off-screen match on a 600-line file scrolled to and painted, Escape's focus and selection;
125% zoom; the editor (no library panel, the pencil both ways, Escape's editor selection);
the thread's prompt keeping its cmd+F; Rendered markdown.

By hand under `make drive`: wrap and no-wrap, a match at the end of a 180-character line,
90% zoom, the palette entry, cmd+alt+F's hand-off and back, a panel letter from the code.

## Not checked

- **The Wails window.** All of it ran in WebKit, not WKWebView. The Custom Highlight API is
  in Safari 17.2+; where it is missing the count and the steps still work and nothing is
  painted (no overlay fallback, unlike the thread's find).
- The daemon needs a restart to list the three commands; until then cmd+F in a File tab is
  the thread's, as before.
