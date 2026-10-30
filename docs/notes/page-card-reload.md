# An inline page's card reloads after any write of its file (2026-10-30)

A user's thread showed `$CODE_FOUNDRY_PAGES/welcome.html` with `view.inline`; the page
threw on load (`cf.on("project-list")`, no such source) and the card showed jsx.js's red
box. The thread then fixed the file with `cp` over the same path, later `touch`ed it, and
ran `view.inline` again ("updated the page already shown … its card reloads after every
edit"). The card kept the old error box for minutes; only `--again` (a second card)
showed the fix.

## Root cause

There was no watcher. The card (and its Expand modal) reloaded only on `useToolEdits`:
a finished Edit, MultiEdit, Write or NotebookEdit in the visible thread's log whose
`file_path` is the page. A Bash write (`cp`, `cat >`, `sed -i`, a script), a `touch`, a
subagent's or another thread's edit, or the user's editor changed the file with no such
item, so nothing reloaded. The error box played no part: a reload of an errored page works
(the frame is keyed by a version, and a new key is a new document). The reused
`view.inline` adds no item and changes none (unless the title changes), so it reloaded
nothing either.

## Fix (GUI only)

- `stores/fileStamps.ts`: one watch per file shown, shared by every view of it. It reads
  the file's stamp (`api/files.ts statFile`: ReadFile with `max_bytes` 1, so only the
  8 KiB sniff head is read; the stamp is "<size>:<mtime ms>", "" when missing) when the
  first view mounts, every second while the window is visible, and at once when it
  becomes visible again. A different stamp calls the listeners; a missing file calls
  nothing until it is back. The last view to unmount stops it.
- `useFileChanges(abs, onChange)` (`components/files/useTabRead.ts`) is that watch plus
  `useToolEdits` as a nudge: a finished Edit or Write of the file reads the stamp at once
  instead of reloading by itself, so a tool edit still shows without the second's wait
  and loads once, not twice (once for the tool item, once for the stamp).
- `HtmlCard` and `PageModalBox` use it instead of `useToolEdits`.

## Decisions

- **A poll, not a stream or a daemon watcher.** WebKit gives the daemon six HTTP/1.1
  connections and a server stream holds one for its life
  (docs/notes/plugins-12-renderer-defects.md); a stream per visible card would eat the
  slots. A daemon-side watch published on the event bus would need interest registration
  (which files are on screen, per client) for a few small files; a stat a second of the
  cards on screen is cheaper than that machinery and catches every writer. Only mounted
  cards poll: a closed card and a row scrolled out of the virtualized timeline hold no
  frame and no watch.
- **mtime + size, no hash.** Every write style moves the modification time (`cp` over the
  same inode, an editor's in-place write, an atomic rename-replace, `touch`). Size guards
  two writes in one millisecond. Reading contents to hash them would cost a full read a
  second for nothing more.
- **`touch` reloads.** The user's step 2 expected it, and it is the one way to rerun a page
  without changing it.
- No daemon or proto change; `view.inline`'s "its card reloads after every edit" is now
  true as written.

## Gotchas

- The mock daemon's ReadFile returned `modifiedAt = now - 2 min` on every call, so a
  stamp changed each second and every page reloaded in a loop. Fixtures now have one
  fixed time and `MockFiles.write` stamps its write (`/__mock/fs/write?…&touch=1` moves
  only the time).
- bridge.js throws `cf.on: no source …` inside the page; nothing reaches the card's strip
  (no page-errors badge), so the e2e checks the page's own error text, not the strip.

## Follow-up (not done)

- The File tab reads again on worktree changes, tool edits and the window becoming visible only, so a
  page outside every project (all of `$CODE_FOUNDRY_PAGES`) opened with `--panel` does
  not follow a Bash write either. `useFileChanges` would fix it with one line in
  `FileTab.tsx`, but `file-tabs.spec.ts` counts the mock's reads, so it needs its own
  change.

## Verified

- `stores/fileStamps.test.ts`: a table of write styles (in place with a new size, `cp`
  with the same size, `touch`, no write, removal), a file coming back, baseline, shared
  watches, hidden window, the tool nudge, a failed read.
- `e2e/page-card-reload.spec.ts` (mock): a healthy page reloads on a write in place, a
  same-size rewrite and a touch, and not without a write; a page that errored on load
  reloads on touch (and fails again) and on the fix; the Expand modal reloads too. The
  inline-html, inline-page-*, bridge and file-tabs specs still pass.
- Real daemon and GUI on a scratch home, with a React page (jsx.js + bridge.js) that calls
  `cf.on("project-list")`. Built from main's card: `cp` of the fixed file, then `touch`,
  then `view.inline` again ("updated the page already shown …") left the error box up.
  With the fix: `cp` showed the fixed page within the second, an in-place write
  (truncate and write, same inode) showed the edit, `touch` alone reran it (its
  load-time stamp changed), and copying the broken page back showed the error box again.
