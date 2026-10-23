# Ember, PR 3 of 3: the GUI (2026-10-20)

PR 1 (`ember-1-primitives.md`) gave the daemon resident threads, reseeds and timer wakes;
PR 2 (`ember-2-store.md`) built Ember on them: its settings, store, task board and
`EmberService`. This PR is the GUI, ported from the approved sketch (a script that
injected Ember into the real frontend against the mock; chat, panel, settings and the
flame's states): the flame glyph, the pinned row above New thread, Ember's chat, the Board
panel surface and the worker-model chips. Frontend only.

## Components

* `components/ember/Flame.tsx` + `ember.css`: the sketch's SVG (outer and inner tongue,
  two eyes, a mouth) with CSS animations by `data-state`: idle (slow wobble, dimmed glow),
  thinking (taller, pupils up, faster), working (flicker), attention (a grin, drawn as a
  second mouth path rather than the sketch's CSS `d:`, and an amber ring in
  `var(--warning)`). The eyes blink every 5.2 s in every state. Sizes by `data-size`: row
  22×25, header 16×18, nav 13×15, hero 44×50 (empty states). Under
  `prefers-reduced-motion` nothing moves; the attention ring stays, still, so the state
  still reads. The fills are the sketch's fixed colours (a mascot, not a theme token).
* `lib/ember.ts` (pure, table-tested in `lib/ember.test.ts`): `flameState`, the board model
  (`boardCards`, `boardSections`, `cardMeta`, `cardProgress`, `workerRows`), the words
  (`workerWords`, `emberStatusWords`, `headerSummary`, `firstDoingTitle`, `linkMeta`),
  `splitTaskLinks`, `buildEmberRows`, `workSummary`, `workMs`, `shortDuration`, and the
  worker-model list helpers (`modelList`, `toggleModel`).
* `api/ember.ts`: `EmberBoardView` / `EmberTaskView` / `EmberTaskThreadView` /
  `EmberStatusView` from the generated types (the only place they are used), and
  `watchEmberBoard`. `api/threads.ts` now exports its state, status and report maps for it.
* `stores/ember.ts`: the board from one shared `EmberService.WatchBoard`
  (`holdEmberBoard(priority)`, reference counted like `startThreadWatch`), narrow
  selectors (`useHeaderSummary`, `useFirstDoingTitle`, `useWorkingThreads`, `useLinkMeta`,
  `useBoardCounts`, `useFlameState`, all primitives), Ember's thread id
  (`emberThreadOf`: the owned thread whose `resident` is `ember`), `ember.enabled`, the
  Board's scroll target (`focusEmberTask`), the bell's `emberAttentionId`, and
  `clearWorkRowChoices` for Show work.
* `stores/emberPanel.ts`: `openEmberBoard(taskId?)`, `toggleEmberBoard()`,
  `useEmberBoardShown`, `openEmber`, `openEmberSettings`, `EMBER_ROW_KEY`.
* `components/ember/EmberRow.tsx`: the pinned row. `EmberPane.tsx` (`EmberBody`, the
  chat), `EmberTimeline.tsx` (rows, the work row, the text with pointer lines),
  `EmberView.tsx` (the `view:ember` selection), `BoardSurface.tsx`;
  `surfaces/ember.ts` + `emberTarget.ts`; `components/settings/WorkerModelsEditor.tsx`.

## The pinned row

