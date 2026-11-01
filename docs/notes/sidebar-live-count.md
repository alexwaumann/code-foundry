# Sidebar: one live count for subagents and child threads

GUI only, one PR. Asked by a user on 2026-10-31: the row's Bot badge on line 3 counted
Claude Code's own background subagents only, and child threads showed as the waiting
detail "2 child threads" on line 3. The user should never have to know whether the model
used the Agent tool or spawned a thread: one number for both.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/lib/liveCount.ts` | `liveCount` (background subagents + live children), `liveChildCount`, `isLiveChild`; pure, table-tested |
| `gui/frontend/src/stores/lineage.ts` | `useLiveCount(id)`: a number selector, read by the row's badge and the card's label |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | the Bot badge reads `useLiveCount` |
| `gui/frontend/src/components/threadinfo/LineageGroup.tsx` | "Lineage · N running" reads `useLiveCount` (was the live rows' length) |
| `gui/frontend/src/lib/lineage.ts` | `lineageStatus`: the `waiting` kind is `working` (was `idle`) |
| `gui/frontend/src/lib/statusRegistry.ts` | `statusDetail` for `waiting` is "" (line 3 falls back to the branch) |
| `gui/frontend/src/lib/waiting.ts` | `waitingParts(reason)`; `waitingCount` reads the child-thread part only; `waitingText(parts)` says the whole reason |
| `gui/frontend/src/components/sidebar/TipWaiting.tsx` | the hover card's sentence from the parts |
| `gui/frontend/src/lib/agents.ts` | `agentsLabel`: "N subagents" (the badge's aria label); the strip's sentence keeps "agents" |
| `gui/frontend/mock/liveCount.ts`, `mock/world.ts`, `mock/server.ts` | `waitingReason` (the daemon's grammar), `POST /__mock/live-count` (`World.addLiveCount`) |
| `gui/frontend/mock/ember.ts` | a team member waiting is working only for the child-thread part |
| `gui/frontend/e2e/sidebar-subagents.spec.ts` | the badge, the card, the hover card, a nested lead, SHOTS screenshots |

## Decisions

* **The count**: `Thread.background_agents_running` (the thread's own background runs,
  spawn depth 1; a foreground run is line 3's busy tool) plus the threads it created whose
  lineage row is live: working or attention (`childRowState(lineageStatus(t))`), hidden
  children included, archived and snoozed ones not (`lineageStatus` puts those first). A
  grandchild is its own parent's, not counted twice: a nested lead counts 1 for its
  creator and shows its own count on its own row.
* **One source**: the card's label used `live.length` over the subagent runs in the
  thread's log and its children; it now reads the same `useLiveCount` as the badge. The
  card still lists every live row it did (a foreground subagent run among them): a row
  listed without being counted is that turn's busy tool, as on the sidebar.
* **A waiting child is working.** Before, `lineageStatus` folded `waiting` into idle, so
  a lead waiting on its workers sat under Previous agents as done in its creator's card.
  The Threads words in the card's hover card and the parent row follow ("Working").
* **Line 3** shows the branch for a waiting thread. "Waiting" and its elapsed time on
  line 1 are unchanged; the hover card says what it waits on.
* **The reason grammar** (the daemon PR in flight): "waiting on " + the non-zero parts
  joined by " and ", "N child thread(s)", "N subagent(s)", "N shell(s)" in that order;
  "waiting" alone is a queued wake. `waitingParts` reads any subset, skips a part it does
  not know, and reads today's "waiting on 2 child threads" as before. `waitingCount`
  (Ember's "a lead waiting on its team is Working") reads the child-thread part only, as
  the daemon's `internal/store/ember/team.go` rule does today.
* **Restart and archive cut-offs untouched**: `restartCutsOff`, the update dialog and the
  archive confirmation read the daemon's own `background_agents_running` /
  `background_shells_running`; children survive a restart, subagents do not.
* **The agents strip** above the composer keeps "2 agents running in the background": it
  names Claude's background runs only, so it does not take the badge's word.

## Gotchas

* The memo in `lib/liveCount.ts`: every row's selector runs on every thread-list change,
  and a scan of the list per row (`childIds`) is quadratic. The child index is built once
  per list (keyed on the store's `byId` and `order` objects, which it replaces on change).
* `e2e/*live*.spec.ts` (`/live(-[a-z]+)?\.spec\.ts$/`) is the live-daemon suite and is
  ignored by the mock config: a spec named `sidebar-live-count.spec.ts` is never run. The
  spec is `sidebar-subagents.spec.ts`.
* The mock refuses a status change on a disconnected thread: the lineage scenario's
  connected children (`s-l-e2e`, `s-l-cookie`) are the ones the e2e moves.
* `thread-info.spec.ts` "the overlay: off at narrow…" failed once here and once on the
  base commit (139c37b54) in a separate checkout, then passed in the full run: flaky,
  not this change.

## Verified

* Unit: `liveCount.test.ts` (subagents, working / starting / asking / waiting children,
  finished / idle / failed / archived / snoozed ones, another thread's and a grandchild,
  the memo across lists), `lineageStatus` waiting -> working, `waitingParts` /
  `waitingCount` / `waitingText` over every reason form, `statusDetail` waiting -> "",
  `SidebarRow` (badge 3 = 1 subagent + 2 live children, "3 subagents", the branch on line
  3, the badge following the children), `TipWaiting` (every form).
* e2e (WebKit, mock): sidebar, lineage, thread-info, agents-panel, ember, snooze, threads,
  archive, update and the new sidebar-subagents spec, 99 passed.
* `make check` green. Dark and light screenshots of the sidebar (a working thread with two
  background subagents, a lead waiting on two children and a subagent with its branch and
  badge 3, a nested lead with badge 1, a thread waiting on a shell alone) are in the PR.
