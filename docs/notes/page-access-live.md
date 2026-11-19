# An open page follows the daemon's answer now (fix/page-access-live)

Two findings of the pages fuzz pass (bridge-gui #1 and #2, the stale-state halves).

## What was wrong

- **Stop allowing did not reach other windows.** An answer reached File tabs only through an
  in-window counter (`pageAnswered`). Stop allowing in a second window, or `page disallow`
  from the CLI, left an open page fully working in the first: `cf.run` and its `cf.on`
  subscriptions went on (only storage and fetch, which the daemon checks, failed), and its
  footer still said "Can use Code Foundry". Commands were gated in the GUI only: a page with
  no thread called Invoke with `origin: page` and nothing naming the page, so the daemon could
  not check.
- **A tab kept the owner it read when it opened.** `usePreviewGrant` fetched once per mount
  (and on a new daemon pid or this window's answer). After the owning thread was removed the
  page stayed on the dead thread: every call failed, `cf:ready` handed it an empty storage,
  the footer showed the raw thread id, and Refresh or an edit did not help.

## The rule now

1. **The daemon says when.** EventService has a `page` source (`PageEvent`, page.proto):
   `paths` whose owner (Record, only when the owner changes) or answer (SetConsent, only when
   it changes) changed, published by `internal/store/page` as `page.Changed`;
   `removed_thread` from `thread.Removed` (the cascade deletes the thread's page rows in the
   removal's transaction, which the page store does not see); `all` as the snapshot (on
   connect, after a client missed events). It names pages, never their answer: the client
   reads `PreviewFile` again. Additive proto, no migration.
2. **Every File tab follows it.** `stores/pageAnswers.ts` counts changes per path, per removed
   thread and for all; `usePreviewGrant` reads its grant again when the count for its page
   (its path, its owner's removal, all) moves. It also reads it again on Refresh, on an edit
   (both bump the frame's key in `HtmlPreview`), and when the bridge host says its access is
   stale. The grant's URL is the daemon's one per file, so a re-read reloads nothing unless
   the access changed; then `HtmlFrame` follows as before (a new owner: a new host and a
   reload; an answer: `setPage`, which stops a live document's calls and subscriptions and
   reloads it).
3. **The daemon refuses itself.** `UiContext.page_path`: the bridge host sends the page's
   resolved path with a run from a page no thread owns (`pageContext(tid, path)`). Invoke
   (`api.Command.checkPage`, wired with `WithPages`) runs it only while the page may use the
   bridge (owned or allowed); otherwise `PermissionDenied` with the page's `PageAccess` as a
   detail. Not `FailedPrecondition`, which an Invoke answers for a command unavailable in its
   context. A path that is no page gets PageService's code.
4. **The host tells the truth and asks once.** A run refused with that detail answers the page
   "the user has not allowed this page to use Code Foundry" (quiet: the footer shows the
   answer) and calls `onStale`; so do PageService's consent errors on storage and fetch, and a
   storage that cannot be read at ready (a removed thread's). `onStale` fires once per access
   (reset by `setPage`); `HtmlPreview` passes `grant.retry`.

## Decisions

- **Older callers keep working.** No `page_path` is not checked: a thread's page (inline
  cards act for their thread as before and are untouched) and a GUI older than the field. The
  GUI and daemon ship together; the gap is one release.
- **Only a page alone names its page.** A thread's page is checked by its thread (a removed
  thread fails its calls); naming the page there would refuse an inline card whose page another
  thread showed later, which is the pending ownership decision, not this fix.
- **The ownership rule and storage keys are unchanged.** Which thread owns a page shown by
  several, and whether storage is per thread or per file (bridge-gui #1's second half and #5),
  wait for that decision; tabs now only follow whatever the daemon says.
- **A notification, not the access.** The event carries no answer: a client always reads the
  grant, so there is one source of truth and nothing to keep in step with `PreviewFile`.
- **`cf.on` sources stay GUI-side.** They read the GUI's own slices, so they stop when the host
  does: `setPage` stops a live document's subscriptions and the frame reloads under the new
  answer, in every window, once the event arrives.

## Gotchas

- The `all` snapshot makes every open tab read its grant once per (re)connect. Cheap (a
  handful of tabs), and the only way to catch what a dropped stream missed.
- `usePreviewGrant` keys what it follows by path and owner, so a re-read that changes the owner
  does not count as a change and loop.
- Mock: `MockPages` publishes on answer, script and owner change; `world.ts` publishes a removed
  thread; `CommandService.Invoke` checks `pagePath` as the daemon does (`checkInvoke`).

## Verified end to end

Scratch dev daemon (`make drive DAEMON=dev`, own home under /tmp, `advanced.claude_path` the
test `fakeclaude`, restarted before any thread) and the GUI in `playwright cli`, pages under
`~/cf-fix-page-access/`; all removed after:

- An allowed page in a File tab: `cf.run("thread.list")` ok, `cf.on("thread-list")` live.
  `page disallow` from the CLI: the open tab reloaded at once, refused; footer "Sandboxed …
  Allow Code Foundry"; `cf.on` refused; a click on run answered "[unavailable] the user has
  not allowed this page to use Code Foundry".
- Invoke over HTTP with `origin: page`: with `pagePath` of the refused page,
  `permission_denied` and a `PageAccess` detail (consent refused); without one (an older GUI),
  it ran.
- A page `view.inline`d in thread alpha, open in beta's File tab ("Can use Code Foundry for
  alpha", alpha's bridge). `thread remove alpha`: with no Refresh, the tab went to the opaque
  frame, footer "Sandboxed …", and the band asked; Allow made it live again (run ok). Same in
  the light theme with a third thread.