Under the toolbar and above New thread (`Sidebar.tsx`), only while `ember.enabled` is on
and the resident thread exists. The flame (22×25), "Ember" in `text-body font-semibold`,
and a `text-caption-sm` line like a thread row's: `<Status> · <first doing task title> · N
threads`. Status: Ember's own thread first in the thread rows' words and colours (Working
sky, Needs input amber, Finished emerald, Error red: lib/lineage's set), else Working (sky)
while a task is doing, else Idle (muted). "N threads" counts worker threads working. It
follows the gutter rule as a thread row does (the body's `pl-shell`, `px-2` inside). A click
selects the Ember thread (`{kind: "thread", id}`, as a thread row's click). Its context menu
has Open board and Settings only (nothing archives, snoozes or renames it; the daemon
refuses those anyway). It holds the board stream "inline" while shown.

Keyboard: the row sits outside the listbox, so the list's handler owns it. ArrowUp from the
first thread row, or Home, puts the cursor on `ember` (ring drawn through a
`:has(thread-list:focus)` variant, since the row is outside the list's `group`); ArrowDown
from it goes to the first thread; Enter opens the chat. With the chat selected and no
cursor, the arrows start from the row. `aria-activedescendant` points at `row-ember`.

Attention: the bell adds one while Ember needs attention (a prompt, or the finished-turn
attention the daemon clears when a Watch sees it, i.e. a reply the user has not seen), and
cmd+shift+a / the bell's click reach Ember first (its row is the first). The Dock badge,
the start page and every list keep leaving Ember out (PR 1's `isOwned`).

## The chat

`ThreadPane`'s `WatchedThread` routes a thread whose `resident` is `ember` to `EmberBody`:
the same Watch (and so the same "seen" marking), `useThreadActivity`, `TimelineList`,
`TimelineRowView`, the composer and the AgentsStrip. Its own parts:

* Header: the flame (16×18) and "Ember", the board's "N threads working · M queued" (a sky
  dot while workers run; "Nothing in progress" otherwise) where a thread shows its place;
  Board (pressed while the panel shows the Board), Show work (eye; `ui.emberShowWork`,
  persisted), and the panel toggle. No archive, snooze, fork or rename.
* Composer: `ThreadComposer` with the placeholder "Tell Ember what you want done…" (a new
  `busyPlaceholder` prop replaces "… Claude picks it up mid-turn" while it works). The
  model and effort pickers are the thread's. No project picker (a thread composer has
  none).
* Empty conversation: the hero flame and one line. `view:ember` (`EmberView`, a new view
  name, so a `ShowView ember` intent opens it): the chat once the thread exists, "Ember
  is waking up…" while Ember is on without one, "Ember is off" with a settings button
  otherwise.

### How the fold is computed (`buildEmberRows`)

Over the thread's structural timeline items (the same keys `Timeline` uses, so text deltas
do not rebuild rows), plus the ids of wake messages (a shallow selector; the timeline key
has no origin):

1. Subagent items nest under their Agent call and permissions attach to their tool call,
   as `buildTurns` does. A permission on a tool call is in no run (its tool row shows it).
2. Visible: a user message that is not a wake, Ember's text, system notes, errors, a
   pending question, a pending permission without a tool, and a tool call whose permission
   is pending. Everything else (tool calls, groups, thinking, subagents, answered prompts,
   wakes, compactions, turn ends) goes into the current run.
3. A visible item closes the run: one work row `w:<first item id>` (stable while the run
   grows), and, while expanded, the run's ordinary rows (`workNodes`) after it. A run of
   turn ends only (every reply's own) makes no row.
4. While Ember works, the trailing run is live ("Working · what so far · elapsed",
   spinner); with no work yet since the last message, a live row stands alone.
5. Expanded = the user's choice for that key (the thread store's `expanded`, which
   leaving the thread forgets) else Show work. Toggling Show work clears the choices, so
   it opens or closes every row.

The line: "Worked for 2m · read 5 files, created 2 threads, updated the board".
`workSummary` reads the run's top-level items: wakes, Read/NotebookRead (files), the other
explore tools (searches), and Bash commands by what Ember runs: `thread new` (created),
`ember task add|update|done|cancel` (updated the board), `ember board|status|task
list|show` (checked the board), `ember remember` (noted), `thread read|get|items|events|
show|list` (read threads), `thread send` (messaged), git (checked git), anything else (ran N
commands); then subagents, skills, other tools. `workMs` sums the run's segments, a turn
end or a wake closing one, so the hours between a reply and the next wake are not "work".

The seed prefix never shows: the daemon keeps it in `UserMessageItem.seed_prefix`, which
the GUI does not map; the message's text is the user's alone. No "New epoch" hairline (the
items carry no epoch; skipped as not cheap).

### Task links

`splitTaskLinks` cuts Ember's text into markdown and task links, a link being
`[Title](cf-task://t-…)` alone on its line (a list bullet allowed; one inside a code fence
stays code). The markdown renderer is not touched: react-markdown and rehype-sanitize drop
the `cf-task:` scheme, so a link inline in prose renders as its title only. Each link is a
`TaskPointer`: a chevron turned down, the title (`text-body-sm font-medium`), then "·
in progress · 3 pieces · 2 working" from the live board (`linkMeta`: the task's state in
board words, its subtasks, its and their working workers); a task the board does not have
shows just the title. A click opens the Board in the chat's panel and scrolls to the task's
card (a subtask's: its parent's), ringed for 1.6 s.

## The Board surface

`surfaces/ember.ts`, kind `ember`, title Board, hotkey B, listed first. Available only for
the Ember chat's selection while Ember is on (hidden everywhere else, so no other panel
lists it). One tab, no params. `BoardSurface` holds the board stream "core" while it shows.

* Header: "Board" and "N in progress · M up next" (cards).
* Sections: In progress (doing and blocked), Up next (todo), Done today (done or cancelled
  since local midnight, ten until "+N more"); empty sections are not drawn. A card is a
  top-level task (a subtask whose parent is not on the board is a card of its own) with its
  subtasks; it sits by its own state.
* A card: the state dot (sky doing with a halo, amber blocked, emerald done, a muted ring
  for todo and cancelled), the title (cancelled struck through), on the right "x of y"
  (done of not-cancelled subtasks) for a parent, else "blocked" (amber), the worker's
  status words, or the state ("queued", "done", "cancelled"); a 3px progress bar for a
  parent; a blocked task's outcome in amber, a done or cancelled one's muted.
