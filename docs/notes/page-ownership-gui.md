# Page ownership in the GUI (the GUI half)

> Changed by `page-storage-per-file.md`: a File tab acts for its own thread when that thread owns
> the page (else the first owner), a card for its thread, and both keep `cf.storage` for the page
> file (`PageService`) when the daemon says `storage_per_file`. The `owned` row and the storage row
> of the tables below are as they were then.

> Changed by `pages-tab-polish.md`: the footer now says what is true in every state ("Can use
> Code Foundry for this thread", "Asking to use Code Foundry", "Not allowed to use Code
> Foundry"); "as before" and "Nothing is said when the owner is the tab's own thread" below
> are as they were then.

The daemon keeps who owns every page file and the user's answer for a page no thread owns
(`page-ownership-daemon.md`, the contract). The File tab's frame now takes both from the
preview grant (`FilePreview.page`) and never reads a thread's log to decide which thread a
page acts for. A page no thread owns gets the bridge without a thread once the user allows it.

## What the frame does per state

`usePageThread(abs, own, preview)` maps the grant to the frame's props:

| `page.consent` | thread | `HtmlFrame` `page` | footer |
|---|---|---|---|
| absent (older daemon) | today's rule: the tab's thread when its log, the page flag or its pages directory says so | none (every call refused, "this page is not shown in a thread") | as before |
| `owned` | `owner_thread`, whatever the tab is linked to | none | "Can use Code Foundry for <thread>" when the owner is not the tab's thread (or the tab has none); else as before |
| `allowed` | null | `allowed` with `page.path` | "Can use Code Foundry", Stop allowing |
| `not-asked` | null | `ask` | as before; the band once the page says hello |
| `refused` | null | `refused` (NOT_ALLOWED) | as before, Allow Code Foundry |
| `unavailable` | null | `refused` with the daemon's reason | as before |

The log still supplies the title: the owner's log (the tab's thread's for an older daemon).
The tab's own page flag (`view.panel.page`) no longer makes the tab's thread the owner when the
daemon answers: `view.open.page` records ownership in the daemon.

Inline cards (`InlineHtml`) pass their thread as before and never get a `page`: they are
untouched and never show the band.

## Where the owner is named

The File tab's footer already says what the page can reach ("Sandboxed from Code Foundry ·
scripts and network on · loads files under …"), so it carries the owner: "Can use Code
Foundry for **Fix login** · scripts and network on · …". No new chrome. Nothing is said when
the owner is the tab's own thread (the tab's "File of <thread>" line already says it).

## The band and the held ready

- The band (`PageConsentBand`) shows only after a document of a `not-asked` page said
  `cf:hello`: a plain HTML file that never loads the bridge is never asked about.
- On that hello the host answers `cf:asking` instead of `cf:ready` and calls `onAsk`.
  bridge.js clears the 10 s timer on `cf.ready` and on every `whenReady` waiter, and arms no new
  ones (`holding`), so neither `cf.ready` nor a `cf.run`/`cf.fetch` waiting for it rejects while
  the user reads the band. The page stays in whatever loading state it draws.
- Calls the page sends meanwhile (only `cf:on` can come before ready; run, fetch and store
  wait for ready inside bridge.js) are held in order, at most 64 (past that refused
  `invalid`), and dropped with the document (a reload, `cf:bye`).
- Allow / Don't allow run `page.allow` / `page.disallow` with `{path: page.path}` through
  `runCommandForResult` (`inView`: the band going is the feedback; a failure toasts). On
  success `pageAnswered(path)` bumps a counter that every `usePreviewGrant` of that page
  follows, so every File tab on the page reads its grant again at once; the daemon's page
  event then does the same in every window (`page-access-live.md`).
  The new grant changes `page`; `HtmlFrame` calls `host.setPage`, which sends the held ready
  under the new access and replays the held calls. The frame is not reloaded: the page comes
  alive in place.
- An answer that changes what a document already had its ready under (Stop allowing an
  allowed page, Allow Code Foundry on a refused one) makes `setPage` return true, and the
  frame loads again so the page starts over under the new answer. A page that never said
  hello is not reloaded.

## The threadless bridge (`bridgeHost.ts`)

The host now has a mode instead of a nullable thread: `thread`, `page` (allowed, no thread),
`ask` (held) and `none` (refused, with the message). Every use of `threadId` was reviewed:

