# Pages leftovers: saved files, the bridge across a page's files, frames that leave (2026-11-11)

Four small changes the owner approved after `page-save.md` and `page-frame-links.md`, and the
mock's `view.panel.diff` brought in line with the daemon's.

## 1. A page's saved file gets a toast

`file.export` answered the page only (`page-save.md`, "No toast"), so the user could not get to
the file from the app. Now, when a page's `file.export` succeeds, the app shows "Saved
<name>" with the path (tildified) and two actions: **Open** (a File tab in the page's thread's
side panel, `openFileInPanel("thread:<id>")`) and **Show in Finder** (`worktree.reveal` with the
file, as the File tab's own menu runs it).

- `stores/pageSaved.ts` holds it: `savedPath` reads `path` from the result JSON of a verb in
  `SAVES_A_FILE` (only `file.export`), absolute only; `noticePageResult` shows the toast. The
  bridge host calls it after each run that succeeded (`bridgeHost.ts`, next to the answer it
  posts), not after a decline, a refusal or an aborted run. No general "toast every page
  command" mechanism: the host had no result hook, and one verb does not need one.
- Sonner's `action` and `cancel` are its two buttons; Show in Finder is the second (`cancel`).
- Finder's `worktree` is the thread's checkout; when the thread is not in the store, the file's
  folder.
- The pages skill is unchanged: a page still shows the path itself.

## 2. The bridge follows a page to its other files

A page's frame is opened at `#cf=<nonce>`; a page that went on to another file of its own
lost the fragment and with it the bridge. Now `bridge.js`'s last block carries the nonce on.

**Decision: carry it in the URL, at navigation time, only to a known destination.** A
navigation the page makes is re-made with `#cf=<nonce>` added (after the destination's own
fragment, as `withNonce` does) when the destination is at the page's origin and under its
own grant's `/preview/<grant>/` prefix, and has no nonce yet. With the Navigation API (the
WebKit of this machine's macOS 27, and Playwright's) the `navigate` event gives every push or replace with
its destination (a link, `location = …`, `assign`, `replace`, a `_blank` link the frame
script loads in the frame); the script cancels it and navigates again with the nonce.
Without it (older macOS WebViews), a plain click on such a link is followed the same way;
a script's `location` then still loses the bridge.

Rejected: keeping the nonce in `sessionStorage` or `window.name` and restoring it on load.
Both are written before the destination is known (on `pagehide`), so a document of another
grant loaded next in the same frame (or, for `window.name`, another site) could read it;
`bridge.js`'s own check of the grant would not stop a document that reads storage itself.

What the nonce still protects (`bridge-fix-frames.md`): a frame led to another grant, or
loaded without the fragment by anyone but the page, has no bridge (the e2e that checks this
now reloads the frame from the app's side; the page's own `location.replace(location.pathname)`
keeps it, by design). The host is unchanged: it still hears only its own frame's window, at
the page's origin, with the nonce. Another frame at the pages origin that navigates this one
gets the nonce carried only to this page's own files, and could read it already (the
accepted residual). An opaque frame (a File
tab with no thread) carries its nonce too, but its host answers every call `unavailable`, as
before: it never had a bridge to keep.

Not carried: a form's POST (re-made as a GET it would change), a reload or a step back (they
keep their own URL), a download.

## 3. A frame that goes to another site

`frame.js` already sent clicked links and `window.open` to the browser. Added:

- **Forms.** A `submit` (bubble phase, so a page that sends its form itself wins) to another
  host: a GET opens its URL with the fields in the browser (`cf:open`, which the host takes only
  while the user is in the frame); a POST cannot be taken there and is reported
  (`cf:unsupported`, `what: "form"`). A script's submit without a recent press is reported too.
  `form.submit()` fires no event, so the prototype's `submit` is wrapped as `a.click` is. A
  submit button's `formaction`/`formmethod` count (read as attributes).
- **A script's `location`, a refresh.** Not interceptable portably: `Location` is unforgeable.
  With the Navigation API, a cancelable navigation to another host is cancelled: to the browser
  when `userInitiated` or after a press, else reported (`what: "navigation"`, shown as
  `location`). A POST navigation there is reported as a form.
- **A frame that left anyway** (an older WebView, a navigation that cannot be cancelled): the
  app covers it with "This page went to another site" and **Reload** (`HtmlFrame`, testid
  `<frame>-left`), which loads the page again in a new frame. Every frame of the inline card,
  the lightbox and the File tab has it.

