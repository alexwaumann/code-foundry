# e2e against a bundled build

`make gui-e2e` took 8.1 minutes for 614 tests on main. No test ran under 1.2 s; the median was
2.8 s and the slowest 7.6 s, and the four workers finished within 15 s of each other. That shape
is a fixed cost per test, not a few slow tests. Most of it was loading the app: every test
opens it in a fresh browser context, and the Vite dev server sends it as about 780 module
requests. The suite now runs against a bundled development build served by `vite preview`:
5.7 minutes, every test passing.

## Measurements (M-series, 12 cores, WebKit)

| | dev server | bundled build |
|---|---|---|
| requests per page load | 778 | 24 |
| cold load, idle machine (new context to first sidebar row) | ~850 ms | ~470 ms |
| reload, same context | ~550 ms | ~220 ms |
| full run, 4 workers, wall | 8.1 min | 5.7 min |
| full run, serial test time | 1871 s | 1301 s |
| median test | 2.8 s | 1.9 s |

Under four workers each test saves about 0.95 s, more than on an idle machine: four WebKits
were pulling 778 modules each from one Vite process. The build itself takes about a second.

Six workers against the bundled build: 5.4 minutes, but serial test time rose to 1738 s
(contention) and two timing assertions failed (a panel handle drag, theme-model-flow's Undo).
Twenty seconds is not worth the flakes; the default stays at four.

## What changed

* `playwright.config.ts`: the app server is `vite build --mode development` into
  `gui/frontend/dist-e2e/` (gitignored), then `vite preview` on the same port, rebuilt on every
  run. `NODE_ENV=development` keeps `import.meta.env.DEV` true, so the `?daemon=` override, React's
  development build and everything else gated on DEV behave as before.
* `src/devModules.ts` and `main.tsx`: in DEV builds `window.__cfModule("/src/stores/panel.ts")`
  resolves to the app's own instance of that module (an `import.meta.glob` over `src/stores` and
  `src/api`, loaded on first use). Specs used `import("/src/…")` inside `page.evaluate` to drive
  stores directly, which only the dev server answers; all 36 call sites now go through
  `__cfModule`, which works under both. The production build is unchanged: same chunks, same
  size, no `__cfModule`.
* Two races the faster load exposed, each fixed in the test:
  * page-library "a Tailwind-runtime page": the timeline remounts cards near the viewport's
    edge while it measures rows and pins to the bottom, and a remounted card's frame loads again
    ("Frame was detached", 3 of 4 runs). The test scrolls the card into view first, as the board
    test beside it does, and its first poll rides a detach.
  * thread "Jump to bottom": the wheel landed on the sidebar row's hover card, which outlives
    the click (2 of 5 runs). It now calls `leaveSidebar`, which waits for the card to leave the
    DOM, not only to close: while it fades out (`data-state="closed"`) it still lies over the
    pane and takes a wheel. dictation and thread-prompts use the same fixture and pass with
    the stricter wait.

## Decisions

* **A development-mode bundle, not a production one.** The e2e suite needs the DEV-only
  endpoint override and runs React's development build today; switching to production React
  would change behaviour under test (StrictMode double effects, warnings) for no gain here.
* **Rebuilt every run, inside Playwright's webServer.** About a second, and it cannot go stale
  against the source the way a separately built bundle could.
* **A module handle, not a test-only store API.** The specs keep reaching the same modules by
  the same paths; the change is mechanical and the handle covers any store or api module
  without a list to maintain.

## Gotchas

* `vite build --mode development` alone still sets NODE_ENV to production (DEV false); the
  webServer entry sets `NODE_ENV=development` as well.
* A spec that needs a module outside `src/stores` or `src/api` has to widen the glob in
  `src/devModules.ts`; `__cfModule` rejects with the path otherwise.
* The live specs (`playwright.live.config.ts`) still run against a Vite dev server you start
  yourself; `__cfModule` works there too.
* `make check`'s Go pass failed once on `TestProjectActivity` (an extra `live /w/a` call) and
  passed 20 of 20 alone; a load flake unrelated to this change.
