# Pages: the File tab's footer, scroll kept, status Badges, a racing test (2026-11-19)

Follow-ups from a trial where four threads built pages from the pages skill. Four items: the
File tab's footer, a page's scroll after it is unloaded, the page library's Badge, and a vitest
file that failed under load.

## 1. The footer says what is true in every state

**Before.** A page owned by the tab's own thread used the bridge, but its footer said
"Sandboxed from Code Foundry", the opposite of the truth. The other states said "Can use Code
Foundry" (allowed) or "Can use Code Foundry for <thread>" (another owner). The refused and
asking states also read "Sandboxed".

**Now** (`components/files/pageFooter.ts`, a pure function with a table test). The footer is
still one quiet line, with the same shield mark and the same Stop allowing / Allow Code
Foundry actions.

| state | lead |
|---|---|
| owned by the tab's own thread (or an older daemon's rule gave it the tab's thread) | Can use Code Foundry for this thread |
| owned by another thread | Can use Code Foundry for **name** |
| no thread, allowed | Can use Code Foundry |
| no thread, the band asking | Asking to use Code Foundry |
| no thread, refused | Not allowed to use Code Foundry |
| not asked and never said hello (a plain HTML file), a file that is no page, older daemon with no thread | Sandboxed from Code Foundry |

- The lead is in the text colour when the page can use Code Foundry or is asking to. Otherwise
  it is the footer's quieter colour. The mark is tinted as before: green when allowed, warning
  while asking.
