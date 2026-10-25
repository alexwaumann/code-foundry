# Phase 3, the bridge: the GUI's host (2026-10-25)

PR 2 of 3 of the bridge (phase 3). A page the model shows in a thread (`view.inline` →
`InlineHtml.tsx` → `components/files/HtmlFrame.tsx`) calls Code Foundry through
`/cf/bridge.js` (the daemon's page script, PR 1): it posts to its parent window, and the
frame's host in the GUI answers. The page never talks to the API: page → postMessage →
host → `CommandService.Invoke` with the GUI's token. This PR is that host.

## The contract (shared with PR 1, verbatim)

Page → host (all carry `cf: 1`):
- `{type:"cf:run", id, verb, args}`  args: object of strings
- `{type:"cf:on", id, source}`   `{type:"cf:off", id}`
- `{type:"cf:resize", height}` (exists)   `{type:"cf:theme:ack"}` (exists)   `{type:"cf:hello"}`

Host → page:
- `{type:"cf:ready", cf:1, thread:{id,name}|null, theme:<slot map>, readOnly:[verb names], sources:[names]}`
- `{type:"cf:result", id, ok:true, result:{text, json}}` or `{type:"cf:result", id, ok:false, error:{code, message}}`  codes: gesture (page-side only), declined, unavailable, invalid, failed, timeout
- `{type:"cf:event", id, source, event:<JSON view model>}`
- `{type:"cf:theme", ...}` (exists)

Host identifies the frame by `event.source`; post to the frame's `contentWindow` with target
origin `"*"` only when the frame is the one you mounted (never broadcast).

## What ships

- **Sandbox.** `HTML_PREVIEW_SANDBOX` gains `allow-same-origin`, so a page keeps its
  localStorage and IndexedDB; the iframe gets `allow="clipboard-write"`. Still no
  `allow-top-navigation`, still `no-referrer`. Safe because PR 1 serves `/preview/` and
  `/cf/` from a pages listener of their own (a persisted port): the page's origin is that
  listener's, never the app's (`wails://localhost`) and never the API's, whose CORS refuses
  it. The page holds no token and cannot reach the app's window.
- **`lib/bridge.ts`**: the contract as code. `parsePageMessage` (strict: `cf: 1`, an id that
  is a non-empty string or a number, args strings only; a malformed call with an id is
  answered `invalid`), `fillThreadArgs`, `readyMessage`, `okResult` / `errorResult`,
  `jsonSafe`, `BRIDGE_SOURCES`.
- **`api/bridge.ts`**: `bridgeErrorOf`, the Connect code mapping: NotFound and
  FailedPrecondition → `unavailable`, InvalidArgument → `invalid`, DeadlineExceeded →
  `timeout`, else `failed`.
- **`stores/bridgeHost.ts`**: `createBridgeHost({threadId, pageName, post})`, one per
  mounted `HtmlFrame`, with `loaded()` (the iframe's load), `receive(data)` and `dispose()`.
  - On every load and on `cf:hello`: `cf:ready` with the thread `{id, name}`, the published
    theme (`{id, scheme, vars}`, the same shape `cf:theme` carries), the read-only verb
    names (`CommandService.List` in the thread's context, `include_unavailable`, the
    commands with `read_only`; listed once per frame, again after a failure) and every
    source name.
  - `cf:run` → `invokeConfirmed` with `getUiContext({kind: "thread", id})`: the thread view's
    own context (thread, its project and worktree, its workspace, view `thread`). Every arg
    with `default_to_thread_env` that the page did not pass gets the thread's id, as the
    CLI inside the thread sends `$CODE_FOUNDRY_THREAD`; an explicit `""` stays (the CLI's
    `--flag=`). A `ConfirmationRequired` opens the app's confirm dialog (the palette's
    `ConfirmDialog`, or a command's own presenter), "Asked by `<page>`, a page in `<thread>`";
    yes re-invokes with `bind`/`args` merged (the existing stages); no answers
    `ok:false, error:{code:"declined"}`, plus `result` when the command had already done
    something (`declined`). One question per frame at a time: later ones wait for the
    answer (`requestConfirm` would otherwise cancel the open one).
  - `cf:on` → the source's slice (`stores/bridgeSources.ts`). A state source posts its
    snapshot at once (when it has one), then the whole view model after each change,
    debounced 50 ms per subscription and only when its JSON changed. `cf:off` stops it; a
    second `cf:on` with the same id replaces the first. An unknown source answers
    `cf:result` `invalid`.
  - A new document (any load: the theme reload, an edit's remount, an in-frame navigation)
    starts over: the old document's subscriptions stop, a confirmation it opened is
    cancelled, a queued one never asks, and answers still on their way are dropped.
    `dispose` (unmount) does the same for good. A closed card, a row scrolled away and a
    closed lightbox mount no frame, so nothing runs for a page off screen.
- **`stores/bridgeSources.ts`**, a registry: `thread-list` (the user's threads,
  `ThreadView[]` in order, owned ones left out), `thread` (`{thread: ThreadView | null,
  pending: ThreadPendingView[]}`, no items), `gh` (the registered projects' PR dashboard,
  `DashboardView`; the subscription holds `dashboardResource` "tracked" as the PRs page does,
  a unary read re-read on gh events), `action` (`{actions, runs}`), `plugin`, `terminal`,
  `project`, `workspace` (arrays of their views), `settings` (`SettingsSnapshotView`),
  `update` (`UpdateStatusView`), `ember` (`EmberBoardView`: live only while the app holds
  the board stream, its sidebar row, chat or Board panel; the bridge opens none) and `ui`
  (a feed: every UI intent as it arrives, no snapshot; `onDaemonEvent` in stores/events.ts
  taps the shared stream after its handlers). Everything is a view model from `src/api/*`,
  passed through JSON (dates become strings). No new stream.
- **`HtmlFrame`** takes `thread` (the owning thread id, or null) and hosts the bridge. It
  hears bridge messages only from its own frame's window (`event.source`) **and** from the
  origin its URL names (`event.origin`), and posts replies to that window with that origin
  as the target. `cf:theme` keeps its `"*"`.
- **Placements.** The inline card and its lightbox pass the thread. The File tab
  (`HtmlPreview`) learns its panel's key from `PanelKeyContext` (provided by `GroupBody`) and
  passes `usePageThread(path)`: the thread whose panel holds the tab, only when that thread
  showed this very file as a page (an html item whose resolved path is the file: the card's
  Open in side panel, `view.inline --panel`).
- **The rule for a page with no thread.** Any other HTML file in a File tab (a repo's
  `docs/index.html` from a path chip, a page another thread showed, any file on the
  Projects page's panel) gets a bridge with nothing in it: `cf:ready` with `thread: null`,
  `readOnly: []`, `sources: []`, and every `cf:run` and `cf:on` answered `unavailable`
  "this page is not shown in a thread". The thread's bridge is for pages the thread made
  and showed, not for every HTML file that happens to open beside it.
- **Proto.** `Command.read_only` (field 9) is added here so the GUI builds before PR 1; PR 1
  adds the same field and fills it, and its version wins on rebase. `CommandView.readOnly`
  and `ArgSpecView.defaultToThreadEnv` map it (set only when true).
- **`invokeConfirmed`** gains `opts.around(ask)`: the host queues each question through it
  and learns the answer (a declined call returns the `declined` result or null, which a
  caller cannot tell from success otherwise).

## Decisions

- **Origin pinned, not `"*"`.** With `allow-same-origin` a link in the page can navigate the
  frame to any site, which then is the frame's window: `event.source` alone would hand that
  site the thread's verbs. The host therefore also requires `event.origin` to be the grant
  URL's origin and posts with that origin as the target. Same behaviour for every page
  served by the pages listener; nothing for anything else. A deviation from "target origin
  `*`" in the contract's wording only; a page sees no difference.
- **Whole snapshots, not raw events**, for state sources: a page renders what it gets
  without replaying reducers, and the 50 ms debounce cannot lose anything. `ui` is the only
  feed (intents have no state).
- **The File tab's thread is the item match**, not just "the panel's thread", so an
  arbitrary HTML file opened beside a thread cannot drive it (see the rule above).
- **The gesture rule is the page script's** (PR 1): the host runs any verb a page in a
  thread asks for, as the CLI in that thread could; the confirm set is unchanged.
- **A dev hook** `window.__cfBridge` (`{hosts, subscriptions, posts}`, dev builds only, like
  `__cfTerminal`) lets e2e prove a closed card's frame let go of everything.

## For PR 1 (daemon) to match

- The preview route's `Content-Security-Policy: sandbox …` must also allow
  `allow-same-origin` (the mock's does now). A CSP sandbox without it keeps the document
  opaque whatever the iframe says: no storage, and `event.origin` is `"null"`, which this
  host refuses.
- `/cf/bridge.js`: the mock serves `mock/bridge.js`, a stand-in with this contract
  (`cf.ready`, `cf.thread`, `cf.run(verb, args)`, `cf.on(source, cb)` → off, `cf.onTheme`,
  the gesture rule via `navigator.userActivation`, acking `cf:theme` only for a page with a
  theme listener). Swap in PR 1's script when it lands.
- A `cf:on` that the host refuses comes back as a `cf:result` with its id (no event follows).

## Tests

- Vitest: `lib/bridge.test.ts` (parsing table, arg filling, reply shapes, jsonSafe),
  `stores/bridgeHost.test.ts` (ready, run in the thread's context with filled args, error
  mapping, malformed calls, confirm no/yes, one question at a time, dispose cancels and drops,
  no-thread refusals, snapshot + debounced change + off, a new document drops the old
  subscriptions, unknown source).
- Playwright (WebKit), `e2e/bridge.spec.ts` over the mock's `bridge` thread state and
  `mock/bridge-page.html`: ready; run ok (thread.list, ui.notify with the toast and the
  thread's context recorded); error mapping (unavailable, invalid); confirm no then yes;
  subscription snapshot then change; teardown on close (no hosts, no subscriptions, no posts
  after a change); storage across a reload of the page; a theme switch acked without a
  reload; a File tab on a page its thread did not show refuses; the File tab of the page its
  thread showed has its bridge. `inline-html.spec.ts` and `file-tabs.spec.ts` now expect
  `allow-same-origin`.

## Gotchas

- `requestConfirm` cancels whatever dialog is open; two pages (or a page and the palette)
  asking at once still cancel each other. Only one frame's own questions are queued.
- After cancelling a confirm in e2e, wait for the dialog to go before clicking the page
  again: the closing dialog's overlay still takes the click.
- `page.reload()` in e2e does not bring the thread back selected; reopening the card is the
  page reload that matters.

## End to end (2026-10-25, built app, isolated home)

PR 1's branch had no commits yet, so the real daemon ran with a local stand-in for it, not
committed: the preview route's CSP sandbox with `allow-same-origin`, and `/cf/bridge.js`
serving `mock/bridge.js`. Preview pages were still on the API listener (PR 1 moves them).
`make gui-build`; `gui/bin/Code Foundry` with `CODE_FOUNDRY_HOME=~/cf-bridge2-home`, the
CLAUDE* variables unset; a non-git scratch folder registered; a Haiku 5.5
(`claude-haiku-5-5[1m]`, medium) thread "Bridge check"; `mock/bridge-page.html` copied to
its pages folder and shown with `view.inline <file> --thread <id>`.

- Ready in WKWebView: "Shown in Bridge check · dark theme"; the `thread-list` snapshot
  (1 thread), then live events as the thread went to Working.
- `thread.list` → `{"threads":1}`; an unknown verb → `unavailable: unknown command …`;
  missing args → `invalid: ui.notify: missing required argument "title"` (the real verb
  needs a title; the page now sends one).
- Send a toast → the app's toast "Hello from a page / Sent through the bridge", result
  `{"windows":1,"receivers":1}`.
- With a background shell running, Archive this thread → the app's confirm dialog, "Asked
  by bridge.html, a page in Bridge check"; Cancel → `declined: the user declined`.
- Closing and opening the card twice: visit 1 → 2 → 3 (localStorage kept).
- `settings set appearance.theme light`: the page repainted light, still visit 3 with its
  results (acked, no reload).
- Found on the way: the test page painted results with `--cf-success-foreground`, the
  colour on a filled status chip (dark on dark); it uses `--cf-*-text` now.

The thread, scratch folder and home were removed afterwards.

## Daemon restart

Needed only for the proto field (PR 1 brings the daemon side). GUI and daemon ship together.
