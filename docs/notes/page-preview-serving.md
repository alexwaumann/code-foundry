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

The path form stays on loopback names: an older GUI is given it (mixed versions, below), a
server with no pages listener gets it root-relative (the tests, the mock); this GUI asks for
grant-host URLs.

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

**A stable origin (storage across daemon restarts).** A grant id used to be random per daemon
run, which with grant hosts would have given every page a new origin at each daemon restart
(so at every update) and dropped what WebKit holds for it. A page grant's id is now the first
128 bits of HMAC-SHA256 over what it serves (`dir` or `file`, the path, a version tag) under a
32-byte key the daemon keeps in `<config home>/pages.key` (`paths.PagesKey`, `pagesKey` in
`internal/daemon/pages.go`, `preview.Grants.WithKey`). The key is made once with
`crypto/rand`, written 0600 by the same atomic write as the token, kept across restarts like
`pages.port`, and lies in the config home root, which the Floor guards from every grant (a
Floor test names it). A missing or malformed key is replaced (pages get new origins once, a
warning in the log); one that cannot be written is still used for the run. With the kept
pages port, the same tree or file has the same origin after a restart; without the key the
id is as unguessable as a random one. A media grant (`/media/<grant>/`) stays random per run:
nothing keys storage on it. Two entries with one id (an HMAC collision) are refused rather
than served as each other.

A grant id now lasts as long as the key, not one daemon run: a URL that leaked (a page that
sends its own `location` somewhere) stays good for that scope until the key is removed. The
id still only reads that scope, only from this machine's loopback, and only what the Floor
lets any grant read; removing `pages.key` and restarting rotates every id.

