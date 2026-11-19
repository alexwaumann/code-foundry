# Page ownership in the daemon (the daemon half)

A page got its thread's bridge only when the GUI's in-memory log of the thread showed the
page (`usePageThread`), so a page outside a thread's pages directory lost its bridge
whenever the thread's view had not been open in this window (`page-bridge-without-log.md`
fixed only files under `<home>/pages/<id>/`). Now the daemon keeps who owns every page file
and the user's answer for pages no thread owns, and answers both with the preview's grant.
The GUI half (a later PR) mounts frames from this answer and never reads a thread's log for
it.

## The rules

1. **Owner.** A page file is owned by the thread that last showed it or wrote it; latest
   wins:
   - shown: `view.inline` (the thread store's `ShowHTML`, a reused card too) and
     `view.open.page` (the command, after the tab opened);
   - written: a `Write`, `Edit` or `MultiEdit` call of Claude's (the thread's own or a
     subagent's) on an absolute `.html`/`.htm` path, once its tool result says it
     succeeded.
   A file in a thread's pages directory (`<home>/pages/<id>/…`) is that thread's unless a
   later thread showed or wrote it. A file directly in the pages root (the welcome page) is
   no thread's.
2. **Removal.** `page_owners.thread_id` references `threads(id) ON DELETE CASCADE`, so the
   removal that deletes the thread's row deletes its records in the same transaction; the
   page becomes ownerless and falls under rule 4. `removeThreadTmp` is unchanged (pages
   directory and thread page storage deleted as before). A record whose thread the thread
   store no longer has (a row not yet gone) and a pages directory of a missing thread also
   read as no owner (`Options.ThreadExists`).
3. **Owned pages are allowed automatically**, with the owner's bridge.
4. **Any other page is asked about once.** The answer (allowed / refused) is kept per file,
   keyed by its absolute path with symlinks resolved, and never asked again when the content
   changes. The user changes it with `page.allow` / `page.disallow`. The answer is kept even
   while a thread owns the page, and counts once none does.
5. **Floor.** Ownership, answers and storage exist only for a regular `.html`/`.htm` file
   whose resolved path is under home or the pages root, and which the preview's floor does
   not guard (`preview.Grants.Guarded`, asked of the path as given and resolved). A temp
   folder file is not a page here: it is everyone's (the same reason `view.open.page`
   refuses it).

### A tab linked to thread X showing a page owned by thread Y

The page gets **Y's** bridge, and the GUI names Y. The answer does not depend on the tab:
the owner is the thread that last showed or wrote the file, so it is the thread whose
storage the page's data is in and whose context its `cf.run` calls mean. Giving it X's
bridge would split one page's storage across threads and let any thread borrow another's
page by opening it; giving it none would break the plain case of a user opening a page
from one thread's card in another thread's tab. So `PreviewFileRequest` takes no thread.

### Last edited

"Last edited" is recorded for Claude's own file tools only. A page written by a Bash
redirect, a script or a build is not seen; it is owned once a thread shows it. A user's own
edit (the File tab's save) changes nothing.

## Contract for the GUI

### `FilesystemService.PreviewFile` (already called before the frame mounts)

`PreviewFileResponse.page` (`PageAccess`, new) alongside the unchanged `page_thread`:

| field | meaning |
|---|---|
| `path` | the resolved absolute path; **send this** to `PageService` and the `page.*` commands. Empty with `UNAVAILABLE`. |
| `owner_thread` | the thread whose bridge the page gets; empty for none |
| `owner_source` | `SHOWN`, `WRITTEN`, `PAGES_DIRECTORY`; `UNSPECIFIED` without an owner |
| `consent` | `OWNED`, `ALLOWED`, `REFUSED`, `NOT_ASKED`, `UNAVAILABLE` (what to do, below) |
| `answer` | the user's own answer: `ALLOWED`, `REFUSED`, `NOT_ASKED` (`UNAVAILABLE` with `consent`) |
| `unavailable_reason` | why `UNAVAILABLE` (not .html, outside home, a link out of home, missing), for a notice |

What the GUI does with `consent`:

- **unset `page`** (an older daemon): today's behaviour (`page_thread`, the log scan).
- **`OWNED`**: make the host with `thread = owner_thread` whatever thread the tab is
  linked to; name the owner when it differs from the tab's thread. Storage
  `ThreadService.PageStorage/SetPageStorage {thread_id: owner_thread}`, fetch
  `ThreadService.ProxyFetch {thread_id: owner_thread}`, `cf.run` with the owner as the
  thread context, as today.
- **`ALLOWED`**: the threadless bridge. `cf:ready` carries `thread: null`. Storage
  `PageService.PageStorage {path}` (load) and `PageService.SetPageStorage {path, key,
  value}` (each write; unset `value` removes). Fetch `PageService.ProxyFetch {path, url,
  method, headers, body, timeout_ms}`. `cf.run`: app-wide commands with no thread context;
  a command that needs a thread refuses, and the bridge says the page is not a thread's.
  `cf.on`: app-wide sources only; a thread source refuses, saying so.
- **`NOT_ASKED`**: no bridge until the user answers. Ask once; Allow invokes
  `page.allow {path}`, Don't allow invokes `page.disallow {path}` (CommandService.Invoke,
  args `{"path": page.path}`). The command's JSON (`PageView`, below) is the new state:
  mount from it, or read `PageService.GetPage` again.
