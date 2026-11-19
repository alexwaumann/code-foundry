# A thread's page keeps its bridge without the thread's log

## What broke

A user's page in a File tab showed "cf.storage needs the page's thread: await cf.ready
first", though the page did await `cf.ready`.

A File tab gave its HTML page a thread only when the GUI's log of the tab's thread held an
html item for that file (`usePageThread`), or the tab carried the page flag
(`view.panel.page`). The log is in memory only while a thread view has watched the thread
in this window. In the side panel that always held: the tab sat beside its thread. In the
shell a linked tab stands alone (a pane of its own, a window restored after a restart, a
thread opened as single), so the log is often absent, the frame's host was made with no
thread, `cf:ready` carried `thread: null`, and every bridge call was refused.

## The rule now

`FilesystemService.PreviewFile` answers `page_thread`: the id of the thread whose pages
directory (`<home>/pages/<id>/`) holds the file, symlinks followed; empty for any other
file, and for a file directly in the pages root (the welcome page). A File tab linked to
that same thread gives the page the thread's bridge on the daemon's word alone. The grant
is read before the frame mounts, so the host is made with the thread from the start.

Unchanged: the tab must be linked to the thread. The same file in an unlinked tab, or in
another thread's tab, has no bridge. The log scan stays, for a page a thread showed from
outside its pages directory (a file in its checkout) and for the card's title.

## Not covered

A page outside the pages directory that the thread showed in a card still depends on the
log: opened in a tab with the thread's view never shown in this window, it has no bridge
until the thread is opened once. Closing that needs the tab to remember it was opened as a
page (the card's "Open in a tab" does not set the page flag).

## The message

`cf.storage()` said "await cf.ready first" for both cases. It now says that only before
ready; after ready with no thread it says "this page is not shown in one", as `cf.fetch`
does.

## Gotchas

- The pages root is compared after `EvalSymlinks` on both sides (`WithPagesRoot`, the
  file's `RealPath`), so a home under a symlink still matches.
- A daemon older than the field answers "", which is the old behaviour.
