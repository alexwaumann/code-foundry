# A page hears its storage change: cf.storage(prefix).onChange (feat/page-storage-change-event)

A user asked that a page shown in a thread and the same page in a tab stay in sync. Since
`page-storage-per-file.md` every copy of a page shares one `cf.storage`, and the app already sent a
copy the new map after another copy wrote (`cf:storage`), but the page was never told: the other
copy kept what it last drew until it reloaded.

## The API

```js
const s = cf.storage("counter");
const stop = s.onChange((keys) => draw()); // keys: ["n"], without the prefix
```

- **On the store, not on `cf.on`.** `cf.storage(prefix)` already scopes keys to a prefix, so the
  listener sits there and hears only that prefix's keys (no prefix: every key). `cf.on` is for the
  daemon's sources, which a Go test keeps equal to `bridge.Sources`; storage is not one.
- **Called once at subscribe**, with every key the prefix holds, as `cf.on` calls with the value
  now. It is a microtask later, so `onChange` has returned its unsubscribe first. A page then has
  one render path: `s.onChange(draw)` draws on load and on every change.
- **Then with the keys whose value changed**: set, changed or removed by another copy of the page
  (a card, a tab, another window, the page's own other files in a frame), or put back after a
  refused write of this page's. The store already answers the new values when `fn` runs.
- **Never for the page's own write.** `set`/`remove`/`clear` apply at once and do not announce;
  the app's map after them holds what the page wrote, which changes nothing here. The page draws
  after its own `set` (the skill's `draw()` "you call after each set").
- **Returns an unsubscribe** (fits `useEffect(() => s.onChange(...), [])`). A throwing listener is
  logged and the others still run.
- **An older app**: nothing new on the wire. bridge.js diffs every `cf:storage` it already
  receives, so an app that sends none leaves the listener at its first call. Every app since
  bridge-fix-storage sends `cf:storage` between frames of one window, so those copies sync even
  with an older GUI.

## How a write reaches every copy

- **One window** (a card and a tab, two tabs, two panes, a lightbox): unchanged. The host
  (`bridgeHost.ts`) hands the map `SetPageStorage` answered to every other frame joined to the
  storage (`storageFrames`, keyed `page:<resolved path>`).
- **Other windows / clients**: there was nothing. A GUI process has one window (a second launch
  shows it), but the daemon serves several clients (the app, the browser dev frontend, a second
  machine's browser). The page store now publishes `page.StorageChanged{Path}` when a write
  changed a key's value; EventService's page source carries it as `PageEvent.storage_paths`
  (a new field; `paths` stays empty, so no grant is read again). Each client's host reads the
  storage again for the frames it shows (`applyPageStorageEvent`, on the storage's call chain, so
  after its own writes) and hands them the map. One read is queued per storage at a time: a burst
  of news while it waits costs one read.
- **Reconnect** (`all`, the source's snapshot): every storage with a frame is read again, a
  thread's own too (an older daemon), since writes may have been missed.
- The writer's own window also hears the daemon's news of its write and reads once more. The map
  is the same, so bridge.js announces nothing. Accepted: writes come from clicks and typing, and
  the extra read is local.

## What it does not cover

- State a page keeps only in variables. Only what is in `cf.storage` is shared; the skill says to
  keep in storage what every copy should show.
- Two separate page files: each has its own storage (unchanged).
- A page whose card keeps its thread's own storage (an older daemon, or a file the page store
  refuses): its frames in one window sync; other windows hear only on reconnect.

## Pages skill

SKILL.md's State says to render from storage in a `draw()` called after each `set` and passed to
`s.onChange(draw)`. It stays within the 8,700-byte body budget: the header line and the sentence
were paid for by tightening the State paragraph and dropping the skeleton's alignment spaces.
`reference/sources.md` has the full contract and a counter example (and no longer says storage is
per thread); `react.md` the `useState` + `useEffect(() => s.onChange(...))` shape;
`errors-and-limits.md` points at it. No page-library React hook existed for storage, so none
changed. The capabilities `bridge` line names `onChange`.

## Verified

- Go: `store/page/changed_test.go` (`TestStorageChangedPublished`: a new key, the same value, a
  change, a removal, removing a missing key, not JSON, an allowed page no thread owns, a page not
  allowed; no `Changed`), `api/page_access_test.go` (the event on the stream), `bridge_test.go`
  (the header names `onChange`; the script announces on `cf:storage` and a refusal).
- Vitest: `cfBridgeScript.test.ts` (first call, changed keys, prefix, never its own write,
  refused put-back once, unsubscribe, a throwing listener, an app that never sends news),
  `bridgeHost.test.ts` (the daemon's news to every frame of the page, one read for a burst, none
  for a page not shown), `bridgeStorageSync.test.ts` (bridge.js wired to real hosts: card and tab
  both ways, prefix, a page no thread owns in two tabs, refused write, unsubscribe, another
  window's write, reconnect, an older daemon's thread storage), `pageAnswers.test.ts` (a storage
  event reads no grant).
- Playwright (`bridge.spec.ts`): the mock bridge page's tally, clicked in the tab and in the card,
  shows in the other without a reload.
- Real scratch dev daemon (`make drive DAEMON=dev`, own home, fake `claude` set before the daemon
  started and before any thread), the GUI in `playwright cli`: a counter page `view.inline`d in a
  no-project thread and opened in a tab. Two clicks in the tab showed in the card, one in the card
  in the tab, no reload, each copy counting only the other's writes. A second browser session
  (a second client of the daemon, standing in for a second window): a click in window A's tab
  showed in window B's card, and Reset in window B zeroed both of window A's copies. The real
  Wails app opens one window per process, so two app windows were not checked.

## Gotchas

- `SetStorage` reads the storage once before writing to know whether the key's value changed
  (`pagestorage.Set` is shared with the per-thread storage and was left alone). A value written
  with different whitespace than the file's compact form counts as a change: harmless, the page
  diff finds nothing.
- `applyPageStorageEvent` lives in `bridgeHost.ts` (it owns `storageFrames`) and is called from
  `stores/events.ts` beside `applyPageEvent`.