- **`REFUSED`**: no bridge, no question; offer a way to allow it later (`page.allow`).
- **`UNAVAILABLE`**: no bridge, nothing to ask.

There is no event when an owner or an answer changes. Read `PreviewFile` again when the
frame reloads (an edit, a reload); the answer after a `page.*` command is in its result.

### `PageService` (new, `proto/codefoundry/v1/page.proto`)

| RPC | request | response |
|---|---|---|
| `GetPage` | `{path}` | `{page: PageAccess}` (never `UNAVAILABLE`: such a path is an error) |
| `PageStorage` | `{path}` | `{values: map<key, JSON text>}` |
| `SetPageStorage` | `{path, key, optional value}` | `{values}` after the change |
| `ProxyFetch` | `{path, url, method, headers, body, timeout_ms}` | `{status, headers, body, url, status_text}` |

`path` may be absolute or `~/…`; use `page.path`. Error codes:

| code | meaning |
|---|---|
| `FailedPrecondition` | storage/fetch: the user has not answered for the page yet (ask) |
| `PermissionDenied` | storage/fetch: the user did not allow it; any RPC: a guarded file |
| `InvalidArgument` | not an absolute (or `~/`) path to a regular .html/.htm file under home or the pages root; a bad storage key (empty, over 1 KiB) or value (not JSON); storage over 256 KiB per page; and every fetch refusal `ThreadService.ProxyFetch` has |
| `NotFound` | no file at the path |
| `DeadlineExceeded`, `ResourceExhausted`, `Unavailable` | fetch: as `ThreadService.ProxyFetch` |
| `Unimplemented` | fetch: a daemon without a fetch client |

The daemon enforces consent itself: storage and fetch for a `NOT_ASKED` or `REFUSED`
page are refused whatever the GUI sends. An owned page may also use `PageService` (it is
allowed), but its frame should use its owner's thread storage, so one page's data stays in
one place.

### Commands

| verb | args | does |
|---|---|---|
| `page.get` | `path` (positional) | read-only: the page's owner and answer |
| `page.allow` | `path` | the user allows the page (kept per resolved path) |
| `page.disallow` | `path` | the user does not allow it ("stop allowing" after allowing) |

