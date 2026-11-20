# page.check: the author sees its page run (2026-11-19)

In the pages trial all four threads put this first: each shipped its page without seeing it
run, said so, and each page had a defect its author could not see. `view.inline` answered
only `shown …`. Now `code-foundry page.check <path>` renders the page once in the app and
says what that render saw; `view.inline` and `view.open.page` end with one line naming it.

## What it answers

```
$ code-foundry page.check ~/cf-fix-selfcheck/broken.html
checked /Users/me/cf-fix-selfcheck/broken.html: 2 problems (settled in 0.1 s; 720 px wide, card 97 px tall)
- error at broken.html:12:19: ReferenceError: Can't find variable: totl
- thraed.list: unavailable: unknown command "thraed.list": cf.readOnly lists the reads, and code-foundry help the rest
acted for thread s-50ba55fd9e1e
only what the page does as it loads ran: clicks and what they start were not tried
```

Exit 1 when it found a problem, the page did not load or could not be rendered; 0 when clean.
`--json` is `CheckPageResponse` (the report, width, thread, path; never the PNG's bytes).
`--shot out.png` writes a PNG of the card's frame; `--width` (720, 280 to 1600) and
`--settle` (5s, at most 10s) bound the render. The report has: loaded, the TSX loader's state,
problems (script errors and unhandled rejections with file:line:col, the loader's compile,
import and evaluation errors, files that did not load, bridge calls refused or failed with
their code and message, alert/confirm/download and the rest frame.js reports), the card's
height and the page's own, how long it took to settle (or what was still in flight at the
bound), how many calls it made and how many cf.storage writes it tried.

With no app window: `no Code Foundry window is open to render the page, so nothing was
checked (open the app: code-foundry gui)`, exit 1. Never "no errors".

## How a render is obtained

