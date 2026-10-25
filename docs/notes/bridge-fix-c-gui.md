# Bridge fix C: the GUI's findings from the phase 3 test round (2026-10-25)

A model-behaviour test of the bridge (#341 daemon, #342 GUI, #343 skill, #344 cross-home) ranked
18 findings. This PR fixes the GUI's: 1, 4, 5, 8, the host half of 14 and the panel half of
17. The daemon and skill findings are another PR's. Two items needed small daemon changes
(1 and 4), noted below.

## 1. `thread.new` from a page: where its thread runs

- **Report:** a page's `cf.run("thread.new", {prompt, sidebar: true})` (the pages skill's own
  example) failed with "a worktree, project, or workspace is required".
- **Finding:** the brief's premise was that the CLI sends its cwd for `default_to_cwd` args
  and the host does not. That holds for those args, but `thread.new`'s `worktree` is not
  one: it is context-bound only. So the CLI inside a thread failed the same way. Agents
  never noticed because they always pass `--project`.
- **Host fix** (`lib/bridge.ts` `fillPageArgs`): every `default_to_cwd` arg the page did not
  pass gets the page thread's `worktreePath`, which is where its CLI runs (`$HOME` for a
  no-project thread). `ArgSpecView.defaultToCwd` maps the proto field. This covers
  `workspace.members --cwd`, `action run --here`, `terminal new --here` and the git verbs'
  cwd.
- **Daemon fix** (`internal/command/commands_thread_created.go` `callerPlacement`): a
  `thread.new` that names no project, worktree, workspace, projects or no-project, and runs
  in a thread (`ActiveView == ""` with `CallerThreadID` set), starts where that thread runs:
  - its project and worktree;
  - its workspace too, for a workspace thread;
  - no-project for a thread without a project, which then refuses new-worktree, base and
    branch with a sentence saying why.

  The CLI outside a thread and the app, which always names a placement, are unchanged. The
  page and the thread's CLI behave the same, and the skill's example works as written.
- **Risk:** an agent that forgets `--project` now gets a thread in its own checkout instead
  of an error. That is the same as `--project <its own>` without `--new-worktree`.

## 4. A page's verbs do not move the view

- **Root cause:** every verb that starts a thread emits a `FocusThread` intent, unconditionally
  and to every window (`thread.new`, `thread.fork`, the `pr.ask` / `pr.explain` /
  `pr.fix.findings` threads, `theme.ask`). `stores/intents.ts` selects any fresh thread that
  is in the sidebar (`lib/inSidebar.ts` `threadFocus`). A `sidebar: true` thread is in the
  sidebar, so the window switched to it. That unmounted the inline card mid-handler, and the
  page's success code (clearing the box) never ran, so a second click made a duplicate. A
  hidden child (`sidebar: false`) was already skipped, which is why that case worked.
- **Fix:** those verbs take `focus` (Bool, default `true`; `createdFocusArg` and
  `focusCreated`). `--focus=false` starts the thread without moving any window. The host
  fills `focus: "false"` for any verb whose `focus` defaults to true, unless the page passes
  it. So `cf.run("thread.new", {…, focus: true})` still jumps.
- **Why an arg, not a context flag:** no proto change. The CLI and app defaults are
  untouched. The page states its intent in the same words as the CLI.
