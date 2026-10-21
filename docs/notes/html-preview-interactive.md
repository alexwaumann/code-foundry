# HTML preview: interactive, served by the daemon (2026-10-20)

Alex: "when I click anything in the HTML page, it goes black. I want Claude to be able to
build interactive HTML, otherwise it's kind of moot."

## Why it went black

The File tab's HTML preview was a `<iframe sandbox="" srcdoc>` with a `default-src 'none'`
CSP (`file-viewer-3-tabs.md`). A srcdoc document's base URL is its parent's, so every
`href="#top"`, `href="?x"` or relative link resolved against the app's own URL
(`wails://localhost/...`) and navigated the frame there. The Wails asset server answers an
unknown path with the SPA's `index.html`; with scripts blocked by the sandbox, that is the
app's blank dark body. Nothing else worked either: no scripts, no local stylesheet, script or
image, no network.

## What ships

* **`FilesystemService.PreviewFile(base_dir, path)`** returns a root-relative URL
  (`/preview/<grant>/<rel>`) and the `scope` the grant serves. The scope is the deepest
  registered project or worktree path holding the file, else the file's directory, so
  `../assets/app.css` from `docs/` resolves inside a checkout. The grant is 16 random bytes
  (hex), one per scope, kept until the daemon stops (`internal/preview.Grants`). NotFound
  for a missing file, InvalidArgument for a directory, a path outside home, or a relative
  path without an absolute base.
* **`GET /preview/<grant>/<path>`** (`internal/preview.Handler`) is mounted on the loopback
  listener *outside* `requireBearer` (`daemon.loopbackHandler`): an `<iframe src>` cannot
  send a header, so the grant in the URL is the credential. It serves regular files under
  the grant's directory only: `..` is cleaned away, a symlink that leaves the home directory
  is 404, a directory serves its `index.html`. Headers: `Cache-Control: no-store` (the
  thread edits these files), `Referrer-Policy: no-referrer` (the grant must not reach a CDN's
  logs), `X-Content-Type-Options: nosniff`, text types get `; charset=utf-8`, and
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
  allow-popups-to-escape-sandbox allow-modals allow-downloads` so the document stays
  opaque-origin even if its URL is pasted into Safari. The daemon's other routes still
  require the bearer token, which the page never sees. The Unix socket serves no preview
  route (the CLI has no frame).
* **`HtmlPreview`** asks `previewFile` once per path, then loads the URL in
  `<iframe sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox
  allow-modals allow-downloads" referrerpolicy="no-referrer">`. Never `allow-same-origin`
  (the page cannot touch Code Foundry's window or storage) and never `allow-top-navigation`
  (a link cannot replace the app; a plain link navigates the frame, `target=_blank` opens the
  browser). The frame remounts (new `key`) when the file's text changes, which `FileTab`
  already re-reads on tool edits, worktree changes and Refresh. Loading shows the tab's
  spinner; a failed grant shows "Cannot render the file" with Retry. Footer: "Sandboxed from
  Code Foundry · scripts and network on · loads files under ~/…".
* **Network is open.** Interactive pages Claude builds pull Tailwind, Chart.js, fonts from
  CDNs; blocking that would keep the preview moot. The page runs with an opaque origin and no
  ambient credentials, so what it can reach is what any web page can.
* The mock daemon implements the RPC (`mock-preview-<n>` grants) and the route; the e2e test
  clicks a button, follows an in-page anchor and a relative link, and checks a relative image
  loaded. `sandboxedDocument` / `HTML_PREVIEW_CSP` are gone.

## Decisions and gotchas

* **Grant, not token, in the URL.** The bearer token in a URL would leak to the page's
  scripts and, via `Referer`, to every site it loads from. The grant leaks only read access
  to its own tree, which the page has anyway through relative fetches.
* **Scope = checkout, not file directory.** Alex's HTML lives in worktrees and references
  sibling directories; a per-directory scope would break `../`. A loose file outside every
  project gets its directory.
* **No expiry.** A frame left open for a day must still reload; the table is tiny (one entry
  per scope) and dies with the daemon. A daemon restart invalidates grants, and the GUI's
  reconnect re-reads the tab, which asks for a new one.
* **`key` remount over `location.reload()`.** The frame is cross-origin to the app; a
  cross-origin `Location` exposes `replace()`/`href` but not `reload()`.
* **Derived state, not an effect, bumps the key**, so the first render loads once and
  StrictMode's double effects do not add a reload.
* **Testing library matchers.** `toHaveAttribute` / `toHaveTextContent` are not set up in
  this project's vitest config; tests read `getAttribute` / `textContent`.

## Found on the way: a stored panel shape that blanked the whole app

Checking the change in the real app, `view.projects` (and `ui.focus.project`) turned the
window black on this build *and* on main's. The webview had not crashed: a selector in the
panel header (`groupAt(e, 0).tabs.length`) threw, React unmounted the tree, and the body
showed `index.css`'s black fallback. The persisted `code-foundry.panel` store (version 3)
held entries like `{"open": true, "groups": [{}]}`: groups without a `tabs` array.

How it gets that way: every build on this machine shares one WebKit localStorage
(`~/Library/WebKit/dev.alexwaumann.codefoundry`). A build from before the panel split
(store version 2) reads a version 3 store, zustand calls its `migrate` for any version
mismatch, that migrate knows nothing of `groups`, and the build writes the entries back as
version 2 with `groups` still on them and no `tabs`. The next version 3 build migrates
those with `migratePanelV2`, which builds `groups: [{ tabs: undefined }]`, and JSON drops
the `undefined`. Alex runs worktree builds beside the installed one, so this is routine.

Fix (`stores/panel.ts`): `sanitizePanelState` repairs any stored `byKey` into entries the
reducers can trust (groups with a tabs array, one or two; an active tab that exists;
`pickFrom` only while picking; numeric width and ratio in range; `focused` only when
split; a version 2 entry that still carries `groups` keeps them). It runs on every
rehydrate through persist's `merge`, migrated or not, and `migrate` passes a store from a
newer version straight through to it. Tests cover the broken shape, a sound split entry,
the downgraded shape, junk, and rehydration of version 3 and version 9 stores. Diagnosing
it needed the error text: a temporary `window.onerror` that sent the message to the daemon
(a GET the request log records at debug) worked where `document.title` did not (Wails
owns the title).