The daemon has no browser. The plugin surface `--shot` already has the app's host draw
something in a hidden window (`gui/shot*.go`, `internal/shot`, `src/shot`), ordered in off
every display with WebKit's occlusion detection off, never key, out of Mission Control and
⌘`. A page check is that window's other kind of request: `ShotRequest.page` →
`window.cfShot({id, page})` → `src/shot/pageCheckRunner.ts` mounts the page in the same
`HtmlFrame` a card uses, acting for the page's thread with its file's storage, as tall as
the page asks (else the card's 420 px). The page reports with `ShotService.Checked`; the
host snapshots the frame's rect when asked and publishes `PublishShotRequest.page_report`.
The frame and the state it followed go 5 s after the report; the window after 2 idle
minutes, as before.

**Always a fresh render, never the card on screen.** A card may have loaded before the last
edit, may be scrolled away (not loaded at all), or in a pane the user is reading; a fresh
render is the page as the file is now, at a known width, and the same whether or not
anything shows it. Its cost is that the page's on-load reads run once more.

**Why the hidden window, not an off-screen frame in the main window.** The main window
cannot snapshot an off-screen element, it throttles (no animation frames) whenever the user
has another app in front, and a frame in it can take the keyboard focus (`autofocus`) from
the composer the user is typing in. The shot window has none of these.

**The window follows the app's state as an observer.** A page's `cf.on` sources read the
GUI's slices, so the runner starts `startEventSync({ observer: true })` for the check: a
`CLIENT_KIND_CLI` watch the daemon counts as no window, no visibility or focus reports, and
only the slices bridge sources read (`dispatchObserved`; not the layout, intents, the bell
or toasts). It waits up to 2 s for the threads list before the page starts.

**Which thread.** The asking thread when it owns the page, else the page's first owner (as a
File tab); a page the user allowed acts with no thread. A page no thread owns and the user
has not allowed is refused before anything renders: it would run without the bridge.

## No side effects beyond the page's own load

- The check's frame is never "present" (no click, no key): a verb that changes something is
  refused as on any load, and the check reports it.
- `bridgeHost`'s `check` mode: every refusal is reported (gesture and declined too; the
  strip leaves those out), `question` never asks (declined at once), and a `cf.storage`
  write is answered OK and kept in the page's copy, never saved (the report counts them).
  Checked end to end: a page that writes on load leaves no storage file.
- `cf.fetch` and read verbs run, as they would on load in a card.
- `page.check` is refused from a page (`Untrusted`): a page checking itself would render
  itself again and again.

## What the page tells the app now

- `frame.js` reports the page's uncaught errors and unhandled rejections (`cf:script-error`,
  kind `script` / `rejection` / `resource` / `loader`, held until the app's ping like its
  other reports), the TSX loader's errors and end (`cf:jsx` events from `/cf/jsx.js`, sent on
  as `cf:script-error` and `cf:loader`), and its `cf:here` answer carries the document's
  height and the loader's state. Only a check reads them; the card's strip is unchanged.
- **Line numbers are the file's.** The daemon writes frame.js inline right after `<head>`,
  which pushes every later line down by frame.js's own line count (an error at line 12 read
  595). frame.js subtracts its own line count for a location in the document; a TSX module's
  blob URL is named by the loader (`window.__cfSourceName`), whose own lines were already
  the file's.
- `bridge.js` tells the app the calls it refuses itself, before they reach the app
  (`cf:refused`): no click for a verb that changes something, args it cannot send, a source
  that is not there, a fetch URL it cannot send. A page that catches the rejection (as the
  trial's pages did) no longer hides it from the check. Its header (the skill's
  `{{cf.bridgeAPI}}`) is unchanged.

## K: view.inline's result

`view.inline` and `view.open.page` end with `static checks: no warnings; next: code-foundry
page.check <path> to see what it does when it runs` (`N warnings` when it printed some). Not
from the app's own call (its message is empty). The pages skill's "Show it" paragraph says to
run the check after each edit until it reports no problems, paid for in the same paragraph
(the body is at 8,7xx of its 8,700 bytes).

## What it cannot see

- Anything after a click: buttons, forms, what a handler starts. Only the page's load runs.
- What it looks like beyond the PNG: a class that does not exist in `/cf/ui.css`
  (`line-through`) styles nothing and raises no error.
- A wrong answer that throws nothing (the trial's board grouping attention under "Waiting").
- Data that comes later than the settle bound (a `gh` read the app has not made yet, a slow
  fetch past `--settle`): the report says what was still in flight.
- Errors a page catches and shows itself, other than the bridge's own refusals.
- Console output (`console.error`) that is no error.

## Tests

Go: `internal/shot` (a page report with or without a PNG, the settle time on top of the
wait), `internal/api` (`CheckPage`: which thread, refusals, no window), `internal/command`
(`page.check`'s text, exit status, bounds, from a page, no window as exit 1), the CLI
(`--shot` writes the PNG and `--json` drops the bytes), `gui` (the host answers with the
report, snapshots the frame's rect, says a failed snapshot in the report). Vitest:
`lib/pageCheck.test.ts` (settling, the bound, repeats, height), `HtmlFrame.check.test.tsx`,
`bridgeHost.test.ts` (the check's copy), `cfFrameScript.test.ts` (errors, line offset),
`cfBridgeScript.test.ts` (`cf:refused`), `pagelib/jsx.tell.test.ts`. e2e:
`e2e/page-check.spec.ts`, the shot page against the mock with a page that has both defects.

## Checked end to end

A scratch home (`CODE_FOUNDRY_HOME=/tmp/cf-fxpc.*`, `advanced.claude_path` the repo's
`cmd/fakeclaude`, daemon restarted before the thread), the built Wails GUI, a no-project
thread whose tab was never opened, so no card was on screen; pages under `~/cf-fix-selfcheck`:

- a TSX page listing threads through `cf.on("thread-list")`: clean, exit 0, and the PNG shows
  the thread list as the card draws it;
- the page above (misspelt verb, undefined variable): both, at the file's line 12, exit 1;
- a TSX page with a syntax error: the loader's error with its code frame;
- a page that writes `cf.storage` and runs `ui.notify` on load: the gesture refusal, one
  write counted, and no storage file in the home afterwards;
- the GUI quit: the no-window message, exit 1.

## Gotchas

- The mock serves the real `frame.js` and `bridge.js`, so `e2e/page-check.spec.ts` runs the
  real page-side code; it reads the report from `<html data-page-check>`.
- `make gui-build` rewrites `gui/build/darwin/Assets.car`; put it back before committing.
- Check the bound before trusting "settled": the clock starts when the frame mounts, and the
  host and the daemon wait the settle time on top of their own (12 s and 15 s).
