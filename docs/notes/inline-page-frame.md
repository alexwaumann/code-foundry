# Thread page frames: no white flash, no wheel bounce (2026-10-27)

Two bugs in the HTML pages a thread shows (view.inline; inline-html.md,
inline-html-2-fixes.md), in the card, the lightbox and the File tab's preview.

## A. White flash while a page loads (dark themes)

### Cause

- `HtmlFrame`'s iframe was `bg-white`, so every load (the first, an edit's `version`
  remount, a theme reload, the virtualizer remounting a row) showed white until the page
  painted.
- Without that class it is still white. The iframe element carries the app's
  `color-scheme` (inline-html-2-fixes.md), and a document that declares none is "light".
  When the two differ, WebKit draws an opaque white canvas behind the document. Measured
  in Playwright's WebKit: a frame styled `color-scheme: dark` over a red parent showed
  255,255,255 for a page with no meta. With `<meta name="color-scheme" content="dark">`
  it was transparent (the red showed through). A page that paints only once
  `/cf/theme.css` arrives, or never paints a background, stayed white.
- The daemon served the file byte for byte.

### Fix

- **Frontend** (`components/files/HtmlFrame.tsx`, one change for all three hosts):
  - The iframe is transparent and absolutely positioned in a `bg-cf-surface` box. The
    host's className/style size the box, not the iframe.
  - The iframe is `opacity-0` until its `load` fires, with the spinner centred on the
    surface. Then it fades in (`transition-opacity duration-120`, none with reduced motion).
  - Each frame key (a theme reload, a new owning thread) starts hidden again. A new
    grant's URL for the same frame (a daemon restart) does not, because that page is
    already up.
  - `FRAME_REVEAL_MS` (1 s) shows a frame whose `load` never comes. `load` waits for
    every image and script, and a page held up by a slow CDN should still show what it has.
  - The box is `bg-cf-surface`, not the card's raised surface: it is what the page's own
    html paints (frame.css), so the fade does not change colour.
- **Opaque frames** (`HTML_PREVIEW_SANDBOX`: the File tab on an arbitrary HTML file) get
  `bg-white` only once shown. Loaded, such a page looks as it would in a browser; its
  loading state is the surface.
