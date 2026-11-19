# How the daemon serves a page's files (fuzz fixes)

Fixes from the preview fuzz pass (findings 4 to 9 and 11). Each is about how `internal/preview`
serves a page's files or what its frame script (`frame.js`) does in the page.

## A grant's own origin (finding 4)

**What was wrong.** A grant lived in the URL's path (`/preview/<grant>/…`), so a root-absolute
URL (`/assets/index.js`, the default `base` of Vite, CRA, Next export and most bundlers;
`href="/about.html"`; `<base href="/">`) resolved to the pages listener's root, where nothing
is. A build loaded nothing, and a root-absolute link landed on a bare `404 page not found`,
while the footer said the folder's files load.

**The rule now.** Each grant has an origin of its own, `http://<grant>.localhost:<pages port>`,
and `/` there is the grant's directory (`preview.GrantOrigin`, `GrantURL`, `HostGrant` in
`internal/preview/host.go`). `PreviewFile` returns URLs on it (`Filesystem.WithPagesPort`). On
a grant's host:

- every path is the grant's, read by the same `open` as before, so a grant reads exactly what
  it read before (its tree or its one file, the Floor, the temp rules). Nothing reaches another
  grant: `/preview/<other>/x` on a grant's host is the grant's own `preview/<other>/x`.
- a path the grant has no file at goes to the `/cf/` routes (theme, bridge, page library), so a
  page's own `cf/` folder wins over them (`HandlerMissing`; `pagesHandler(routes, own)`).
- `pagesHost` accepts `<32 hex>.localhost` with the listener's port or none. Only the machine
  resolves `*.localhost` (to loopback), so a rebinding page cannot send that name; the API
  listener still accepts only loopback names. The API's CORS already refused every origin on
  the pages port and every name that is not loopback.

The path form stays on loopback names (a server with no pages listener gets root-relative
URLs, the tests, the mock); the GUI is given grant-host URLs only.

Pages of different grants are now different origins, which they were not: a thread page can no
longer reach another tree's frame. Pages of one tree still share one.

**App Transport Security (the gotcha).** macOS resolves `*.localhost` to loopback, and WebKit
and Go do too, but ATS does not count `*.localhost` as local networking:
`NSAllowsLocalNetworking` covers loopback addresses, bare names and `.local` only. A WKWebView
in a binary with the app's old plist refused a frame at `http://<id>.localhost` (tested with a
small Swift host and a `wails://` scheme handler, -1022), and loaded it once the plist had an
`NSExceptionDomains` entry for `localhost` with `NSIncludesSubdomains` and
`NSExceptionAllowsInsecureHTTPLoads`. Both `Info.embedded.plist` and `Info.dev.plist` carry it,
and dev builds (`wails3 dev`, `make gui-dev`) now link `Info.dev.plist`: a binary with no plist
refuses `*.localhost` too. Playwright's WebKit has no ATS, so the e2e suite cannot catch a
plist that lacks the entry.