- **Not covered, on purpose:** verbs whose whole job is to move the view (`thread.focus`,
  `view.*`). A page calling them asks to move. Their `focus` (the panel verbs') defaults to
  false, so the host leaves it alone.

## 5. Page errors on the strip

- **What a page's strip shows:** a red count when the page got an `invalid`, `unavailable`,
  `failed` or `timeout` answer. `declined` is the user's own no, and `gesture` never reaches
  the host. The strip is the inline card's, the lightbox's, and the File tab's footer.
- **The popover** lists the latest five distinct errors, deduped by call, code and message:
  the call (verb, or `cf.on("source")`), code, message (without the verb the daemon's
  message repeats), time and repeat count.
- **Ask Claude** (`stores/composerText.ts` `putInThreadComposer`) appends a short text to
  this thread's draft and focuses the prompt. It is not sent. The text names the page by
  title and path and lists each error. This follows the citation flow: the composer takes
  text from elsewhere and the user sends it.
- **Where the list lives:** the host reports through `BridgeFrame.onError`. `HtmlFrame` keeps
  the list for the document now in the frame, clears it on every load and on unmount, and
  hands it up through `onPageErrors`. The card and the lightbox are two documents with two
  lists.
- **`timeout` is only the host's** (a DeadlineExceeded from the daemon). The script's own
  `opts.timeout` rejects inside the page and posts nothing, so the host cannot see it.

## 8. Gestures in the side-panel copy

- **What the tester saw:** in the File-tab copy of a page, the first click did nothing, the
  second was refused with `gesture`, the third worked. Inline cards worked on the first
  click.
- **Root cause, what is known:** `bridge.js` used `navigator.userActivation.isActive` alone
  whenever the API exists. Its 5 s pointer and key fallback was dead code in WebKit. So any
  case where WKWebView does not mark the frame active for a genuine click fails, and nothing
  else can rescue it. In Playwright's WebKit the panel copy's mutation works on the first
  click (e2e and the live run below), so the inactive activation is specific to the Wails
  window's WKWebView.
- **Most likely trigger, unconfirmed:** the click that makes the window key, or focuses a
  frame for the first time, is not an activation in WKWebView. The tester's own note says
  clicks "always raised my window first", which matches the first click doing nothing.
- **Fix in the script:** a call counts as the user's when `isActive` is true **or** a trusted
  `pointerdown`, `mousedown`, `pointerup`, `click` or `keydown` happened in the page in the
  last 5 s. Untrusted events (a page's own `el.click()`) never count. Unit tests:
  `cfBridgeScript.test.ts` (inactive API plus a recent click passes; a synthetic click does
  not).
- **Not reproduced in the real app.** See "Could not do" below.

## 14 (host). Sources that need a stream only a view on screen holds

- `SourceSpec.unavailable` returns why a source cannot be followed now. The host answers
  `cf:on` with `cf:result` `unavailable` and those words instead of staying silent. The
  error also counts on the strip.
- **`ember`** is the only such source. Its board stream is held only by Ember's sidebar
  row, chat or Board panel (`emberBoardHeld()`). The message: "Ember's board is only live
  while it is on screen; open the Ember board or sidebar row".
- **Every other source:**
  - `gh` holds its own read (`dashboardResource.watch`).
  - `thread` reads rows and pending requests that the events stream keeps.
  - The rest come from the one EventService stream the app always holds.

## 17 (panel). "Asked by" uses the page's title

- `usePageThread` returns the thread and the title the page was shown with, the last titled
  showing. The File tab passes `title || file name` as the frame's name, as the inline card
  does, so the confirm says "Asked by Bridge check, a page in …" in every placement.

## Mock

- The mock's `thread.new` follows the daemon: caller placement, `focus` (default true),
  `created-by` with `defaultToThreadEnv`. The CLI-context `when` matches too.
- The mock's `thread.list` refuses an unknown arg, as the daemon does, so the test page's
  "Misspelt arg" button gets `invalid`.
- `bridge-page.html` gains a Start form (the skill's example call, unchanged) and that
  button. The bridge item now has the title "Bridge check".

## Tests

- **Go:** `TestThreadLifecycleCommands` covers caller placement for a project thread, a
  workspace thread and a no-project thread, the no-project refusal, and an explicit
  project winning. `TestThreadCreatedNoFocus` checks that no intent is emitted with
  `focus=false`. `emptyid_test` passes `--context-thread=` so its point (`--created-by=`
  opts out) still shows. The guide stays under its 25,500-byte topic cap: the `focus`
  description is short.
- **Vitest:**
  - `lib/bridge.test.ts`: the `fillPageArgs` table.
  - `lib/pageErrors.test.ts`.
  - `stores/bridgeHost.test.ts`: focus filled, cwd filled, errors reported but not a
    decline, ember refused.
  - `lib/cfBridgeScript.test.ts`: the gesture cases.
- **Playwright (WebKit), `bridge.spec.ts`:**
  - Start from the page: the handler runs, the box clears, the args are exactly
    `{prompt, sidebar, created-by, focus: "false"}`, the page's thread stays selected and the
    new row is in the sidebar.
  - The error badge (3), the popover (2 rows, "2×"), Ask Claude fills the composer and sends
    nothing, and a reload clears the badge.
  - The panel copy's confirm says "Bridge check" and its footer counts an error.
  - `inline-html.spec.ts` and `file-tabs.spec.ts` unchanged and green.

## End to end (2026-10-25)

- **Setup:** `make build && make gui-build`; `CODE_FOUNDRY_HOME=~/cf-fix-c-gui`, the
  `CLAUDE*` and `CODE_FOUNDRY_*` variables unset; scratch git project `~/cf-fix-c-scratch`;
  thread "Bridge fix check" on Haiku 5.5 (`claude-haiku-5-5[1m]`, medium), which is also
  the home's default model, so the page's threads were Haiku too. `bridge-page.html` was
  shown with `view.inline --title "Bridge check"`, inline and `--panel`.
- **Real clicks were blocked.** The built Wails app ran, but a system authorization prompt
  from another app (with secure input on) was up for the whole session and swallowed every
  synthetic click into any app. It was not ours to dismiss.
- **What ran instead:** the same GUI code (Vite) in Playwright's WebKit against this real
  daemon (`daemon --dev`, `CODE_FOUNDRY_DEV_ORIGINS=9247`):
  - **Start** created "Reply with OK only" (`s-b9d8606eaedd`) in `~/cf-fix-c-scratch`,
    "shown in the sidebar". The page's own handler ran (the box cleared, "started 1"). The
    window stayed on "Bridge fix check", and the new row appeared in the sidebar.
  - **Misspelt arg** gave `invalid: thread.list: unknown argument "archivd"`. The strip
    showed ⚠ 3 and the popover two rows. Ask Claude put the errors in the composer, which
    was not sent.
  - **Panel copy:** Send a toast succeeded on the first click (`{"windows":1,"receivers":1}`).
    Archive (the thread had a background shell) asked "Asked by Bridge check, a page in
    Bridge fix check"; Cancel answered `declined`.
  - **`cf.on("ember")`** with Ember off answered `unavailable` with the new message, and the
    strip counted it.
- **Gotcha:** the live script's first archive ran while the thread was idle, so it archived
  without asking (as designed). It was unarchived.

## Could not do

- **Reproduce item 8 before and after in the Wails window**, for the reason above. The
  script change is safe either way: it only adds a trusted-event path beside the API.
  Whether WKWebView reports `isActive` false on a genuine panel click remains the tester's
  observation (PLAUSIBLE, CGEvent clicks).

## Daemon restart

Needed: the `thread.new` placement, the `focus` arg, and the new `/cf/bridge.js` (served by
the daemon, revalidated by its ETag). GUI and daemon ship together.