**What storage there is to keep.** WebKit keeps a cross-site frame's localStorage, IndexedDB
and cookies in memory for the app's session; it writes none of it to disk
(`bridge-fix-storage.md`). Checked again on the real app: the scratch home's
`~/Library/WebKit/dev.alexwaumann.codefoundry/WebsiteDataStore/<uuid>/Origins/` held only
`wails://localhost`, and all 8 stores on the machine (every home's) held only that origin, none
of `127.0.0.1:<pages port>` or `*.localhost`. A page that logs its loads in localStorage kept
them across a daemon restart in one app session (same origin, `visits: 2`) and had none of
them after the app was quit and opened again. So:

- Within an app session, a daemon restart (`daemon.restart`, an update that restarts only the
  daemon) keeps a page's storage, as the single pages origin did.
- Updating to this build loses nothing the old single origin held: that storage lived in the
  old GUI process's memory and ends with it, whatever the daemon does. A GUI from before this
  build that keeps running beside the new daemon keeps getting URLs on the old origin
  (below), so its pages keep their storage too.
- What outlives the app is `cf.storage`, which the daemon keeps per thread, unchanged.

**Mixed versions during an update.** An update can leave the daemon new and the GUI old, or
the reverse. A GUI from before this build has no `*.localhost` App Transport Security entry,
so a grant-host URL would not load in it. The client says what it can load:
`PreviewFileRequest.grant_host` (proto field 3), which the GUI sets (`api/files.ts`
`previewFile`). The daemon answers on the grant's own origin only when asked, and otherwise on
the pages listener's loopback origin, `http://127.0.0.1:<pages port>/preview/<grant>/…`, the
URL form every older GUI loads (`Filesystem.previewURL`). The pages listener serves both forms,
and the grant id is the same in both. A new GUI with an older daemon sends a field the daemon
does not know, gets the path form back and loads it: the frame, the message origin checks
(`HtmlFrame` `originOf`) and the bridge go by the URL's own origin, never by its shape. Tests:
`TestFilesystemPreviewFilePagesOrigin` (both answers, both fetched), `filesStream.test.ts`
(`previewFile` asks with `grantHost` and keeps a host, path or root-relative answer).

**Other things that reach pages by URL.**

- The WebSocket tunnel (`internal/wstunnel`, `/stream/` on the API listener) carries the GUI's
  streams only; it serves no page and the pages listener has no `/stream/` (unchanged). Its
  origin check is `allowedOrigin`, below. There is no remote-daemon mode: both listeners bind
  loopback and check the Host. A port forward to another machine reaches `*.localhost` exactly
  as it reaches `127.0.0.1`, since both name the client's loopback and the Host header carries
  the grant.
- CORS on the API (`allowedOrigin`) refuses a grant's origin: it is not a loopback name, and it
  is on the pages port. New cases in `TestRequireBearerAndCORS`
  (`daemon_test.go`) and the tunnel's origin list (`wstunnel_test.go`), on the pages port and on
  a listed dev port.
- The bridge: `bridge.js` treats a grant host's whole origin as the page's own; on the path
  form it keeps the `/preview/<grant>/` prefix rule, so it works on either answer. The GUI's
  bridge host takes messages from the frame's window at the origin of the frame's URL.
- The e2e mock answers `PreviewFile` with root-relative path-form URLs and ignores
  `grant_host`, as an older daemon would; the e2e suite thus keeps covering a new GUI on the
  path form. Playwright's WebKit has no ATS, so the grant host's ATS entry is checked on the
  real app instead (below).

**App Transport Security, least privilege.** The entry is `NSExceptionDomains` → `localhost`
with `NSIncludesSubdomains` and `NSExceptionAllowsInsecureHTTPLoads`, and nothing else. ATS takes
no wildcard key, so `localhost` plus subdomains is the narrowest form that covers
`<grant>.localhost`; it adds plain HTTP for the `localhost` names only (bare `localhost` was
already allowed by `NSAllowsLocalNetworking`), which macOS and WebKit resolve to loopback
whatever DNS says. It does not lower TLS anywhere else, allow arbitrary loads or touch media or
web content outside those names.

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
`loopbackHost`, `pagesHandler` on a grant's host, `PreviewFile`'s two URL forms fetched over a
real listener, keyed grant ids (`TestGrantsWithKey`), `pagesKey` (made 0600, kept, replaced when
malformed), the Floor guarding `pages.key`, and CORS and the tunnel refusing a grant's origin. Vitest: frame.js targets, `<base target>`, named frames, `window.open`,
POST to self, the nested relay; bridge.js carrying the nonce on a grant's host.

End to end on a scratch dev daemon and the GUI in WebKit (drive-app): a Vite-style
`dist/index.html` mounts and is styled, and its `/about.html` link lands; a folder link is
styled and its Back link returns; `<base target="_blank">`, `_new`, `_top` and a named target
load in the frame with no second window; a Latin-1 page reads "café naïve"; a POST form shows
"1 page error" with the POST message and keeps the page; a print view's `window.open('')` gets
`null` and a page error; a nested frame's `alert` and download reach the strip. Before the
change (an `origin/main` build on the same home) the build showed "not mounted" unstyled and
the folder page was unstyled with Back on a 404.

In the built app (`make build && make gui-build`, `gui/bin/Code Foundry` and a dev build from
`wails3 task darwin:build DEV=true`, each run with its own `CODE_FOUNDRY_HOME` under /tmp and a
fake `claude`):

- Both binaries carry the `localhost` exception in `__TEXT,__info_plist` (the release one from
  `Info.embedded.plist`, the dev one from `Info.dev.plist`); the GUI installed before this build
  has none.
- A thread's inline card loads at `http://<grant>.localhost:<pages port>`, its root-absolute
  `/assets/app.css` applies, and `cf.run("thread.get")` answers. The same in the dev build.
- A File tab on a Vite-style `dist/index.html` mounts from `/assets/index.js` with its
  `/assets/index.css`.
- `localStorage` set by the thread's page is there after `daemon.restart` and the app's
  reconnect: same origin (same `pages.key`, same pages port), count 2. After quitting and
  reopening the app it is gone, as before this change (above).
- Mixed versions: the GUI from before this build (no ATS entry) on the new daemon got
  `http://127.0.0.1:<pages port>/preview/<grant>/store.html` and showed the card with a working
  bridge (root-absolute paths unresolved, as before). This build's GUI on a daemon from `main`
  before this change got the path form and showed the card with a working bridge. Over HTTP,
  the new daemon answered both forms with one grant id, and both served the page.