All three: category `Pages`, `NoPalette` (they need a path the palette cannot give; the
GUI's question and its controls invoke them), `NoKeybinding`, `NoIndex` (the user's
answers, not an agent's work; the guide was also at its budget), page class `PageState`.
`page.allow` and `page.disallow` refuse a call from a page (`Origin = PAGE`) with
`PermissionDenied`: the answer is the user's about that page's script. Errors: the
`PageService` codes for the path. JSON (`PageView`):

```json
{"path": "/Users/me/p/report.html", "owner_thread": "s-…", "owner_source": "shown|written|pages-directory|",
 "consent": "owned|allowed|refused|not-asked", "answer": "allowed|refused|not-asked"}
```

## On disk

- Migration `0067_pages.sql`: `page_owners (path PK, thread_id FK threads ON DELETE
  CASCADE, how, updated_at)` and `page_consent (path PK, allowed, updated_at)`. Additive:
  empty tables, nothing existing is read or rewritten. The way back from 0061 drops both
  (`wayback/0061_layout.sql`), so pages outside a pages directory are asked about again
  after a downgrade and re-upgrade.
- Threadless storage: `<home>/page-file-storage/<first 16 bytes of sha256(path), hex>/`
  holding `storage.json` (the same format, 256 KiB and 1 KiB key limits and atomic write as
  a thread's, now shared in `internal/pagestorage`) and `path` (the page it is for). Not
  under `page-storage/`, whose directories are reaped when no thread has their name.
- **A deleted or moved file**: at each daemon start the store removes the storage of every
  page whose file does not exist and whose storage was last written more than 30 days ago
  (`page.SweepAfter`), and any directory that does not say whose it is. A moved page
  starts empty at its new path and is asked about again there (the answer is per path).
  Owner and answer rows stay: they are small, and a file that comes back at its path (a
  branch switch) is the same page, with its storage if it came back within the 30 days.
  A file that cannot be looked at (no permission, its volume not mounted) is not known to
  be gone, so its storage stays. (The first version swept at once on any stat error, which
  would have emptied a page whose branch was not checked out when the daemon started.)

## Decisions the brief left open

- Owners and answers live in a new store, `internal/store/page`, not the thread store; the
  thread store tells it through `PageRecorder` (`SetPageRecorder`, set in `daemon.go` once
  the preview's grants exist), and `view.open.page` through `ViewDeps.PageShown`.
- `view.open.file` records nothing: it is the verb for showing a file without the bridge.
- A file directly in the pages root (the welcome page) can be asked about like any page
  under home; it does not use the bridge.
- `proxyfetch`'s per-thread cap is a cap per key: `thread:<id>` for a thread's pages,
  `page:<resolved path>` for a page no thread owns (8 at once each).
- Pages from before this change have no records. A page in a thread's pages directory is
  still that thread's; any other page shown before is `NOT_ASKED` until a thread shows or
  writes it again (no backfill from the threads' html items: that needs every item scanned
  and every path resolved, and the cost is one question per old page).

## Gotchas

- Paths are compared resolved on both sides: home and the pages root are matched as given
  and as resolved, and the pages root is resolved at each ask (it is made with the first
  page, maybe after the store).
- `json.Marshal` of the stored map compacts values (`{"a": 1}` reads back `{"a":1}`), as
  a thread's storage always did.
- The thread store records on the runner's goroutine (one SQLite write per HTML file a
  tool call wrote, bounded by a 5 s timeout); a refusal (not a page, guarded) is logged at
  debug only, as threads write many files.

## Verified end to end

A scratch daemon (its own `CODE_FOUNDRY_HOME` in a fresh `/tmp/cf-pgown.*`, short for the
socket's 103-byte limit; `advanced.claude_path` the test `fakeclaude` replaying
`write-allow.jsonl` with its path changed to an `.html` file under home), driven with the
CLI and the loopback API:

- `page get` on a new page: no owner, not asked; `page allow` through a symlink, then
  `page get` on the target: allowed; after an edit of the file: still allowed;
  `page disallow`, `page allow` again: refused, then allowed. A `.md` file and a missing
  file: exit 2 with the reason.
- `thread new --no-project --prompt …`: the fake's Write of `written.html` recorded it as
  the thread's (`written`); `view.inline plain.html --thread <id>` made the allowed
  `plain.html` the thread's (`shown`, answer kept as allowed).
- `PageService` over HTTP: `SetPageStorage` and `ProxyFetch` for a not-asked page
  `failed_precondition`, `PageStorage` for a refused one `permission_denied`; once allowed
  the value was stored and read back through a `~/…` spelling of the path; a fetch to
  loopback was refused by the fetch rules. `PreviewFile` answered `OWNED`/`WRITTEN` with the
  owner, `ALLOWED`, `NOT_ASKED` for the welcome page and `UNAVAILABLE` with the reason for a
  `.md` file.
- `thread remove`: both pages lost their owner (no rows left); `plain.html` fell back to
  the user's allowed answer. After deleting the stored page's file and restarting, its
  storage directory was gone.