- "this thread" is accurate: `actsFor` is empty only when the acting thread is the tab's own.
- A file that is no page (`unavailable`) keeps "Sandboxed". Its reason (for example "outside
  your home folder") goes to the page's calls, as before. Putting it in the footer would make
  the line long for something the user rarely needs.

## 2. Coming back to a page is cheap: its scroll is put back

A page behind another tab or in another space is unloaded, and so is an inline card scrolled
far away. Each loads afresh when it is shown again. That stays as it is. Now the page opens
where the reader left it.

- **frame.js** (in every document the frame loads). While the page's own document scrolls, it
  posts `{ type: "cf:scroll", x, y, path }`, at most once per animation frame. A frame inside
  the page does not post. When the app's `cf:ping` after a load carries `scroll: { x, y, path }`,
  frame.js puts that position back, but only if all of these hold:
  - the document's path is that path (so it is the same file);
  - the URL has no fragment (a hash route or an anchor places the page itself);
  - the page is still at 0,0 (it did not place itself on load);
  - the user has not pressed, typed, used the wheel or touched the page.

  It retries as the document grows (a ResizeObserver on `<html>` and `<body>`, and `resize`
  for a card whose frame grows to the height the page asks for), so a page drawn after its data
  arrives still gets there. It gives up for good on any of these:
  - the position moves away from where it last put it (the page or the user scrolled);
  - a user press, key, wheel or touch;
  - the place is reached;
  - `RESTORE_MS` (3 s) pass.

  The scroll uses `behavior: "instant"`, so a page with `scroll-behavior: smooth` does not
  animate it.
- **The GUI** (`components/files/pageScroll.ts`). Positions live in memory only, so an app
  restart forgets them. There are at most 256, and the least recently scrolled is dropped
  first. The key is the place plus the file:
  - a File tab: `tab`, the panel key, the tab's path;
  - a card: `card`, its thread, its item id, the page's absolute path.

  `HtmlFrame` takes `scrollKey`. It keeps a `cf:scroll` only when the reported path is the
  frame URL's own path, so a file the page went on to is never kept. It hands the position
  back only with the first ping of each frame load (`frameKey`). The page's own way back to its
  file (a link) starts at the top, as in a browser.

  Loads that restore: a remount (the tab shown again, the card back in the timeline), an edit
  (HtmlPreview's version key), a theme reload and Reload. The expanded lightbox keeps no
  position: it is another view of the card.
- **Scrollable regions inside the page** (a list in a fixed-height box) are not restored. They
  have no identity that survives a reload: a selector or index path can point at different
  content once the page draws again, and restoring the wrong element fights the page. Only the
  document's own scroll is restored.

Tests:
- `cfFrameScript.test.ts`: reporting, restoring, retrying as the page grows, and every case
  where it leaves the page alone or stops.
- `HtmlFrame.test.tsx`: what is kept and handed back, with the key and without it.
- `pageScroll.test.ts`: the key, the forgetting order and the parsing.
- `e2e/page-scroll.spec.ts`, one real-browser case: a wheel scroll in a File tab, another tab
  in front (the frame goes), back, and a page that draws its rows 300 ms after load is put back
  at the same `scrollY`. With the key blanked, the spec fails (0 against 1500).

## 3. Badge statuses; Tip on a disabled button

- `Badge` (`components/ui/badge.tsx`, so both the app and `@cf/ui` get them) has three new
  variants: `success`, `warning` and `error`. Each uses the theme's tint and its text colour
  (`bg-cf-*-surface text-cf-*-text`, plus `hover:bg-cf-*/15` on a link), which is what the
  app's own status pills use. `make pagelib` rebuilt `internal/pagelib/dist`.
- `components.md`: the Badge line names them. Its size budget is far from full; the line grew
  by one clause.
- Checked in GitHub Dark, GitHub Light, Dracula and Solarized Light: the computed colours match
  the theme's slots and the shots read well. The `page-library.spec.ts` roles test now checks
  the three badges' text and fill against the slots in both schemes.
- **Tip on a disabled button: true.** shadcn's Button has `disabled:pointer-events-none`, so
  hovering never reaches the trigger, as `Tip`'s own comment says. The app wraps such a
  button in a span (`CommandButton`). Changing `Tip` to wrap disabled children on its own would
  change tooltips across the app, so this is not the cheap fix. `components.md`'s `Tip` line
  now says to put the button in a `<span className="inline-flex">` inside the Tip.

## 4. HtmlPreview.consent.test.tsx racing under load

**The race.** The grant (`previewFile`) resolves outside `act`, so React commits the frame in
a scheduler task and runs that commit's passive effects in a later one. The effects that matter
here are HtmlFrame's `message` listener and its bridge host. `findByTestId("file-html-frame")`
resolves on the DOM mutation, and RTL then drains with a `setTimeout(0)`. When the process is
paused for a millisecond or more between the commit and the scheduler's next slice (a loaded
machine), that timer fires first. The test then goes on and dispatches `cf:hello` to a window
nobody listens on yet. The hello is lost, the band never shows, and `findByTestId("page-consent")`
or `waitFor(cf:ready)` times out.

**The interleaving, forced.** I made the scheduler's next slice late, as a paused process
would, by hoisting a `setImmediate` stub (`setTimeout(cb, 5)`) into a copy of the test, since
React's scheduler uses `setImmediate` in Node. The old file failed exactly the five tests that
say a message after the frame appears and wait for a reply (asks once…, Don't allow…, keeps
asking…, an answer that changes…, a file that is no page). Each failed with "Unable to find …
page-consent" or "expected [] to have a length of 1". The fixed file passes 11 of 11 under the
same stub. `HtmlPreview.live.test.tsx` has the same pattern in two tests (stopped allowing…,
its owner removed…). Both failed under the stub and pass after the same fix.

**Fix.** A `showPage` helper renders, waits for the frame, then rerenders once. React runs a
commit's pending passive effects before it starts the next update, so the listener and host
exist before the test speaks. This is the same fix as in `flaky-ci-tests.md`. In the live
test, the rerender also comes after the waitFor that sees the new frame, before its hello.
There is no new timeout, sleep, retry or skip, and the component is unchanged.

**Under load.** I ran 8 vitest processes at once, three rounds, each running both fixed files:
24 of 24 runs green (384 test runs). The count was kept low because other agents share the
machine.

## Verified end to end

On a scratch dev daemon (`make drive DAEMON=dev`, scratch home under /tmp, removed), with no
thread created, so no `claude` ran, and pages in a scratch folder under home (removed):
- A tall page in a File tab, scrolled 2200 px with the wheel. A second tab (a bridge page) was
  put in front, and the first page's frame went. Back on the first tab, the page was drawn late
  and was at `scrollY` 2200 again. This used the daemon's real frame.js injection.
- The bridge page's footer went through "Asking to use Code Foundry", then Don't allow ("Not
  allowed to use Code Foundry" with Allow Code Foundry), then Allow ("Can use Code Foundry"
  with Stop allowing; the page said ready).
- The owned states (the tab's own thread, another thread) are covered by the mock e2e shots
  and vitest, because a real thread here would need a fake `claude`.

## Gotchas

- `e2e/page-library.spec.ts`'s SHOTS for cards are blank: the thread timeline keeps its
  bottom, so the card is far above the viewport and `scrollIntoViewIfNeeded` does not hold.
  For a picture of a card's page, open its file in a File tab (`data-page` on the card is the
  absolute path) and screenshot the frame.
- frame.js's tests run the script with fake `window`/`location`: any new global it reads
  (`scrollX`, `requestAnimationFrame`, `ResizeObserver`, `location.pathname`/`hash`) needs a
  fake in `load()` there.