**Storage.** A grant lasts until the daemon stops, so a thread page's origin, and with it its
in-memory localStorage, now changes when the daemon restarts (before, the stable port kept it
for the app's session). WebKit never wrote a cross-site frame's storage to disk anyway, and
`cf.storage` is the daemon's, keyed as before (`docs/notes/bridge-fix-storage.md`). A stable
grant id across restarts would mean persisting a secret; not done.

**The bridge.** `bridge.js` carries the frame's nonce to a page's own next document. It knew
"own" by the `/preview/<grant>/` prefix; on a grant's host it is the whole origin.

## A folder without its slash (finding 5)

`/sub` named a folder and served its `index.html` in place, so the index's relative links
resolved one level up. A folder's URL without its trailing slash now answers `301` to
`./<last segment>/` (the query kept, `no-store`, so the next edit that makes it a file is not
held back by a cached redirect), as `http.FileServer` and any static server do. The `./` keeps
a segment like `a:b` from reading as a scheme. `open` says whether it opened a folder's index,
for home and temp grants alike; a one-file grant has no folder.

## A declared charset (finding 8)

Every text response had `charset=utf-8`, which beats a page's `<meta charset>`, and frame.js,
written ahead of the page's own meta, pushes it past the 1024 bytes a browser scans. An HTML
document is now sent with the charset its first 1024 bytes declare (`htmlCharset`): a UTF-8
byte-order mark is UTF-8, a UTF-16 one sends none, a declared `utf-16` is UTF-8 and
`x-user-defined` is windows-1252, as the HTML spec has a browser do; no declaration is UTF-8 as
before.

## What frame.js handles now (findings 6, 7, 9, 11)

- **Targets (6).** A link's target is its own `target`, else the document's `<base target>`.
  Any target that would open a window loads the page's own file in the frame, like `_blank`
  did: `_blank`, `_top`, `_parent` from the page itself, and a name no frame of the page has
  (`_new`). A name a frame of the page has (looked up from this document up to the page, a
  window not an element with that id; names are case-sensitive, keywords are not) is left to
  the browser, and `cf:going` is said only when this frame is the one that goes. A GET form to
  the page's own file with such a target loads in the frame with its fields; `window.open` into
  a named frame is the browser's own.
- **`window.open` with nothing to load (7).** `window.open()`, `('')` or `('about:blank')`, the
  print-view idiom, answered `null` silently and the page threw on `w.document`. It still
  answers `null`, and reports `cf:unsupported {what: "window"}`. `window.print()` is not
  reported: what WKWebView does with it in a frame is untested.
- **A POST to the page's own files (9).** It went to the daemon, whose plain-text 405 never
  answered the app's ping, so the app showed "This page went to another site". frame.js now
  cancels it and reports `{what: "post"}` (submit event, `form.submit()`, and the Navigation
  API's form navigations), and the page stays.
- **Frames inside the page (11).** frame.js posts to `window.parent`, which for a nested
  document is the page, not the app. The page's frame.js now sends on `cf:open` (an http(s)
  URL) and `cf:unsupported` from its own child frames (`e.source` one of `window.frames`) to
  its parent, so they reach the app from the frame it owns. `cf:going`/`cf:here` are not sent
  on: they are about the child's document. A child frame from another site could post a
  `cf:open` that is sent on; the app opens a link only while the user is in the frame
  (`present`) and at most one per gap, as for the page's own.

The GUI's strip has messages for the two new kinds (`previewGrant.ts` `UNSUPPORTED`).

## Not done

- Findings 1, 2, 3, 10, 12 and 13 of the same report belong to the File tab.
- A page's own `cf/` folder at the scope root is served before the daemon's `/cf/` routes; a
  page that relies on the daemon's `/cf/theme.css` while having its own `cf/theme.css` gets its
  own. Not a case seen in practice.
- `playwright cli` (drive-app) needs `http://*.localhost:*` in its allowlist, now in
  `.playwright/cli.config.json`. Its request interception also aborts `blob:` loads, so a
  page-library page (`/cf/jsx.js` imports from a blob) shows "Importing a module script failed"
  there on either URL form; plain Playwright and the app load it.

## Verified

Go table tests: `HostGrant`, `GrantURL`, the grant host (root-absolute files, a folder
redirect, the own `cf/` folder, another grant's path, one-file grants, an unknown grant), the
folder redirect on home and temp trees, `contentType` charsets, `pagesHost` against
`loopbackHost`, `pagesHandler` on a grant's host, and `PreviewFile`'s grant-origin URL fetched
over a real listener. Vitest: frame.js targets, `<base target>`, named frames, `window.open`,
POST to self, the nested relay; bridge.js carrying the nonce on a grant's host.

End to end on a scratch dev daemon and the GUI in WebKit (drive-app): a Vite-style
`dist/index.html` mounts and is styled, and its `/about.html` link lands; a folder link is
styled and its Back link returns; `<base target="_blank">`, `_new`, `_top` and a named target
load in the frame with no second window; a Latin-1 page reads "café naïve"; a POST form shows
"1 page error" with the POST message and keeps the page; a print view's `window.open('')` gets
`null` and a page error; a nested frame's `alert` and download reach the strip. Before the
change (an `origin/main` build on the same home) the build showed "not mounted" unstyled and
the folder page was unstyled with Back on a 404.