* Worker rows: the task's own worker (its name), then each subtask (its title), each with
  a dot, its words and an age (`shortAge` of the worker's last activity, else the subtask's
  last change). Words: a prompt or error first, then a blocked or failed report ("Blocked"
  amber, "Failed" red), then, while the task is doing, the latest report's summary (muted,
  truncated, full text on hover), else the worker's status words. A row whose thread exists
  opens it (a hidden child of Ember's) as a Threads tab row does.
* Not virtualized: the board is tens of cards at most and Done today is capped; a long
  board would need it.

The board stream: the sidebar row holds it inline, the chat and the Board core, so there
is one WatchBoard however many show (`/__mock/streams` counts it in e2e), it yields its
slot to a core stream when slots run out while only the row holds it, and nothing holds it
while Ember is off or the sidebar is hidden with no chat open.

## Settings

The Ember page renders from the schema as before, plus: the nav's icon is the flame (idle,
13×15; `pageIcons` now takes any component), and `ember.worker_models` is a key editor
(`WorkerModelsEditor`): one chip per registry model with its label from `useModelChoices`
("Opus 4.7"), pressed (check, sky border and tint) when in the list. A click toggles; a
model added goes to the end (the round robin's order); the last pressed chip is
aria-disabled with a tooltip. No "+ Add": every model is shown. The row is a tall editor
(top aligned, as the chips wrap). The Int editor's box widens for a long unit, so
"400000 tokens" fits.

## Deviations from the sketch

* The chat's first work row sits above Ember's first reply, not below it: rows are
  chronological, and Ember plans before it replies. The sketch put it after.
* The worker-model chips are labelled by model only ("Opus 4.7"), not "Opus 4.7 · High":
  the effort is its own setting (`ember.worker_effort`), as the brief says.
* The Board header lives in the surface's body (as the Threads tab's does), under the
  panel's tab strip, not in the panel header.
* The sketch's settings rows (an "Experimental" tag, rewritten descriptions, "Ember model")
  are the daemon's schema text from PR 2, unchanged here.
* Status words on the pinned row include Finished and Error besides the brief's Working,
  Needs input and Idle (the thread rows' set), so an unseen reply reads as Finished.

## Mock

`mock/emberChat.ts`: the resident thread's chat, matching the seeded board (seeded by
`World.addResident`, so `/__mock/resident` and `/__mock/ember?enabled=true` both bring
it): the ask, a run (the board, two reads, two `thread new`, task updates), a reply with
two task links; a wake from the blocked wails worker, a read and a reply; a follow-up taken
as a subtask. Three work rows, three task links, one wake.

## Tests

* Unit: `lib/ember.test.ts` (flame table, task links, the fold incl. a pending permission
  splitting a run and live rows, the summary and duration, the board's sections, cards,
  worker rows and words, the chips' toggle), `stores/ember.test.ts` (Ember's thread, the
  bell's attention).
* e2e `e2e/ember.spec.ts`: the row hidden when off, shown above New thread when on, gone
  again; its line and flame state; the chat and its header, placeholder and menu; the
  arrows reaching the row; three work rows with their summaries, one opening in place, Show
  work opening and closing all; a task link's meta, its click opening the Board at the
  task, the meta following the board; the board's sections, cards, worker rows, one stream,
  a live add, a worker opening its thread; the Board not offered on another thread; the
  nav flame and the chips (toggle on, off, the last one stays).

## Verification

* `make check` green; `make gui-e2e`: 485 passed, 26 skipped live specs, one failure in
  `workspaces.spec.ts` ("pick a project, add Also in", a cmd+n then cmd+1 picker timing
  check with Ember off) that passed 12 of 12 on a rerun: a flake, not this PR.
* Live (2026-10-20): `make build`, the daemon with `CODE_FOUNDRY_HOME=/tmp/ember-pr3-home`
  (`daemon --dev`), Ember and its workers on `claude-haiku-5-5[1m]` at medium, a scratch
  git repo `~/ember-pr3-scratch` registered as a project, `ember enable`, then `thread send
  --id <ember> "In the ember-pr3-scratch project, add a file hello.txt … commit it on a
  branch. Do not push and open no PR." --wait`. The GUI (Vite, pointed at that daemon with
  `?daemon=…&token=…`, WebKit): the pinned row (Working), the chat with "Worked for 9s ·
  created 1 thread, updated the board, ran 1 command, used 2 skills", Ember's reply with
  its task link ("· done" once the worker finished, live from WatchBoard), a second run
  "Worked for 4s · 1 wake, updated the board, checked git", the live "Working" row under
  the streaming reply, the busy placeholder, and the Board opened from the link with the
  task under Done today, its outcome and its worker row (Finished). Then the daemon was
  stopped (SIGTERM) and the scratch home, repo and their `~/.claude/projects` entries
  deleted.

## Gotchas

* The Ember row is outside the sidebar's listbox (it sits above New thread), so the list's
  `group-focus` ring cannot reach it; the ring uses an arbitrary `:has()` variant on the
  sidebar body.
* Playwright will not click an `aria-disabled` button; the spec checks the attribute and
  force-clicks.
* Ports 7811/9311 were taken by the sketch session's mock and vite; this PR's screenshots
  used 7841/9341.

## Later: the reply fold (2026-10-23)

Only a turn's last text is Ember's reply now; text between tool calls folds into the run,
pages and theme cards show, and the reply is the thread's `TextRow` (citable, Copy answer)
with the cite layer mounted. See `ember-reply-fold.md`.
