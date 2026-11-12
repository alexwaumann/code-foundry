# Page frames: links, dialogs, downloads, reload

A page shown in the app (an inline card, a panel page, the File tab's HTML preview) runs in
a sandboxed iframe inside the app's one web view. Four things a page expects from a browser
did not work there, each silently.

## What was wrong

- **A link to another site navigated the frame.** The site loads with none of the browser's
  cookies, so anything behind a sign-in stops at its login page, and the frame has no back
  button. The page's bridge is gone too (its nonce rides in the first URL's fragment).
- **`target="_blank"` and `window.open` did nothing.** Wails 3.1.0 implements no
  `createWebViewWith…` on macOS, so WebKit drops the request. Comments, an older note and
  both link examples in the pages skill said these open the browser. Read from the Wails
  source, not seen in the built app: Playwright's WebKit opens a popup, the app's does not.
- **`alert`, `confirm` and `prompt` showed nothing**, `confirm` answering false: no
  JavaScript panel delegate either. A page's "Are you sure?" never went on.
- **A download saved nothing**: no download delegate.
- **Nothing brought a page back** once it was somewhere else. The File tab's Refresh re-read
  the file and remounted the frame only when the text had changed.

## What changed

- `internal/preview/frame.js`, written inline by the daemon as the first script of every
  HTML document a frame navigates to (after the paint tag). A document read with `fetch()`
  is served as written: the handler goes by `Sec-Fetch-Dest`, and without that header (a
  WebKit before 16.4) only a thread's page gets it (the frame asks for those with
  `cf-page=1`). The mock daemon serves the same file.
- The script, in the bubble phase so a page's own handler wins: a trusted click on a link to
  another host posts `{ type: "cf:open", url }` and is cancelled; `window.open` to another
  host posts the same after a press; a `_blank` link or `window.open` to the page's own host
  loads in the frame. `alert`, `confirm`, `prompt`, a `download` link and a detached
  `a[download].click()` post `{ type: "cf:unsupported", what, text }`.
- `HtmlFrame` opens a `cf:open` URL with `view.open.url` only from its own frame's window at
  the page's origin, only http(s), only while the user is in the frame (lib/frameAttention),
  and at most one per 500 ms. `cf:unsupported` joins the page's errors, so the badge shows it
  and "Ask Claude" tells the thread what to fix. Neither message needs the bridge's nonce: a
  page with no bridge, and a second document of a page, both keep working.
- "Reload page" on the inline card and the expanded page; the File tab's Refresh always
  loads a rendered page again.

## Decisions

- **In the page, not in the host.** A navigation-policy hook in the GUI host would also
  catch a script's own `location = …`, but Wails exposes none, and adding one natively cannot
  be exercised by the e2e suite. The script covers what a user does (clicks) and is tested in
  a real WebKit (`e2e/page-frame.spec.ts`).
- **A page's own links still navigate the frame.** Pages made of several files are in use
  (`e2e/file-tabs.spec.ts` follows one). The bridge follows them since
  `leftovers-pages.md`.
- **Downloads are reported, not built.** Saving a file needs a place to save it and a native
  delegate or a bridge verb. Not decided.

## Gotchas

- An opaque frame (the File tab on any HTML file) has origin `"null"`, and so has any site
  it is navigated to. The checks that stand between such a site and the browser are the
  user being in the frame and the 500 ms gap.
- `location.origin` is the URL's origin even in an opaque document, where `window.origin` is
  `"null"`; the script compares hosts.
- jsdom dispatches every event untrusted: `src/lib/cfFrameScript.test.ts` hands the script's
  listeners a proxy that answers `isTrusted`.
