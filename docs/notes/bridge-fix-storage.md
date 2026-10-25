# Phase 3, the bridge, fix: page storage across app restarts, confirm-aware timeouts, cf.on typos (2026-10-25)

Three findings from the bridge's test round (tester A's report): a page's `cf.storage` was
gone after quitting and relaunching the app (high); `cf.run` timed out while the app's own
confirm dialog was open or queued, and the command still ran afterwards (high); a typo in
`cf.on("threads")` failed silently (medium, the `cf.on` half of the finding).

## 1. Page storage

### Why localStorage could not work

The pages origin is `http://127.0.0.1:<pages port>`; the app's document is
`wails://localhost`. To WebKit the frame is a cross-site (third-party) frame, and WebKit
keeps a third-party frame's localStorage and IndexedDB partitioned and **in memory for the
session**. The stable pages port (bridge-1) keeps the origin the same across daemon
restarts, so storage survived `daemon.restart`, but nothing was ever written to disk:
`~/Library/WebKit/<bundle id>/WebsiteData/Default/` had only the `wails://` origin.

### What was tried (bounded: about 20 minutes, public API only)

A small standalone Swift harness (not in the repo) mirrored the app: a `WKWebView` whose
top document comes from a custom `wails://` scheme handler and frames
`http://127.0.0.1:<port>/page.html` (sandbox `allow-scripts allow-same-origin`). The page
counts visits in localStorage. Each run is a new process, like a relaunch.

| Variant | Result |
|---|---|
| Default `WKWebsiteDataStore` (what Wails v3 uses: it never sets one) | count back to 0 every run |
| `WKWebsiteDataStore(forIdentifier:)` (macOS 14, a persistent named store) | count back to 0 every run |
| `document.requestStorageAccess()` from the frame, run by `callAsyncJavaScript` (a user gesture to WebKit) | `NotAllowedError`, `hasStorageAccess()` stays false; even granted, WebKit's Storage Access API unlocks cookies, not localStorage |
| The same page as the top document (control) | count persists (1, 2, …) |

Wails v3 (beta.34) exposes no data-store or ITP setting at all
(`webview_window_darwin.go` builds a plain `WKWebViewConfiguration`), and the only knobs
that change third-party storage are private (`_storageBlockingPolicy`, ITP SPI), which a
bare unsigned binary should not depend on. So: no supported setting.

### What cf.storage is now

**Daemon-backed.** Raw `localStorage` stays as it is: it works for the app's session only.

- **Daemon**: `ThreadService.PageStorage(thread_id)` → `values` (key → the value's JSON
  text) and `SetPageStorage(thread_id, key, value?)` → the storage after; an unset value
  removes the key. The thread store keeps one JSON object per thread in
  `<home>/page-storage/<thread id>/storage.json` (`paths.PageStorage`,
  `Options.PageStorageRoot`, `internal/store/thread/pagestorage.go`), written atomically
  (temp file + rename), serialized by one mutex (writes are tiny, so one lock for every
  thread is the simplest way to serialize per thread). Removed with the thread and reaped
  at start like `tmp/` and `pages/` (one root list, `threadDirRoots`). Not under
  `pages/<id>`: the preview route serves that directory, and a stored token is not a file
  a page should fetch. Caps: 256 KiB per thread (the file), 1 KiB per key; over the cap is
  InvalidArgument "page storage is full (256 KiB per thread); remove something first" and
  nothing is written. A removal always goes through. A value must be JSON. A file that does
  not parse is logged and read as empty. Unknown thread: NotFound. Two RPCs rather than
  verbs: a page's own state is not a user action, and the CLI has no use for it.
- **Host** (`stores/bridgeHost.ts`): `cf:ready` carries `storage` (the thread's map; `{}` when
  the daemon cannot read it, or no thread). `{type:"cf:store", id, key, value}` (value the
  JSON text, or null) goes to `SetPageStorage`; the answer is a `cf:result` (ok, or the
  daemon's error mapped as for runs: the cap is `invalid`), so a refused write reaches the
  card's error badge like any other refusal. Every storage call of a thread (reads for a
  ready, writes) runs on one promise chain per thread, so the daemon sees them in the order
  sent and a ready never carries a map older than a write before it. After a write, every
  **other** live frame of the thread gets `{type:"cf:storage", values}`; after a refused
  write the writer gets it too, so the value it applied at once is put back.
- **Script** (`internal/bridge/bridge.js`): `cf.storage(prefix?)` reads synchronously from
  the map (`get`, `keys`), applies `set`/`remove`/`clear` to the map at once and writes
  through; they return a Promise (ignorable: a refusal is logged with `console.error`).
  Keys are `<prefix>:<key>` within the thread (the old `cf:<thread id>:` prefix is gone: the
  file is the thread's). `cf:storage` replaces the map except keys with a write of this
  page still unanswered. `set(k, undefined)` removes `k`.
- **Mock**: `mock/pageStorage.ts`, in memory for the mock's life, emptied on reset. The mock
  bridge page counts visits in `cf.storage`.

Not done: a fork does not copy its parent's page storage (its pages directory is not copied
either). Existing localStorage values from before this change are not migrated: they never
outlived an app session, so there is nothing on disk to migrate.

### The sentence the skill should say (code-foundry-pages SKILL.md, State)

