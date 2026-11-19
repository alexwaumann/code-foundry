# A page's storage is its file's, and every thread that showed it owns it (fix/page-storage-per-file)

Fuzz findings of the pages pass: ownership #1 and #2, thread-pages #1 and #2, bridge-gui #1 (the
"two stores" half) and #5, author-docs #1. All came from two rules: one thread owned a page (the
latest to show or write it), and a page's `cf.storage` was its owner's, one blob per thread.

## What was wrong

- A page the user allowed and filled in came back empty as soon as a thread edited or showed it:
  it moved to that thread's storage. Between threads the same: thread B showing A's page moved it
  to B's empty storage. The data stayed on disk, unreachable.
- A thread's card acted for its thread with that thread's storage, while the File tab opened from
  the card acted for the latest owner with that owner's: one file, two threads, two sets of data,
  side by side.
- Removing the thread that last showed a page left it with no owner though the thread that wrote
  it still existed: the tab opened from a working card asked "Let this page use Code Foundry?".

## The rules now (decided by the user)

1. **A page's storage is its file's.** One storage per page file (keyed as everything else in the
   page store: resolved, spelled as on disk; `page-path-identity.md`), whichever thread the page
   acts for and whether or not a thread owns it. A change of owner never hides or splits it. Same
   limits (256 KiB, 1 KiB keys, JSON values) and atomic writes as before, in the per-file store
   that pages no thread owned already used (`<home>/page-file-storage/<hash>/`, `internal/store/page`).
   One route serves it: `PageService.PageStorage/SetPageStorage {path}`, which the daemon allows
   when a thread owns the page or the user allowed it.
2. **Every thread that showed or wrote a page owns it.** `page_owners` has a row per page and
   thread. Removing a thread removes its rows only; a page is no thread's (and asks, once per path,
   as before) only once none is left.

### Whom a page acts for (`cf.thread`, `cf.run`'s context, "Asked by")

| where | acts for |
|---|---|
| a thread's inline card (and its lightbox) | the card's thread, always |
| a File tab linked to a thread that owns the page | that thread |
| any other File tab (another thread's, or none) | the page's **first owner** (`PageAccess.owner_thread`), named in the footer ("Can use Code Foundry for …") |
| a page no thread owns | no thread (allowed, asked or refused, as before) |

The first owner is the thread whose pages directory holds the file, else the thread that first
showed or wrote it (`page_owners.first_at`), ties by id. It does not change when other threads show
or write the page later; it changes only when that thread is removed (the next oldest takes over).
"Stable" was the brief's word, and latest-wins was the instability the findings were about.

A card's "Open in a tab" opens the file in a tab linked to the card's thread, which owns the page
(it showed it), so the card and its tab act for the same thread with the same storage. The tab's
footer names no thread then, as for any tab of its own thread's page.

### The one behaviour this removes

Separate pages of one thread no longer share a storage. Before, every page a thread showed read
and wrote one blob, so page A could read what page B stored. Now each page file has its own.
**A page's own other files** opened in its frame (a link to `settings.html` under the page's grant,
`location` set by script) are still the same page: the frame's host keeps the storage of the file
the frame was opened on (`bridgeHost.ts` keys it by `storagePath`, not by the document's URL), so
they share it. There is no supported way for two separate page files to share `cf.storage`; the
skill says to make one page with several views (hash routes, its own files in the frame).

## The migration and the carry-over

Migration `0068_page_owners_many.sql`:

- rebuilds `page_owners` with key `(path, thread_id)` and a `first_at`; every existing row is
  kept as that thread's claim, first at its `updated_at`. Not a reset: the table shipped in tips.
- adds `page_storage_carry`, the list of what is still to carry over: every `page_owners` row;
  every page a thread's conversation showed (an html item, joined with its base directory; these
  have `record = 1`); and one row per thread for its pages directory (path `''`).

At the next start, before it serves anything, the page store (`carry.go`) carries each row:

- `record` rows first make the thread an owner of the page (`shown`, first at the item's time)
  when the path resolves to a page. This is the backfill `page-ownership-daemon.md` declined
  before; it is needed now because a card's storage goes through the path-keyed route, which the
  daemon allows only for an owned (or allowed) page. Without it, every card of a page shown before
  ownership was recorded would lose its storage.
- The thread's own blob (`<home>/page-storage/<id>/storage.json`) is merged **whole** into the
  storage of every page the row names (the pages-directory row: every `.html`/`.htm` under it).
  Nothing records which page wrote which key, so a page gets all of its thread's keys.
- Merge rule, per key: **the storage written last wins** (its `storage.json`'s modification time),
  the page's own storage among equals. In practice: a page whose data the user re-entered after it
  moved to a thread's storage shows what they entered last; keys only one side holds are all kept.
  Over 256 KiB, the keys only older storages hold are left out, oldest first.
- A page's storage that the merge changed is first copied to `storage.before-carry.json` beside it,
  once (a re-run keeps the first copy).
- Rows are deleted once carried. A crash before that carries them again at the next start, which
  gives the same result (the page's storage is then the newest, and holds the merged values). A row
  whose page's storage could not be written stays for the next start.
- A page the thread owns whose file is missing now (a branch not checked out) is carried under its
  row's key, where its storage waits like any missing page's (Sweep, 30 days).
- The thread's blob is read, never written or removed. It goes with its thread as before.

What a user with existing pages will see: each page shows what it showed before in the view it was
last used in, plus, possibly, keys its thread's other pages wrote (a page listing `keys()` without a
prefix shows them; a page reading only its own prefix sees nothing new), and a page they had
allowed and then lost to a thread's storage shows both sets merged. Pages shown before owners were
kept stop asking. Nothing is deleted.

Verified on a scratch home made by a build of `origin/main` (f98fca6) holding a per-thread blob
(`board:n 5, other:n 7`, written last), a per-file storage of an allowed page the thread then
showed (`board:n 3, cards`), a page whose only owner row had gone with its removed thread, one
whose row was deleted to look like a page shown before owners, and a pages-directory page. Started
with this build: the log said `rows=6 pages=4 changed=4 took=92ms`; `board.html` held `board:n 5,
cards, other:n 7` with the old `board:n 3, cards` in `storage.before-carry.json`; the three others
held the blob; all four were the thread's in `page_owners`; the blob and its file time were
unchanged; `page_storage_carry` was empty.

## Removing a thread

`page_owners` and `page_storage_carry` rows go with the threads row (cascade). The page store hears
`thread.Removed` (`daemon/page_storage_removed.go`) and removes the storage of every page in the
thread's pages directory, which the thread store deletes. The storage of a page anywhere else stays
with the file, for its other owners, for the user to allow, or for Sweep once the file is gone 30
days.

## Live changes

`Record` publishes `page.Changed` when the thread is new among the page's owners (not on every
show). The page source's `removed_thread` now means "this thread is no longer among its pages'
owners". A File tab's grant follows every owner's removal (`pageChanges` takes the owners), so a
tab acting for any owner reads its grant again when one goes.

## Older GUI, older daemon

- `PageAccess.owners` and `PageAccess.storage_per_file` are additive. An older GUI ignores them: it
  acts for `owner_thread` (now the first owner, not the latest) and keeps using
  `ThreadService.PageStorage`, which still answers from the thread's own blob (never rewritten). Its
  writes go there and are not seen by a page's file storage: GUI and daemon ship together, so this
  lasts until the window is relaunched after an update.
- This GUI with an older daemon: no `storage_per_file`, so a thread's page keeps its thread's storage
  (`storagePath` null in `bridgeHost.ts`), and with no `owners` the owner alone is used. Checked by
  running this GUI against `origin/main`'s daemon on a copy of the seed home: cards read the
  thread's blob, the File tab behaved as on main.

## Gotchas

- A card of a file the page store refuses (an old card of a file outside home: `unavailable`)
  keeps its thread's own storage, as before: there is no file storage for it.
- The carry list is made by SQL from `thread_items.data` (`json_extract`), not resolved: the daemon
  resolves each path at the start, so a row for a symlink or another spelling lands on the file's
  key. Rows for files that are no pages are dropped.
- `page_owners.keys()` dedupes paths now (a key has a row per owner).
- The mock (`mock/pages.ts`): owners are every thread whose log showed the file (`shownBy`) plus
  `view.open.page` and scripted owners (`at=<ms>` scripts when one first did); ShowHtml announces a
  new owner as `Record` does.

## Tests

- Go: `db/page_owners_many_migration_test.go` (rows kept, a second owner, the carry list, cascade),
  `store/page/page_test.go` (every owner kept in order, a re-show keeps its place, removal leaves
  the others), `store/page/carry_test.go` (table: thread into page, newest wins both ways, ties,
  two threads, record rows, no blob; re-run; blob untouched; the before copy; pages directory; a
  missing page; over the limit; removal cleanup), `api/page_test.go` (owners and
  `storage_per_file` in the grant), `command/commands_page_test.go` (`page get` with many owners).
- Vitest: `bridgeHost.test.ts` (a thread's page on its file's storage; a card and a tab of two
  threads hear each other; a page's own next file keeps it; a consent refusal re-reads the grant),
  `usePageThread.test.tsx` (whom a tab acts for, `pageStoragePath`), `InlineHtml.storage.test.tsx`
  (the card's thread and storage), `api/page.test.ts`, `pageAnswers.test.ts`.
- Playwright (`bridge.spec.ts`): the card and its tab are one page with another thread as first
  owner; a page's own other file keeps its storage across a real frame navigation.
