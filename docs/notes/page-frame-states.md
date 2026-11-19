# Page frame states: the page's own hash, storage, theme, files, a deleted file (2026-11-19)

Fixes from the pages fuzz pass for the frame as the GUI hosts it, in a File tab (`HtmlPreview`)
and a thread's inline card (`InlineHtml`): `HtmlFrame.tsx`, `frameFiles.ts`, `fileStamps.ts`,
`internal/preview/frame.js` and the nonce reads in `internal/bridge/bridge.js`.

## What was wrong, and the rule now

- **The nonce took the page's hash.** Every frame was opened at `<grant URL>#cf=<nonce>`, so a
  hash-routed page (`#/about`) opened on its "no route" view and a `:target` page showed no
  section. The nonce now rides in the query: `?cf-nonce=<nonce>` (`lib/bridge.ts` `withNonce`,
  `NONCE_PARAM`), after the URL's own parameters (`cf-page=1` for a thread's page). The
  fragment is the page's alone and empty by default. `bridge.js` reads it from
  `location.search` in its three blocks, and its follow block carries it on in the query of
  the page's own next file (its fragment left as the page wrote it). The query keeps what the
  fragment gave: a reload and a step back keep it; a navigation anywhere else loses it.
  Rejected: frame.js stripping the nonce with `history.replaceState` (a reload or a step back
  then loses the bridge), and the iframe's `name` (it survives a navigation to another site,
  which could then post as the page from an opaque frame). The cost: a page that reads its own
  query sees `cf-nonce` (as a thread's page has always seen `cf-page`), and the daemon sees the
  nonce in its request line (it is the page's own host; the nonce was never secret from it).
- **Storage hung a page in a File tab.** A page no thread owns is in an opaque origin (no
  `allow-same-origin`, unchanged), where `localStorage`, `sessionStorage`, `document.cookie`,
  `indexedDB.open`, `caches` and `navigator.serviceWorker` throw. frame.js, only where reading
  `localStorage` throws, puts in-memory `localStorage` and `sessionStorage` (methods and
  property access, through a Proxy) and an in-memory `document.cookie` (a past `expires` or
  `max-age=0` removes one) on the window and document, and takes `serviceWorker` and `caches`
  away so feature checks skip them. `indexedDB.open` and `deleteDatabase` still throw (no
  shim). The first use of each API posts `cf:unsupported { what: "storage", text: <api> }`;
  the strip names the API and says the data lasts until the page reloads and to open the file
  in a browser to keep it (`previewGrant.ts` `pageUnsupported`).
- **A theme switch reloaded every plain page.** A frame with no thread is now reloaded on a
  theme change only when its document said it uses the theme: frame.js answers the frame's
  `cf:ping` with `{ type: "cf:here", seq, files, theme }`, `theme` true when it loaded
  `/cf/theme.css` or `/cf/bridge.js` (or has `window.cf`). A document that never answers (no
  frame script) is left alone too. A thread's page is painted by the daemon from its first
  byte, so it still reloads unless it acks `cf:theme`.
- **Editing a page's CSS or JS did not refresh it.** `files` in that answer lists the paths the
  document loaded from its own origin (itself first, its `link`/`script` elements and resource
  timing, at most 64), and `cf:files` repeats the list when a later fetch adds to it (a
  `PerformanceObserver`). HtmlFrame maps the paths under the page's own `/preview/<grant>/`
  to files under the grant's scope (`frameFiles.ts` `grantFiles`; a folder's path is its
  `index.html`; never the page's own file, which its host watches), watches them
  (`fileWatcher`), and 150 ms after one is written posts `{ type: "cf:reload" }`, which
  frame.js answers with `location.reload()`: the document reloads in place, on the file it is
  at. A one-file grant passes no scope and watches nothing.
- **A deleted file kept showing.** `fileWatcher.watch` takes `{ gone: true }`: such a listener
  hears the file going away too (the others still hear only writes, so a card keeps its page
  through a regenerate). The File tab asks for it and re-reads: "File not found".
- **The download message** told a File tab page's user to `cf.run("file.export")` in "the
  thread's checkout". A frame with no thread now says a download saves nothing from a page in a
  File tab and to open the file in a browser.
- **A card that failed never recovered, and Reload on a missing file showed a bare 404.** Reload
  is enabled on a failed card and asks the daemon for the grant again (`grant.retry`), then
  loads the frame once the answer is in (the frame up stays meanwhile, so no flash of the
  404): a missing file shows "Could not render this page … does not exist" with the source
  fallback, and a file that is back renders. A failed card's own watch retries the grant when
  the file is written, so it recovers by itself.

## Gotchas

- `localStorage` is an own, configurable property of WebKit's window, and `cookie` a
  configurable accessor on `Document.prototype`, so both can be replaced; checked in WebKit with
  a probe page before writing the shim (`e2e/file-tabs.spec.ts` keeps the check).
- frame.js's test harness (`lib/cfFrameScript.test.ts`) passes its own `window`, `document`,
  `location` and `navigator`; jsdom's document is shared, so the cookie shim is deleted after
  each test.
- The file mapping knows the `/preview/<grant>/` URL shape. If grants move to origins of their
  own, `grantFiles` changes with them.
- No "Open in browser" action exists for a file yet (it would be a daemon verb); the messages
  say "open the file in a browser", which the File tab's Open in Finder reaches.

## Tests

- Vitest: `lib/bridge.test.ts` (`withNonce` in the query), `lib/cfBridgeScript.test.ts` (nonce
  from the query, none from an old fragment, carried in the query), `lib/cfFrameScript.test.ts`
  (the answer's files and theme, `cf:files` only after the answer, `cf:reload` from the app
  only, the storage shims and what they report, nothing for a page with storage),
  `frameFiles.test.ts`, `HtmlFrame.test.tsx` (threadless download message, storage calls,
  watched files and one in-place reload, none for a one-file grant), `HtmlPreview.test.tsx`
  (a plain page is not reloaded on a theme change; a theme-using one is), `fileStamps.test.ts`
  (`gone`), `FileTab.test.tsx` (a deleted file says File not found), `InlineHtml.test.tsx`
  (Reload re-asks and keeps the frame until the answer, a deleted file's Reload, a failed card
  recovering on Reload and by itself).
- Playwright: `file-tabs.spec.ts` (an opaque page's empty hash and `null` origin, working
  in-memory storage and the strip's count); `bridge.spec.ts` reads the nonce from the query.
