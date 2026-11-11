# Selecting read-only code

Text in a read-only File tab could not be selected or copied: the body's
`-webkit-user-select: none` (index.css) inherits through @pierre/diffs' shadow root, and only
inputs, xterm and the thread's text opt back in. In edit mode the library's editor draws its
own selection, which is why that worked. A user asked for both modes to select.

## What changed

`components/code/codeCss.ts` is CSS for inside the shadow root, passed as the library's
`unsafeCSS` by `CodeFile` and `CodeDiff`:

- `[data-content]` (the code column) opts back in to `user-select: text`, with a text cursor.
- The library's buffers, hunk separators and annotations inside the column are marked
  `-webkit-user-select: none` again.
- `::selection` is `var(--cf-selection)`: the page's `::selection` rule stops at the shadow
  boundary, custom properties do not.

## Decisions

- **Opt in on the column, not on the view.** The first try put `user-select: text` on
  `.cf-code-view`, and a drag that started on the line numbers copied them ("2\n3\n4…"). The
  library marks its gutter `user-select: none`, unprefixed, which WebKit ignores (it needs
  `-webkit-user-select`). Opting in only on `[data-content]` keeps the gutter under the
  body's `none`: a drag from a line number selects nothing, and no selection crosses into
  the numbers, because they are another grid column.
- **Every read-only code view, not only the File tab.** The Diff tab (and the PR panel's
  code, the same `DiffFile`) and a thread's tool diffs use the same two components, and
  copying a line out of a diff is as common as out of a file. In a split diff a drag that
  crosses columns takes both sides in DOM order; a unified diff copies deleted and added
  lines as they show. Nothing in those views used a drag or a press on the code for
  anything else.
- **The editor keeps its own selection.** The editor's CSS has an unlayered
  `::selection { transparent }`; ours sits in the library's `unsafe` layer, so in edit mode
  theirs wins and only the editor's painted selection shows.
- A controlled marked line (`selectedLines`) is the library's own line state, separate from
  the document selection: it stays while text around it is selected.

## Checked

`e2e/code-select.spec.ts` (WebKit): a drag from mid-line across three lines copies exactly
that text with cmd+C (the `copy` event's selection; WebKit lets no test read the clipboard),
a drag starting on the numbers selects nothing, double-click takes a word and shift-click
extends it, the selection colour inside the shadow root is not transparent, and a marked
line stays marked. By hand under `make drive`: the same in the Diff tab, and the selection
colour in view mode against the transparent one in edit mode.

Not checked: the Wails window. cmd+C there reaches the page through the Edit menu's copy
role, as the thread's text does.