> `cf.storage("<page name>")`, after `await cf.ready`: `get`, `set`, `remove`, `keys`,
> `clear`, JSON values. Code Foundry keeps it for the thread (up to 256 KiB), so it survives
> reloads and app restarts, and every page in the same thread shares it: prefix it with the
> page's name and never trust what you did not write. `get` and `keys` answer at once;
> `set`, `remove` and `clear` return a Promise that rejects when the storage is full. Plain
> `localStorage` is cleared when the app quits, so keep nothing there.

And for the capabilities `bridge` line (`commands_capabilities_rendering.go`), replacing
"cf.storage(prefix) is localStorage under this thread's keys: storage persists across
reloads and restarts and is shared by every page (raw localStorage too).":

> cf.storage(prefix) is this thread's page storage, kept by Code Foundry (256 KiB): it
> persists across reloads and app restarts and every page of the thread shares it;
> get/keys answer at once, set/remove/clear return a Promise; raw localStorage lasts only
> until the app quits.

## 2. cf.run while the app asks the user

- Host: when a run needs a confirmation (`invokeConfirmed`'s `around`), the host posts
  `{type:"cf:pending", id, reason:"confirm"}` at once, whether the dialog opens now or is
  queued behind this frame's earlier question. After a yes it posts `{type:"cf:resume", id}`.
- Script: `cf:pending` stops the call's timer and keeps what was left; `cf:resume` starts it
  again with that remainder (so a command that hangs after the user said yes still times
  out); `cf:result` settles it as before. A call can be paused and resumed more than once
  (a command whose second stage asks again).
- A page that gives up (its timeout fires before any `cf:pending`, e.g. while its first
  invoke is slow) posts `{type:"cf:cancel", id}`. The host marks the question cancelled: a
  queued one is never shown, an open one is dismissed as declined, and the command never
  runs. A frame that unmounts or loads a new document already cancelled its open question
  and skipped its queued ones (bridge-2); that path is unchanged and now has an e2e case.
- "Merge all green" with two PRs: both calls are pending from the click, each waits as long
  as the user reads, and each resolves with its real result.

## 3. cf.on with a source that is not one

`cf.on` throws `CfError` `invalid` ("cf.on: no source threads; the sources are …")
synchronously when the source is not a source: before `cf:ready` it checks the script's
own `SOURCES` (a Go test keeps it equal to `bridge.Sources`), after it the ready's
`sources`. A page without a thread checks the static list, so its subscriptions still reach
the host and come back `unavailable`. Runtime refusals still go to `onError`; without one the
default is now `console.error` (was `console.warn`). A refused `cf:on` is a `cf:result`
error, which is what the host's error badge reads.

## Verification

- Go: `pagestorage_test.go` (table: set, replace, remove, missing key, empty and long keys,
  not JSON, over the cap; each read back by a restarted manager; removal with the thread;
  an unreadable file), `api/thread_pagestorage_test.go`, `bridge_test.go` (the new message
  types; `SOURCES` = `Sources`).
- Vitest: `lib/bridge.test.ts` (parse `cf:store`/`cf:cancel`, ready's storage),
  `cfBridgeScript.test.ts` (storage reads from ready and writes through; another frame's
  map does not overwrite a write in flight; a refused write rejects and is put back; the
  clock stops on pending and resumes with the remainder; a give-up posts `cf:cancel`;
  `cf.on` throws before and after ready; default `onError` is `console.error`),
  `bridgeHost.test.ts` (pending for the open and the queued question, resume after yes;
  cancelling an open and a queued question runs neither; ready carries the storage; writes
  in order; other frames of the thread hear the map, other threads do not; a refused write
  answers the error then the stored map).
- Playwright (WebKit), `bridge.spec.ts`: two questions from one click with 1 s timeouts,
  each left open 1.5 s, both resolve ok; a page that reloads while its question is open
  takes the dialog with it and the command never runs; `cf.on("threads")` throws in the
  page; a fresh browser context (no localStorage) reads the page's stored visit count.
  `inline-html` and `file-tabs` specs green too.
- Real app, isolated home: `make gui-build`, a no-project Haiku 5.5 thread showing the mock
  bridge page with `view inline`: visit 1 and `{"visits":1}` in
  `page-storage/<id>/storage.json`; the GUI quit (SIGTERM: a system password prompt held
  key focus, so Cmd+Q was eaten) and relaunched: visit 2, `{"visits":2}`.

## Gotchas

- bridge.js's header comment is rendered into the pages skill (`{{cf.bridgeAPI}}`), which
  `internal/skills/pages_test.go` caps at 160 lines and pins line by line. The header grew
  by one line here (the storage line and a sentence on pending calls and `cf.on` throwing);
  the full storage contract lives in the skill's State section (the sentence above).

- A test harness that runs bridge.js with a fake `window` needs `console` on it: the script
  logs through `window.console`.
- In the mock, `thread.archive` ignores `args.id` (it archives the context thread, the page's
  own), so archiving from the bridge page takes the user away and unmounts the card. The
  two-questions case restarts the busy `s-1` instead (`thread.restart` honours `id`).
- The app's confirm dialog is modal, so an e2e cannot close the card under it; the unmount
  case reloads the frame from inside instead.
