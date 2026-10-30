# Thread info card 2/5: the card

Status: done on branch `cf/thread-info-card` (one PR, GUI plus the toggle's command). The
second of five PRs (1/5: `docs/notes/thread-info-facts.md`). It builds the per-thread
info card from the v14 sketch (`docs/sketches/thread-info`, kept out of the repo): a
320px column right of the conversation and composer, groups divided by lines, no
headings, every empty row or group left out. Nothing is removed yet: the header keeps its
buttons (PR 3), Add project and Save as workspace are disabled placeholders (PR 4), server
rows are PR 5.

## The toggle

* `view.thread-info` (`internal/command/commands_view_thread_info.go`): ShowView
  `thread-info`, chord cmd+shift+i, in the palette. The GUI presents it in the window
  (`keys/bindings.ts`) and `stores/views.ts` handles the CLI's ShowView: both flip
  `useUiStore.threadInfoOpen`, persisted with the window's other UI state like
  `sidebarVisible`. One switch for every thread the window shows.
* It is a window action, not a page: `daemon.capabilities --group pages` lists it in
  `notPages` beside back and forward. The generated guide went over its 25,500-byte soft cap
  (25,519) with it, so it joins `leftOut` beside `composer.history`.
* The header button (`ThreadInfoToggle`, lucide SquareChartGantt, pressed while open) sits
  left of the bottom and side panel toggles.

## Layout

`ThreadPane`'s body is a row: the existing column (timeline, dock, cite layer, page
overlay) then `ThreadInfoCard` when open: `w-80`, `py-3 pr-3`, scrolling. (Since
`docs/notes/thread-info-scroll.md` the card lays over the column's right instead, and the
list's scrollbar stays at the pane's edge.) The card is
`bg-cf-sidebar`, a border, `rounded-lg`, no shadow. The conversation and composer stay one
column, so they stay aligned and narrow together. Ember's chat and the subagent view have
no card.

The card steps aside while the conversation would be under 480px beside it
(`cardFits`: the body measured with a ResizeObserver, `lib/useWidth`, the way the panel
split measures): at the 900px window minimum, or with the side panel open on a 1280px
window. The toggle stays on and pressed, its tooltip says "Not enough room"
(`stores/threadInfo` `useCardRoom`), and the card returns when there is room again.

## Rows (`components/threadinfo`)

* `Row`: icon column, text, right value, then a chevron column every row reserves, so
  values line up whether a row has a chevron or not. The chevron points down only while
  that row's menu is up or its fold is open. A row may click (`onActivate`), be a menu
  trigger (Radix `asChild`; it takes the trigger's props and ref), or both
  (`menuOnChevron`: only the chevron opens the menu, a press elsewhere clicks). Hover cards
  are `Tip` with rich content, side left, `max-w-65` (260px).
* `RowMenu`: a `DropdownMenuContent` as wide as its row
  (`--radix-dropdown-menu-trigger-width`), which is the card less 6px a side; items in
  `text-caption`. `DropdownMenuSub*` were added to `ui/dropdown-menu.tsx` (shadcn's) for
  Add action's project submenu.
* Pure models in `lib/threadInfo.ts` (unit tested): the git state row's priority, the
  action pick, the pull request lines, the disabled rule, the cache and context figures,
  background shells from the log, lineage rows.

## Decisions

* **Members** are the thread's set with the cwd's project first, then the set's order
  (project id), from `useThreadCheckouts` (recorded paths, resolved as the daemon does).
  Each checkout's branch and status come from the projects store at that path: no
  Checkouts RPC is needed.
* **Action row**: one `ActionService.LastRun` per member with actions, in one resource
  keyed by the thread, the members and the newest run among them (a run anywhere re-reads
  it). `chooseAction`: the newest pick whose source is this thread, in any member; else the
  cwd's project's pick; else the first member's. The project is named on a second line only
  when it is not the cwd's. **The daemon runs a thread's actions only in its cwd's
  project** (`Snapshot.Resolve`), so another member's action runs as that member's
  worktree run (`{kind: "worktree"}`, as a Projects page row runs it); the cwd's runs for
  the thread. That run's tab opens in the Projects page's panel, so the card toasts
  "Running <action> in <project>" with Show, which reveals the run's terminal (else the
  Projects page).
* **Changes** shows nothing until every checkout's detail is read (a failed read counts
  as none), then counts what the Worktree tab's Changes heading counts: the checkout's
  `GetWorktreeDetail` files against the base (commits and uncommitted work), one watched
  detail per git member. A click opens the cwd's **Worktree tab**: Diff tabs are one per
  file, so there is no whole-checkout Diff tab; the Worktree tab's list opens each file's.
  In a workspace each dirty project's sub-row opens its own Worktree tab.
* **Git state row** is the cwd checkout's. Conflicts, then diverged (needs an upstream),
  then an operation in progress, push, pull, then rebase once 10+ behind the base. Push and
  Pull run `git.push`/`git.pull` on the cwd; Resolve, Fix and Rebase send their prompt with
  `thread.send` (the composer's command, without touching its draft, holding the composer's
  failed-prompt notice as its sends do). Push, Pull and the Rebase button are disabled while
  the thread is busy, any subagent runs, or another thread's model works in the checkout
  (`otherModelWorksIn`: its cwd or a recorded checkout, and it is mid-turn or has subagents
  running; a thread whose process is up but idle does not count). Every button and Push or
  Pull runs once: the row is pending until its send or command settles (`runOnce`, the
  `rerunning` rule of `stores/actionActions.ts`), and a double click's second click is
  ignored.
