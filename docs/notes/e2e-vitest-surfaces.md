# e2e → vitest: thread surfaces

Second step of the plan in e2e-unit-duplicates.md: write the component tests e2e alone had,
then drop the e2e tests they cover. Area: the thread surfaces (Ember, git-op toasts, the
cold-cache note, the Diff tab, the sidebar's live count and lineage, the agents strip, the
usage chart, snooze, archive, MCP, the subagent view, plugin flags, linked PRs).

## What moved

New component tests:

* `components/ember/EmberRow.test.tsx`: the pinned row's status words, task, thread, blocked
  and scheduled counts, the flame, the click and the Open board / Settings menu.
* `components/ember/BoardSurface.test.tsx`: sections and counts, cards, worker rows, a lead's
  team, ages, the Scheduled list and its ×, the task a link asks for, the empty and loading states.
* `components/ember/EmberPane.test.tsx`: the chat header's title, summary and dot, Board and
  Show work, no thread buttons, and Ember's prompt (passed to a stand-in composer).
* `components/ember/TaskPointer.test.tsx`: task links' title, state, branch, tooltip and click,
  and Ember's markdown turning links into pointer lines.
* `components/settings/WorkerModelsEditor.test.tsx`: Settings › Ember's nav flame and chips.
* `surfaces/ember.test.tsx`: the Board is listed in Ember's chat's panel only.
* `components/gitops/GitOpToast.test.tsx`: the git-op toasts in a real sonner Toaster
  (progress, result, queued, failure output and close, CLI-started ops, a PR's Open).
* `components/thread/ColdCacheNote.test.tsx`: the note on its own 30 s timer (fake timers),
  hidden by a pending prompt.
* `components/files/DiffTab.test.tsx`: the Diff tab header (M, A, R, D, counts, base), binary,
  renamed, no change, Unified | Split, the scope switch and Open file; `stores/filePanel.test.ts`
  and `stores/codeView.test.ts` for the tab's scope and the persisted view choices.
* `components/threadinfo/LineageGroup.test.tsx`: "Lineage · N running".

Additions to existing tests: runCommand leaving git ops to their own toast (`commands.test.ts`),
`archiveThread` (`threadActions.test.ts`), the waiting card's reason (`SidebarRow.test.tsx`), the
strip as runs end (`AgentsStrip.test.tsx`), the chart's axis and mode buttons (`UsageSheet.test.tsx`),
a run ending or failing while viewed (`SubagentPane.test.tsx`).

`src/test/emberBoard.ts` is a hand-built copy of the mock's seeded Ember board (tasks, worker
threads, a lead's team) with the mock's controls as methods (`status`, `report`, `task`,
`addTimer`, ...), recounting a team the way the daemon does. It does not import `mock/`.

Product code: `EmberMarkdown` in `EmberTimeline.tsx` is exported for its test. Nothing else.

## e2e tests removed (28)

* ember (10): task link to the board, Scheduled, a lead's team, Board not offered off the chat,
  Settings chips, header and row counts, budget stop, link title and glyph, board ages and names,
  an idle worker on a doing task.
* gitops (3): failed op output, CLI-started ops, pr.create's Open (its availability is
  `internal/command/commands_gitops_test.go`'s).
* thread-cold-cache (2): the composer's own timer, hidden by a pending prompt.
* sidebar-subagents (4): every test but the screenshots.
* snooze (2): the Snooze submenu, Pick a date and time.
* mcp-panel (2): Reconnect, a thread never reported for.
* agents-panel, archive, usage-page, subagent-view, linkedprs (1 each): the strip, the row
  menu's Archive, the chart modes, a run ending while viewed, the tag's states.

## e2e tests kept, and why

Each still has a browser-only part; a later PR splits them.

* ember: the row 8px under the menu pane (geometry); the composer's placeholder on the real
  ProseMirror editor; arrows from the thread list (focus); Worked-for rows, the reply fold and
  citing (virtual list, wheel scroll, drag selection); the board's one shared WatchBoard
  stream; cmd+shift+a to Ember (global chord); a path chip opening a File tab; the restart line
  (the chat's virtual list over the mock's stream).
* gitops: progress and queued toasts, started with cmd+shift+k / f / u (global chords).
* thread-cold-cache: the note's place above the editor (geometry) and a real send.
* file-tabs: every test (@pierre/diffs render, pdf.js canvases, the HTML iframe, image
  decoding, scroll into view). The Diff tab's logic is now unit-tested beside them.
* agents-panel: background shells and the timeline's agent rows (the turn's fold and the
  mock's run and shell frames end to end).
* usage-page: the button under the sheet's backdrop and the strip's edge (geometry), the range
  across a reload.
* snooze and archive: the window-title count, computed weights, reloads, the keyboard walk,
  confirms that drop panels across routes, cmd+k, the hover card's timing, footer scrolling.
* mcp-panel: cmd+k and cmd+shift+e, M in the panel, the card's menu and hint tooltips, dashed
  pills (computed CSS), long names (geometry).
* subagent-view: Escape (global keymap), one WatchThread kept, the note's Open on hover, cmd+k.
* plugin-flags: the window-title count; an until-seen flag clearing through the daemon when
  the thread opens.
* linkedprs: the prompt not taking focus, PR tabs across routes, hover timing.
* SHOTS screenshot tests.

## Gotchas

* sonner's Toaster renders in jsdom; dismiss every toast in afterEach or the next test sees them.
* Ember's resident thread is in the threads store's `owned`, not `order`; components hold the
  board with `holdEmberBoard`, which the tests mock out and replace with published boards.
* SettingsPage needs a Dialog root (its title is the sheet's) and `Element.prototype.scrollTo`;
  the chips are disabled while a save is in flight, so each click awaits its save.
* codeView's persist merge keeps the current choice (not the default) for an unknown value.
* `tsc -p .` skips `e2e/`; `tsc -p tsconfig.node.json` checks it.
