# Previews fuzz fixes (2026-11-15)

Three findings from a fuzz pass over the File tab's format previews (#727-#744, #747), fixed in
one PR. Each was reproduced on a dev daemon with real files before the fix and checked there
after it.

## 1. A `file:line` open into a preview kind ignored the line (regression)

A path chip (`data/big.json:24012`), the finder's Text mode Enter, or `view.open.file --line`
into a JSON, CSV, JSON Lines, log, patch or Mermaid file opened the kind's preview (Tree, Table,
Rendered, Diagram) at the top. Before the previews these files were code, opened at the marked
line. FileTab picked the remembered mode whatever `target.line` was, and only the code view
takes a line.

Fix: a tab opened at a line shows Source there, for that tab only, the way editing does, until
the user picks a mode. The pick is remembered as any pick is, and the remembered per-kind mode is
never written by the line. The tab notes the line the pick was made at (`pickedAt`), so the next
chip into the same tab at another line goes to Source again. Markdown and HTML opt out with a
new `PreviewKind.line: false`: their rendered view reads as a page, and a markdown file opened
at a line was already Rendered before the previews (FileTab.test's markdown case pins it). A kind
with no text (image, PDF, video) has no Source and is unaffected.

A tail read (a log over the 1 MiB window, `truncatedStart`) numbers its Source from the cut, so
the file's line is not one of its lines. It opens as usual (Rendered at the bottom, under the
existing tail notice) and its Source marks nothing; before, a remembered Source marked the wrong
line. No mapping from file lines to the window was added: the read has a byte offset, not a line
count.

## 2. An open gitignored log never re-read inside a project

Inside a project the File tab re-read only on `worktree_detail_updated`, which the daemon sends
only when the git summary changes. A gitignored file never changes it, and a binary file (an mp4
being written) changes it once. So `tmp-logs/dev.log` stayed as it was opened.

Fix: the file-stamp watcher (`useFileChanges`, stores/fileStamps.ts) now runs for every File
tab, not only outside projects. It also covers the thread's own edits (it checks the stamp at
once), so the separate `useToolEdits` call went. The watcher is shared per path and stops when
the last view of it unmounts, so nothing off screen polls.

A tracked file's change now reads twice: the stamp poll and the worktree event, about a second
apart. The second read is the same content, and the same kind of read an unrelated worktree
change already causes. On the dev daemon a CSV's table kept its scroll place across both, and
the code view kept its DOM nodes (nothing redrawn). A media file's player keys on size and
mtime, so a same-stamp read does not reload it.

## 3. Gantt charts were 2000 px wide

Mermaid's Gantt renderer takes the width of the box it draws in (the other types size to their
content), and render.ts draws in a 2000 px off-screen box. Every Gantt chart had a 2000-wide
viewBox and showed at the 60% floor (1200 px) with labels about 7 px tall.

Fix: `gantt: { useWidth: 800 }` in the config. The viewBoxes of a wide flowchart, a sequence,
class, state and ER diagram are unchanged (checked before and after on the dev daemon). In a
pane under 480 px a Gantt chart still scrolls a little, like any diagram at the 60% floor.

## Left out

Nothing from findings 1-3. The report's other items are features or documented design.
