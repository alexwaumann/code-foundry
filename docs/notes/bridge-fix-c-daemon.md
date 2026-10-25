# Phase 3, the bridge: test-round fixes, daemon, CLI and skills (2026-10-25)

Fixes from the bridge's model-behaviour test round (tester C, after #341–#344), the
daemon, CLI and skill side; a parallel PR has the GUI host's findings (1, 4, 5, 8, the
host half of 14, the panel half of 17). The tester's numbers are used below.

## What each finding became

- **2, two data shapes.** New `code-foundry-pages/reference/sources.md`: the value
  `cf.on` sends for every source (thread-list, thread, gh, action, plugin, terminal,
  project, workspace, settings, update, ember, ui), the fields a page uses with their
  value sets, read from `stores/bridgeSources.ts` and the view models in `src/api/*.ts`.
  Its intro and SKILL.md's "Before you write it" say it plainly: `cf.run`'s `json` is the
  CLI's `--json` (THREAD_STATUS_IDLE, ISO times, zero fields left out), `cf.on` sends view
  models (lower case, `…AtMs`, every field present; render with `new Date(ms)`); never
  read one with the other's names. `update.lastCheckedAt` is the one ISO string among the
  view models, and the file says so. SKILL.md's Live data shrank to the source list with a
  pointer, which paid for the new lines.
  - **The test** is `gui/frontend/src/api/bridgeSourcesDoc.test.ts`, not `src/lib/`: it
    builds one sample per source with the view models' own mappers (fully nested messages
    through `toThreadView`, `getDashboard` on a stub connection, `toEmberBoardView`, …)
    and ESLint allows generated protobuf imports only in `src/api/`. Each sample goes
    through JSON as the host sends it; every backticked name in a source's section must be
    a key somewhere in that sample, every bridge source must have a section, and a name
    ending in `At` must be called an ISO string. `pages_test.go` checks the sections and
    the shape words from the Go side. Vite's `fs.allow` gains `internal/skills/files`.
- **3, reminders and schedules.** The pages skill's choice is now "page, wake, plugin or
  reply": a wake (`thread subscribe --pr … --until checks_passed`, `--every 1h`, `--at 2h`,
  `--thread <id> --until attention --repeat`, `--note`) for "tell me when / every N / keep
  an eye on", never Claude Code's own cron or a `--watch` loop (the app stops an idle
  thread at its cache expiry and those die with it; a wake starts the stopped thread). The
  entry skill has a routing row for it and "a reminder" in its description (which dropped
  ": which skill to read" to stay under 400; the purpose line is unchanged). Its line cap
  (83) is kept by folding "Load a skill with your Skill tool…" into the table's header.
  The rendering capability says a page's background work is a wake or a plugin.