* **Pull requests**: the thread's linked PRs (which already union Claude's links, created
  children and the worktree branch's PR), each detail watched while the card shows. Closed
  ones and ones whose detail has not loaded are left out. Order: the cwd's project first,
  then members, then other repositories (named by slug); open and draft before merged,
  newest number first. The review in the PR tab's words: approved, changes requested,
  "review requested" only while someone is asked, else "review required" or "no review".
  Stacked: the base is another linked open PR's head.
* **Lineage**: subagent runs and the threads this one created (hidden ones too) are the
  same row. Running or waiting ones first, newest first; finished ones under Previous
  agents (their time does not tick). A live child's stop square interrupts it: a sibling of
  the row laid over its value, keyboard-usable (Enter interrupts, it does not open the
  child). **Subagent rows have no stop square**: no command stops one run. The dots menu's Show hidden threads toggles
  `threads.show_created_threads`; Archive finished is disabled (nothing does it in bulk).
* **Context**: the hover card's "N cached" is the context while the cache is warm. The
  daemon publishes no per-turn cached figure; a warm cache serves the whole context to the
  next turn. Expired, it says what re-reading costs (`contextRereadUsd`).
* **Usage**: the Usage tab's totals (`lib/usage`); Cache write sums the 5m and 1h kinds;
  the hover card lists models by their label (`canonicalModelName`), cost and share.
* **Finder icon**: lucide has no Finder face; `icons/FinderMark.tsx` draws the sketch's.

## Follow-ups

* **A thread runs actions in any project of its set** (daemon): let `action.run` with a
  thread owner take an action of another member, run in that member's checkout and owned
  by the thread. The run then lands in the thread's bottom panel, is recorded against the
  thread, and the action row's last-run pick works across the set; the card's toast and the
  worktree-owner path go.

## Mock

`POST /__mock/thread-info?scenario=single|ws9|busy|child|nogit` (`World.addThreadInfo`)
adds held threads covering every row: s-ti-1 on a fresh copy 3 ahead with two PRs, four
changed files, the agents script (subagents, a background shell, MCP servers) and three
child threads; s-ti-ws over nine projects in workspace "platform" (diverged cwd, a moved
checkout, a rebase in progress, seven PRs over four repositories, one stacked, a Typecheck
run in web before Run in moved the thread to api); a busy variant; a child; a thread in a
folder without git. `GhWorld.addCardPullRequest` and `setCardDetail` are the fixtures.
`addMultiThread` takes an optional id.

## Tests

* `lib/threadInfo.test.ts`: git state priority, disabled rule, action pick, PR check words
  and rows (order, closed, stacked, foreign repository), cache and context figures, MCP
  counts, background shells, lineage split and elapsed.
* `e2e/thread-info.spec.ts`: the single-project card end to end (toggle and its
  persistence, every group, folds, Worktree and PR tabs, branch copy); the nine-project
  workspace (Run in menu at full card width, foreign PRs, Changes fold, Fix sends its
  prompt); a busy thread's disabled Push with its reason; a child's parent row; no git
  group without git.

## Gotchas

* Resource keys can hold `\u0000` (`detailKey`): joining several keys for one effect needs
  another separator, or the details are watched under broken keys and the card says "No
  changes".
* A Radix menu's open animation scales it: measure its width after it settles.
* The repo has no Prettier config; its files are wrapped near 160 columns.

* Live data showed what the mock did not: a cost of "<$0.0001" is wider than a 3rem
  column; the usage fold's cost column is `minmax(3rem,auto)`.

## Review fixes (PR #407)

One commit each: sends and git commands run once; the busy rule counts models that work,
not processes that are up, with no clock in the selector; the card steps aside under 480px
of conversation; another project's action says where it runs; review wording; Changes
waits for the details; no stop on subagents and a keyboard-usable one on children;
submenus scroll like menus; finished rows and the context row do not re-render every tick.
New cases: `otherModelWorksIn`, `cardFits`, the review words, `runOnce`, and e2e for a
narrow window, a double-click Fix, an action of another project, and the stop square.

## Verified

* `make check` green (it first caught the page library bundle, which carries
  `ui/dropdown-menu`, and the pages skill's components reference, which must list every
  `@cf/ui` export: both updated for the Sub parts).
* `e2e/thread-info.spec.ts` green on WebKit; the mock scenarios also checked by hand
  against the v14 shots.
* The real app (`make gui-build`) on an isolated home (`CODE_FOUNDRY_HOME=/tmp/...`,
  scratch repos `web` and `api` with local bare remotes, Sonnet 5.5 medium, one-word
  prompts): a project-folder thread on `web` (main 1 ahead: Push; 3 changed files; the
  Check action; MCP counts; context and usage from the turn) and a fresh-copy thread over
  the `platform` workspace (2 projects; the project menu with Add project disabled and Run
  in; Changes over 2 projects; "not pushed"). Dark and light screenshots in the PR body.
  The card's toggle was put back off afterwards (the isolated app shares the installed
  app's WebKit storage); scratch repos, home, binaries and the daemon removed.