**How the app tells.** After each frame `load` the host posts `{ type: "cf:ping", seq }` (to the
page's origin, or `*` for an opaque frame); `frame.js` in every document the daemon serves
answers `{ type: "cf:here", seq }`. No answer within `LEFT_WAIT_MS` (400 ms), after an earlier
document of the page answered, means the document has no frame script: another site. A
document that goes on to one at its own origin says `cf:going` first (a click on such a link,
or the `navigate` event), which excuses the next load: a page's own JSON or picture is not
"another site". A first load that never answers (the daemon down) is not covered either.

## The mock's view.panel.diff

`mock/panelItemVerbs.ts` built different params from the daemon's verb. It now follows
`diffCheck`: a side naming its default is left out (`merge-base`, `working`); the checkout root
among the paths means every file; one path that is a changed file is `path`, anything else
(a directory, several) is `paths` plus `thread`; a path is placed in the deepest of the
thread's checkouts (its own and `checkoutPaths`), all in one, and `own=1` only for the thread's
own; `--scope` with `--base`/`--head` and a bad `--hide` are refused with the daemon's words.
`ItemThread` gained `checkouts` and `changed` (the world's worktree details) for that. The
refusals that need the comparison itself (nothing differs, unmatched paths) stay the daemon's.

## Gotchas

- **The frame's `load` can come before the document's first message.** A first version had
  `frame.js` post `cf:here` as it started and the host count it per load; in WebKit the
  message often arrived after the iframe's `load`, so a foreign document's load looked
  answered. A ping sent after the load can only be answered by the document now there.
- jsdom's `<button>` has no `formAction`/`formMethod`; the script reads the attributes.
- `window.navigation` must be read off `window` in both scripts, so the vitest harnesses can
  hand in a fake (and leave it out for the click fallback).
- A closure that sets a `let` inside `forEach` reads as always-false to the type-aware lint
  (`no-unnecessary-condition`): a `for … of` loop.

## Wording

docs/notes and docs/sketches no longer refer to the owner's workplace: "a managed Mac", "a
user's managed laptop", "the managed machine's sandbox", with the technical content as it was.

## Verified

- Vitest: `stores/pageSaved.test.ts` (which results name a file; the toast, its Open and Show
  in Finder), `bridgeHost.test.ts` (only a run that succeeded reaches the notice),
  `lib/cfBridgeScript.test.ts` (carried with the nonce after the destination's fragment, as
  push or replace; not to another grant, site or port, outside `/preview/`, a URL with a nonce,
  the same document, a POST, a download, a reload, a step back, an uncancelable one; nothing
  from a page without a nonce or grant; the click fallback and what it leaves alone),
  `lib/cfFrameScript.test.ts` (forms by method, submitter, the page's own, a script's with and
  without a press, `form.submit()`; the `navigate` rules; the ping's answer to the parent only;
  `cf:going`), `HtmlFrame.test.tsx` (pings per load to the right target; covered and Reload; not
  covered on a first load with no answer, a late answer, a `cf:going` before or after the load;
  notes from another window or origin ignored; the two new reported cases),
  `previewGrant.test.ts`, `mock/panelItemVerbs.test.ts`.
- Playwright (WebKit): `bridge.spec.ts` "a page's own other file keeps the bridge…" (a clicked
  link with its own fragment, then `location.href` back; `thread.list` answers in both) and the
  reworked "…has no bridge there"; the Export test sees the toast; `page-frame.spec.ts` "a frame
  sent to another site is covered with Reload…" (the page's own file is not covered, another
  origin is, Reload brings the page back).
- A `--dev` daemon (scratch home under /tmp, the socket path's length) with two pages in a
  scratch folder under home, granted with `FilesystemService.PreviewFile`, hosted in WebKit by
  a page at the API's origin as the app hosts them: the first page said hello with the nonce
  and answered a ping; its link to the second kept `#cf=<nonce>` and the second said hello with
  it (and `cf:going` came first); a button setting `location` to another port posted `cf:open`
  and the frame stayed; a POST form to it was reported `form`; the frame sent to another origin
  from outside answered no ping. The scratch folder and home were removed.

## Compatibility

- **Needs a daemon restart**: `bridge.js` and `frame.js` are served by the daemon. With an old
  daemon the new GUI sends pings nobody answers, but only after a document that answered,
  so nothing is ever covered; the bridge does not follow and forms are not caught, as before.
- New daemon, old GUI: `cf:here`/`cf:going` are ignored; the rest works.
- No on-disk change.