- **6, duplicate live cards.** `view.inline` of a page whose card is still live (shown
  since the thread's last user message; a queued message not read yet does not count)
  adds no card: the store returns that card (`ShowThreadHtmlResponse.reused`), renamed
  when `--title` differs, and the CLI says "updated the page already shown … no card was
  added; run view.inline only for a new file". `--panel` reuses a card from anywhere in
  the thread, so it only opens the panel. `--again` adds a second card on purpose. When a
  card is added for a page shown in an earlier turn, the response names the older card
  (`earlier_item_id`) and the CLI warns that a second card now runs the page too. The
  look and the append happen on the same goroutine (the runner's, or the stopped
  thread's log), so nothing lands between them. The skill: "once per file … never run
  view.inline for that file again, not even for "show me" after an edit".
- **7, merged PR shown open.** A merge from the app (`MergePullRequest`, merged) moves
  the PR to recently merged in the published dashboard at once
  (`internal/store/gh/pr_merged_overlay.go`), and each poll keeps it there until the
  searches agree (in recently merged and in no open list) or ten minutes pass. The poll's
  diffs (PullRequestChanged, so `--until merged` wakes, and the merged-this-month check)
  and the cache use the dashboard as the poll left it, not the overlay: the merge is still
  announced when the poll sees it. Applied inside `updateSnapshot`, so a merge shown while
  a poll publishes is not lost. The skill: on success update that row from the result.
- **9, the gesture rule.** "The press, click or key counts for 5 seconds: a quick read
  awaited first is fine, anything slower first (a long wait, a timer) loses it." Same in
  the rendering capability. Worded after the rebase on #346, whose bridge.js counts a
  trusted press in the last 5 s even when WebKit's user activation says inactive.
- **10.** `unavailable`: no such verb, the page is not shown in its thread, or (from
  `cf.on`) a source the app does not hold now; `invalid`: a wrong or missing arg.
- **11.** The rendering capability's bridge line: values may be strings, numbers or
  booleans (sent as strings); `cf.on` sends the current snapshot first, then the whole new
  snapshot after each change; snapshots are view models, not `--json`'s shape; the error
  codes' meanings; sources.md named. bridge.js's header line (which the skill quotes)
  reads "live data, fn(value, source): now, then on change" instead of "daemon events".
- **12.** Storage is per thread: keys start with the thread's id, so this thread's pages
  share it (one prefix each) and the same file in another thread starts empty. In the
  skill and the capability.
- **13, view.inline warnings** (a registry of checks, `pageChecks`): a page using `cf.*`
  without `bridge.js` gets only the bridge warning (no resize one); new warnings for a
  `setInterval` in a page that calls `cf.run`, a `setTimeout` whose callback (next 400
  bytes) calls it, `confirm(` (bare or `window.confirm`, not `x.confirm()`), and `yes` or
  `force` as a key of a `cf.run` args object. Table tests include the near misses (a
  clock, a flash message timer, `dialog.confirm()`, `"yes: do it"` as a value).
- **14, ember.** The contract the GUI PR implements: `cf.on("ember")` has data only while
  Ember's sidebar row, chat or Board panel holds the board; otherwise the subscription is
  refused with `unavailable` and a message. The skill, sources.md and the capability tell
  the model to show that message (with a Retry that subscribes again), never an empty
  board.
- **15, data a source lacks.** Limits: a read verb that has it through `cf.run`, else the
  service's API with a pasted token (GitHub's allows cross-origin calls); a plugin cannot
  feed a page, never offer that. There is no PR list verb, so the skill names none.
- **16** (not on the list, one clause): for "track"/"watch", say the page updates only
  while shown and offer a wake.
- **17, merge confirm text.** "Merge #12 “Fix the thing” into main in owner/repo with
  squash?" (the title cut at 80 runes); the static fallback names the repository too. The
  mock's confirm and three `pr-panel.spec.ts` expectations follow.

## Sizes

| File | Lines (rendered) | Note |
|---|---|---|
| `code-foundry-pages/SKILL.md` | 160 (cap 160) | |
| `code-foundry-pages/reference/sources.md` | 148 | 7.5 KB (cap 16 KiB) |
| `code-foundry/SKILL.md` | 83 (cap 83) | description 387 characters (cap 400) |

## Verified with the built daemon (Haiku 5.5, medium, auto, isolated home)

`make build`; `CODE_FOUNDRY_HOME=~/cf-fix-c-daemon`, CLAUDE* unset, a scratch git project.

- **3**, three fresh threads, one prompt each (the tester's baseline: CronCreate twice,
  `gh pr checks --watch`, "I can't" twice):
  - "every hour, archive my idle threads": entry + orchestrate skills, then
    `thread subscribe --every 1h --note "Hourly: archive my idle threads …"`.
  - "remind me when the checks on alexwaumann/code-foundry#4 pass": entry skill, then
    `thread subscribe --pr alexwaumann/code-foundry#4 --until checks_passed --note …`
    (that PR is long merged; the model did not notice, so this wake never fires).
  - "keep an eye on my threads and tell me when any of them needs me": entry +
    orchestrate, then `thread subscribe --thread <t> --until attention --repeat` for each
    of the two other threads; the wakes fired at once (both were waiting) and it reported.
  No thread mentioned a cron or a tool name.
- **6**:
  - Same turn ("make me a page … Once it's shown, make the status text bold and show it
    to me again"): the second `view.inline` answered "updated the page already shown" and
    renamed the first card; the model then ran `--again` because the user said "show it
    to me again". The message no longer names `--again` (only its help does).
  - Across turns, before the "show me" clause: after "make the status text bold and show
    me" the model ran `view.inline` again, a second card (a user message came between, so
    the first was no longer live). "now open it in the side panel" ran `--panel`, which
    reused the card (no third one; no window was open in this run).
  - Across turns, after the clause and the warning: page, then "make the status text bold
    and show me", then "now make the thread names a bit bigger": both edits in place, no
    second `view.inline`, one card. `view.inline --thread` on that page afterwards printed
    the earlier-card warning; again at once answered "updated the page already shown".
- **7** is covered by the store tests against the fake GitHub (whose searches lag like
  GitHub's: the merged PR stays in the authored section until the test moves it); no live
  merge.

## Gotchas

- `thread new` takes the prompt as `--prompt`, not positionally.
- Port 7799 (the e2e mock) was held by another session's run; `E2E_MOCK_PORT` and
  `E2E_VITE_PORT` move a partial e2e run off it.
- `make gen` regenerates `gui/frontend/src/gen` (generated, the only other `src/` change
  besides the new test).

## Daemon restart

Needed: the skills are written at daemon start, and view.inline, pr.merge's confirmation,
the gh store and the capabilities are the daemon's. GUI and daemon ship together (the
proto fields are additive).
