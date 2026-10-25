# Bridge fix: frames, nonces and host limits (2026-10-25)

The GUI half of the bridge's sandbox round (phase 3; `bridge-2-gui.md`, `bridge-fix-c-gui.md`,
`bridge-fix-storage.md`). Testing found three things on the host side: a frame that
navigated itself to another page's grant kept its thread's bridge (every grant shares the
pages origin, and the host checked window and origin only; each `load` even re-sent
`cf:ready` for the original thread); a page with no owning thread (a File tab on an
arbitrary HTML file) could reach a thread page's `window.cf` through `parent.frames`, and the
host credited that thread; and nothing bounded what a page could hold at the host (a
duplicate `cf:run` id ran twice, no rate or size limit, and a page's timed-out
`thread.wait`/`action.wait` kept running in the daemon). The daemon half (preview floor,
Host header, read-only marker, waits ending on request cancellation) is
`bridge-fix-floor.md`.

## The contract, as it is now

Supersedes the contract section of `bridge-2-gui.md` (and `lib/bridge.ts`'s header says the
same).

- **The frame's nonce.** `HtmlFrame` opens every page at `<grant URL>#cf=<nonce>`: 128 random
  bits in hex, one per mounted frame (`frameNonce`, `withNonce`; after the URL's own fragment
  as `&cf=` when it has one). A fragment never reaches the server, survives a reload, and is
  lost by any navigation to another URL, which is the property wanted.
- **Page → host: every message carries `cf: 1` and `nonce`.** `bridge.js` reads the nonce
  from `location.hash` as it starts. The host hands a message to the bridge only when its
  `event.source` is the frame's own window, its `event.origin` the frame's (the pages origin,
  or `"null"` for a frame without a thread) and its `nonce` the frame's.
- **`cf:resize` and `cf:theme:ack`** need the same window and origin. Their nonce is
  optional, because a page without the script posts them by hand (the skills and
  `view.inline`'s warning tell it to); a wrong nonce is still dropped. A foreign site
  navigated into the frame can no longer resize the card.
- **`cf:ready` only answers `cf:hello`**, never a bare `load`. A page led anywhere else has no
  nonce, so its hello is never heard and it gets no `cf:ready`: `cf.ready` rejects at once
  with `unavailable` ("this page was not opened by Code Foundry in this frame"), and
  `bridge.js` posts nothing but `cf:resize` and `cf:theme:ack`.
- **`cf:bye`** (new, page → host): the script posts it on `pagehide`, in place of one `cf:off`
  per subscription. The host ends the document: its runs are aborted, its subscriptions
  stop, its confirmation is cancelled.

## Documents

A document announces itself by its hello and ends with its bye. The host starts over on
either (a new `doc`, everything of the last one aborted or stopped, answers still on their
way dropped). A `load` starts over only when no hello came since the last load: that is a
document without the script (a link followed to a page without it), whose predecessor's
work must stop. Should a page's hello ever arrive after its own frame's `load`, the order
the host assumes, the old document's bye has already ended it. The old `hasLoaded` path (a host
recreated for a page already up was told `loaded()`, which said ready) went: a change of
owning thread now reloads the frame (its key includes the thread, because the sandbox changes
with it), and a change of page name no longer recreates the host (it reads the name through
a getter).

## Frames without a thread are opaque

`HTML_PREVIEW_SANDBOX` lost `allow-same-origin`; `THREAD_PAGE_SANDBOX` is it plus
`allow-same-origin`, and only a frame with an owning thread gets it (the inline card, its
lightbox, the File tab of a page its thread showed). A File tab on any other HTML file is in
an opaque origin again, as before the bridge: it cannot read or script another frame (its
`parent.frames[i].document` throws), and keeps no localStorage. The host hears it at origin
`"null"` and posts to it with `"*"` (an opaque origin cannot be targeted; what it is sent is
a ready with no thread, the theme and refusals). It still loads `/cf/theme.css` and
`/cf/bridge.js` (classic, no-cors loads).

**Accepted residual:** every thread's pages share the pages origin, so two pages of the
user's own threads on screen can still reach each other's window, read each other's nonce
and call each other's `cf`; the host then credits the frame that posted. A per-thread origin
would need a listener (a port) per thread, which is not worth it for pages of the user's own
threads. A page can also hand on its own bridge on purpose (navigate its frame to a URL with
its own nonce in the fragment), which it could do anyway by relaying messages.

## Limits (`BRIDGE_LIMITS`)

- **32 runs in flight per document.** A run whose id is already in flight is refused
  `invalid` ("a call with id X is already running", answered with that id, so a page that
  posts raw duplicates sees its first call fail too), and the 33rd concurrent run is refused
  `invalid`. `bridge.js` never gets there: it keeps at most 32 runs at the app and queues the
  rest, their timeouts running from the call; a queued run that times out was never sent, so
  it sends no cancel.