| use | thread | page alone |
|---|---|---|
| ready's `thread` | `{id, name}` | null |
| ready's `can` / `refusal` | storage and fetch, "" | storage and fetch, "" |
| storage load / write | `ThreadService.PageStorage/SetPageStorage {thread_id}` | `PageService.PageStorage/SetPageStorage {path}` (the resolved `page.path`, never the tab's spelling) |
| storage chain and "other frames hear the write" | keyed `thread:<id>` | keyed `page:<path>` |
| fetch | `ThreadService.ProxyFetch` | `PageService.ProxyFetch {path}` |
| command list (read-only verbs) and run context | `pageContext(id)` | `pageContext("")`: origin page, no thread, as the CLI outside a thread |
| `fillPageArgs` | thread id, its checkout as cwd | no thread arg, no cwd (an arg that defaults to the thread is left out, not sent as "") |
| a verb whose thread arg defaults to the caller's | runs | the daemon's "missing --id (default: the active thread; there is none)" is answered "this page has no thread … needs one unless its args name the thread: …" |
| confirmation's "Asked by" | `Page "x" in thread "y"` | `Page "x" at ~/path, in no thread` |
| `noticePageResult` (a saved file's toast, opens it in the thread's panel) | yes | no: there is no thread's panel to open it in |
| source `thread` | the page's thread | refused: "this page has no thread …, and cf.on("thread") needs one" |
| every other source (`thread-list`, `gh`, `action`, `plugin`, `terminal`, `project`, `workspace`, `settings`, `update`, `ui`, `ember`) | as before | the same: none reads the thread |
| PageService consent errors (`PermissionDenied`, `FailedPrecondition` without a command detail: the answer changed elsewhere) | n/a | "the user has not allowed this page to use Code Foundry" |

Refusals of a page the user refused, or of a file that is no page, are not reported to the
error strip (`quiet`): the footer already shows the answer, and a badge for the user's own
choice is noise. The older daemon's "not shown in a thread" refusals are reported as before.

A threadless page stays in the opaque sandbox (`HTML_PREVIEW_SANDBOX`), served as written.
Giving it `allow-same-origin` would put it at the pages origin with every thread's pages, where
it could read a thread page's frame nonce through `parent.frames` and drive that thread's
bridge. Its messages come from origin "null" and replies are posted to "*", as for every
opaque frame; the host answers only its own frame's window with its nonce, and a new document
drops everything the last one had.

## bridge.js

- `cf:ready` carries `can: {storage, fetch}` and `refusal`. `cf.storage` and `cf.fetch` check
  `can` (`may()`), not `cf.thread`. An app that sends no `can` (a GUI older than this) leaves
  the old rule: they work only with a thread.
- Errors say what is true: before ready "cf.storage: Code Foundry has not answered this page
  yet; await cf.ready first" (the only place that sentence remains); after ready
  "cf.storage: <refusal>" (the user has not allowed the page, the file is no page, or, from an
  older app, not shown in a thread). The Go test checks the sentence appears once.
- `cf.on` checks a source name against `cf.sources` only when ready named some; a page given
  none (refused) sends the subscription, and the host refuses it saying why, instead of a
  misleading "no source X".
- `cf:asking` stops the ready clocks (above).
- A page written against the old bridge works unchanged: same API, same message types; only
  `cf.thread` may now be null on a page that works.

## Skill

`code-foundry-pages`: the API block (copied from bridge.js's header) says `cf.thread` may be
null; SKILL.md says pages this thread showed or wrote share its storage;
`reference/errors-and-limits.md` explains ownership and what a page no thread owns can do
(storage per file, fetch, verbs given ids, every source but `thread`) and the new
`unavailable` causes; `reference/sources.md` words the fetch and storage errors. The pages
skill's body budget (8,700 bytes) had about 20 bytes free, so the detail went to the
reference file and the SKILL.md line stayed one sentence.

## Mock

`mock/pages.ts` (`MockPages`, on `World.pages`): owner = the thread whose log last showed the
file (`MockThreadLogs.lastShown`) or `view.open.page` recorded (latest wins), else the pages
directory's thread; answers, storage and fetch per resolved path (links followed), with the
daemon's consent errors; `page.get/allow/disallow` (category Pages, no palette, no
keybinding; `allow`/`disallow` refuse a page's own call). `POST /__mock/page?path=…` scripts an
owner, an answer or an unavailable reason; `GET /__mock/page/calls` lists the answers.
`mock/board-page.html` at `~/notes/board.html` is a page no thread owns that uses the bridge.

## Gotchas

- `usePreviewGrant` re-reads on a change only when the count changed since its grant came
  (`seen`), so mounting a tab on a page answered earlier does not ask twice.
- `HtmlFrame` follows `page` by its JSON (a new object each render); the host is created with
  the first value through a ref and told later ones with `setPage`.
- The skill's `{{cf.bridgeAPI}}` is bridge.js's header verbatim: header lines count against
  the skill's body budget.
- `make drive DAEMON=dev`: `advanced.claude_path` applies only after a daemon restart, so a
  thread made right after setting it runs the real `claude`. `view.inline` refuses a file
  outside home, so a scratch page shown in a thread must be under home (a gitignored folder of
  the checkout did).

## Verified end to end

A scratch dev daemon (`make drive DAEMON=dev`, home `/tmp/cf-pggui.*`, removed after) and the
GUI in `playwright cli`:

- A page `view.inline`d in a thread, opened in an unlinked File tab with that thread's view
  never opened: its thread's bridge (thread-list live, its thread's storage), the footer
  "Can use Code Foundry for hi".
- A page in the pages root (no owner): the band after load; Allow made it live in place;
  Refresh read the stored visit back (`board:visits` 2 in `PageService.PageStorage`); Stop
  allowing reloaded it refused ("cf.storage: the user has not allowed this page to use Code
  Foundry"), the daemon answering `page get`: not allowed, and `PageStorage` permission denied.
