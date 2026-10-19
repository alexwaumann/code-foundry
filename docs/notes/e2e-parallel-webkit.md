# e2e: WebKit only, one mock daemon per worker

`make gui-e2e` took 32 minutes (1046 cases: 523 on WebKit, then the same 523 on Chromium,
one worker). Agents wait for it before every PR, so the suite set the pace of every step.
It now takes 8 to 11 minutes: WebKit alone on four workers, each with its own mock daemon.

## What changed

* `playwright.config.ts` has no Chromium project. The app runs in WKWebView and nowhere
  else; the Chromium pass doubled the run and was the flakier of the two (the step notes
  record Chromium-only failures in panel tab drags, zoom popovers, compose, terminal
  routing that passed on WebKit and on rerun).
* `workers` is `E2E_WORKERS` (default 4). The config lists that many mock daemons in
  `webServer`, on `E2E_MOCK_PORT` + 0 … + 3, beside the one Vite. `MOCK_PORT`, which
  `e2e/fixtures.ts` builds `mockUrl` from, adds `TEST_PARALLEL_INDEX`: Playwright sets it
  in each worker process, so a worker's fixtures talk to the mock at its index. The runner
  process (index unset) never calls the mock. Vite is stateless and shared.
* `fullyParallel` stays off: a file's tests run in order on one worker (some build on the
  previous test's view); files spread across workers.
* `code-block-actions.spec.ts` asserted the copied text only on Chromium (WebKit lets no
  test read the clipboard). It now records `navigator.clipboard.writeText` calls with an
  init script, as `pr-panel.spec.ts` already did, so the assertion runs on WebKit.
* `thread.spec.ts`'s open-row-height check polls instead of reading one bounding box:
  under load the diff laid out a frame later and the single read saw 69px.
* `CLAUDE.md` and the Makefile comment: WebKit, four workers; only the WebKit binary is needed.

## Measurements (M-series, 12 cores, nothing else running)

| config | wall | failures |
|---|---|---|
| before: WebKit + Chromium, 1 worker | 32.5 min | 1 Chromium flake (citations) |
| WebKit, 4 workers | 10.7 min | 2 load flakes, both pass 3/3 alone |
| WebKit, 6 workers | 12.1 min | 3 load timeouts |
| WebKit, 4 workers, with the thread.spec fix | 8.3 min | none (500 passed) |

WebKit's own test time is 18 minutes serial, so four workers give about 1.7× over the
ideal 4× share: WebKit processes contend for the GPU and main thread, and six workers are
already past the knee. Two or three flakes per full run is the price; each is a timing
assertion, not a failure of the feature, and reruns alone pass.

## Decisions

* **One mock per worker, not a shared mock with per-worker worlds.** The mock's state is
  module-level across `mock/*.ts` (`resetClones`, `resetCompletion`, …), so isolating by
  process is the change that touches nothing in the mock or the specs.
* **4 workers by default**, not `cpus / 2`: 6 was slower and flakier here, and a laptop
  with fewer cores would overcommit.
* **`--workers N` on the command line must not exceed `E2E_WORKERS`**: there is no mock
  for the extra workers. Set `E2E_WORKERS` instead.
* **Two worktrees running e2e at once** need `E2E_MOCK_PORT` values at least `E2E_WORKERS`
  apart (the T3 worktrees already pick distinct ports).

## Gotchas

* Editing `playwright.config.ts` during a run breaks it: a restarted worker loads the new
  config and fails with "Project 'chromium' not found in the worker process".
* The three timeouts at 6 workers were an action run still "running" at 8 s, a relative
  time rolling from "5 min ago" to "6 min ago" (a pre-existing clock-edge flake), and an
  Archived section still rendering. None reproduce alone.