- **Themed frames** (a thread's page, in the card, the lightbox or the File tab) ask for the
  page with `?cf-page=1` (`previewGrant.ts` `themedUrl`, before the nonce fragment).
  - The grant cannot tell the two apart: PreviewFile has no thread, and the File tab and a
    card share one grant per file.
  - The query reaches only the document. Relative subresources drop it, and a link
    followed inside the frame loses it, as it loses the bridge.
- **Daemon** (`internal/preview/paint.go`): for an HTML document asked with
  `cf-page=1`, the first thing in its head becomes
  `<meta name="color-scheme" content="<scheme>"><style>:where(html){background-color:var(--cf-surface, <hex>)}</style>`.
  - The scheme and surface come from the live theme (`theme.Live`, via `themePaint` in
    daemon/pages.go). Before the GUI publishes one, `light dark` and `Canvas`.
  - The scheme matching the frame's makes the canvas transparent. The background is
    frame.css's own html rule, at zero specificity and first, so any rule of the page wins.
  - Placement (`paintAt`): right after `<head …>`. With no head, after `<html …>`. With
    neither, after the prologue (a BOM, white space, comments, the doctype). Content before
    the doctype would put the page in quirks mode.
  - Tag names match in any case, quoted attribute values may hold `>`, and `header`/`htmlx`
    are not head/html. A prologue or tag that never ends gets nothing.
  - Documents over 16 MiB, other requests and non-HTML files are served as before. The
    headers (CSP sandbox, no-store, nosniff, no-referrer, any origin) are unchanged;
    `ServeContent` still answers HEAD and ranges, on the painted bytes.
- **Mock**: `mockPaint` (mock/theme.ts) paints `?cf-page=1` pages the same way, more
  plainly (the mock's pages have no comments before their head).

### Trade-off

A thread's page with no stylesheet that sets `body { background: #fff }` and no text
colour now gets the dark scheme's default text, white, on its white body. Its margins show
the surface, because html's background no longer comes from body's. Pages that link
`/cf/theme.css` already had both (frame.css sets html's background, and `:root` the
scheme), and the skills say to paint with `--cf-*` variables. The File tab's preview of
other HTML files is untouched.

## B. Wheel up over a page bounced back to the bottom

### Cause (confirmed)

- A wheel over an iframe goes to the frame's document, so the timeline's
  `onWheel={markInput}` never runs.
- When the page cannot scroll further that way, WebKit scrolls the timeline instead, with
  no wheel event in the app. Measured: a scrollable cross-origin frame at its top, wheel
  -300, moved the parent by 300 with no parent `wheel` event.
- `onScroll` saw `theirs === false` and, while pinned, called `toBottom()`: the snap back.
- A page that cannot scroll at all is different: WebKit gave its wheel to the parent's DOM
  (`wheel` fired there), so pages that fit their card never bounced. Only pages taller
  than the card did, once at their top.
- A hold (`holdTop`, 400 ms after a resize under the pointer) could also put such a
  scroll back through `restoreHeld()`.

### Fix

- `lib/scrollIntent.ts` decides who moved the list. The user did if there was recent input
  in the list, as before. With the pointer over a frame (`iframe:hover` in the scroller,
  which WebKit keeps true inside scroll events while the pointer is over the frame), an
  upward scroll over content that did not shrink is also the user's.
- The layout never moves the list up without the content shrinking: a clamp or a row
  above measured smaller always shrinks `scrollHeight`. So a card shrinking under the
  pointer keeps its hold.
- A downward scroll is left alone: it ends at the bottom, which pins anyway.
- The Timeline records the scroller (top, height) after every scroll, resize and change of
  rows (`noteScroll`) and compares each scroll with that. A user's scroll ends any hold
  and unpins.
- Not done:
  - The `bridge.js` `cf:wheel` relay. Native chaining already scrolls the timeline, so
    the relay would only repeat what hovering tells, and only for pages with the script.
  - Unpinning on pointerdown inside the card. A click in the frame never reaches the
    app, and a click on the strip already counts as input through the scroller's
    `onPointerDown`.

## Tests

- Go: `TestPainted` (head, attributes with `>`, no head, no html tag, a fragment,
  uppercase, BOM, comments before the doctype, header/htmlx, self-closed head, empty,
  unclosed comment/doctype/tag), `TestPaintTag` (published, unpublished, values that are
  not a scheme or hex), `TestHandlerPaints` (themed vs not, HEAD, uppercase `.HTM` with
  no head, a script with `?cf-page=1` untouched, Content-Length, headers).
- Vitest: `scrollIntent.test.ts` (nine cases), `HtmlFrame.test.tsx` (the `cf-page`
  query, hidden until load, white only when opaque, reveal after 1 s, hidden again on a
  reload).
- e2e `inline-page-frame.spec.ts` on the mock's new `html-scroll` state (two turns of
  text, then `docs/tall.html` open at the bottom, a page with no stylesheet taller than
  its card):
  - with the page request held, dark and light: the card has no near-white pixel while
    loading, its box is the surface and the frame is at opacity 0; once loaded, the page
    has the painted meta and under 10% near-white (its own text);
  - a theme reload held mid-way: not white;
  - wheel -150 three times over the page at its top: the timeline scrolls up, stays up
    700 ms later, and Jump to bottom shows. On main's Timeline this test fails, back at
    the bottom (752).

## End to end (2026-10-27, built app, isolated home)

`make gui-build`; GUI and daemon with `CODE_FOUNDRY_HOME=/tmp/cf-ipf`. A thread was made
with `thread.new --no-project` and no prompt. Pages in a scratch folder under home were
shown with `view.inline --thread`. Each page held its `load` back with an image that a
local server answered after 4 s.

- **Dark, a page with no stylesheet:** 0.25 s after `view.inline`, the surface and the
  spinner. At 2 s, revealed by the fallback but not yet painted by WebKit, so still the
  surface. At 6 s, white text on the surface: the daemon's paint, no white canvas.
- **Dark, a page linking `/cf/theme.css`:** the surface and spinner, then themed.
- **Theme switch** (`settings.set appearance.theme light`, then `dark`): the pages reload
  (they do not ack). Mid-reload each card is the new scheme's surface with the spinner.
  Neither direction showed white in dark.
- **File tab** (`view.panel.file` on an HTML file no thread showed): the dark surface and
  spinner while loading, then a browser's white canvas with the page as written.
- **Bounce** (WKWebView): `tall.html` (60 lines, card 420 px) open at the bottom, at its
  own top. Ten synthetic 30 px wheel-up events (CGEvent) over it moved the thread up about
  500 px. It stayed there with Jump to bottom showing, also through the next theme reload.

The threads, scratch folder and home were removed afterwards.

## Daemon restart

Needed: the preview route paints thread pages (Go). The GUI and daemon ship together.

## Gotchas

- The worktree sandbox refuses heredocs and `cd … && git …` compounds: edits went through
  the editor, and probes were scripts in /tmp.
- `HtmlFrame` already had a `shown` (the theme slots the page shows); the load state is
  `visible`.