- **16 subscriptions per document.** The 17th `cf:on` is refused `invalid` (through the
  subscription's onError); a `cf:on` reusing an id replaces its subscription and is not one
  more.
- **256 KiB per message.** The host counts the characters of the fields it would pass on
  (type, id, verb, source, key, value, args' keys and values) and ignores a message past
  `BRIDGE_LIMITS.messageChars` without answering. `bridge.js` refuses such a call (or a
  `cf.storage` value that large) at once with `invalid` and sends nothing, so a page never
  waits out its timeout on it. The daemon's page storage cap is 256 KiB per thread anyway.
- **Stores are not capped by count:** they go to the daemon one at a time per thread, so a
  burst of writes queues rather than piles up.

## Cancel aborts the call

Each run gets an `AbortController`; `invokeConfirmed` takes `signal` and `invokeCommand`
passes it to Connect's `invoke`. `cf:cancel` (the page's timeout) aborts it, as do a new
document, a bye and `dispose` (unmount). An aborted call answers nothing and reports nothing
to the errors strip. With `cf/bridge-fix-floor` the daemon ends `thread.wait` and
`action.wait` on the request's cancellation (`api.TestInvokeCancelReachesTheCommand`), so a
page's waits no longer pile up in the daemon. A cancelled mutation is the daemon's to finish
or not, as for any client that hangs up; the page already reported it as `timeout`.

## Tests

- Vitest: `lib/bridge.test.ts` (bye, size cap in and out, nonce generation, `withNonce` with
  and without a fragment, `nonceMatches` with optional), `stores/bridgeHost.test.ts` (ready
  only for hello; a hello, a bye or a load without a hello starts over and aborts the
  document's calls; a load after a hello keeps it; cancel aborts with no answer; dispose
  aborts; duplicate id refused then accepted once answered; 32 runs and 16 subscriptions;
  the size cap), `components/files/HtmlFrame.test.tsx` (sandbox per thread, nonce in src,
  window + origin + nonce for bridge messages, optional nonce for resize, opaque origin
  `"null"`, a thread change reloads), `lib/cfBridgeScript.test.ts` (nonce on every message,
  no bridge without one, the nonce after a page's own fragment, bye, the 32-run queue, size
  refusals), `HtmlPreview.test.tsx` (src and opaque sandbox).
- Playwright (WebKit), `e2e/bridge.spec.ts`: a page that leads its frame to another grant's
  copy of the bridge page, or to itself without the fragment, gets no bridge there (its calls
  answer `unavailable`, raw posts with no or a guessed nonce are not heard, the host posts the
  new document nothing); a reload keeps the nonce and the bridge; a no-thread File tab
  beside a thread's card is opaque and its probe of every sibling throws (verified to read
  "reached" with `allow-same-origin` put back); a duplicate run id is refused, and `cf:cancel`
  and a reload abort the daemon's `thread.wait`; the lightbox copy has its own nonce and its
  thread's bridge. `file-tabs.spec.ts` expects the nonce and no `allow-same-origin`. The mock
  holds `thread.wait` until the caller aborts and lists them at `GET /__mock/waits`;
  `mock/files.ts` adds `docs/probe.html` and `~/elsewhere/bridge.html` (a second grant).
  bridge, inline-html and file-tabs: 35 passed, 1 skipped (`SHOTS` unset).

## End to end (built app, isolated home)

`make build && make gui-build` on a local merge of this branch and `cf/bridge-fix-floor`
(not pushed), `CODE_FOUNDRY_HOME=~/cf-fix-frames`, a no-project Haiku 5.5 thread, pages in a
scratch folder under home shown with `view.inline … --thread`:

- Inline: `mock/bridge-page.html` was ready ("Shown in Frames check · dark theme · visit 1")
  with its live `thread-list` subscription.
- Panel (`view.panel.file` on the same file): ready with the thread, visit 2 from the
  daemon's page storage; after `settings.set appearance.theme light`, visit 3 in light.
- A page running five `thread.wait` calls (until error, 3 s timeout each) on load: all five
  answered `timeout` after 3.0 s, `thread.list` right after answered in 6 ms, and the one
  extra connection to the daemon the waits had opened closed at the cancel.
- A plain HTML file in a File tab of the same panel (the thread never showed it): rendered,
  `cf.ready` resolved with no thread, and its probe of the three sibling frames read
  "blocked, blocked, blocked".
- Not live: clicks. Synthetic clicks did not reach the app during the run (a system dialog
  of another app held the screen), so the lightbox and the click-driven calls were checked in
  e2e only, against the mock.

The home, scratch pages and the test thread's transcript were removed afterwards.

## Daemon restart

Needed: `bridge.js` is served by the daemon, and the new host requires its nonce. GUI and
daemon ship together; an old daemon's script would leave every page without a bridge.
