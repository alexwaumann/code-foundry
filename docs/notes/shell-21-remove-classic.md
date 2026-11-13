# Shell PR 21: the classic window, its side panel, bottom panel and stores are removed

Twenty-first PR of the shell stack (`docs/notes/shell-plan.md`, section 4, "PR 21"; 2.11; 5.3). The
window shell is the only window. The classic window (`?shell=0`, the palette's "Toggle new shell
(preview)") is gone with everything only it drew, and the 199 e2e tests PR 20 skipped by name
(`e2e/cutoverSkips.ts`) are rewritten against the shell or deleted; the list and the config's skip
mechanism are gone. Daemon verbs and intents are PR 22's: the GUI ignores the classic window's.

## What went

| Where | What |
| --- | --- |
| `components/panel/*`, `components/bottom/*` | the side panel and the bottom panel, their toggles, strips, surface list, resize handles, split, expand (`panelKeyContext.ts` moved to `shell/panelKeyContext.ts`) |
| `stores/panel.ts`, `bottomPanel.ts`, `bottomActions.ts` | their stores (persisted `code-foundry.panel` / `code-foundry.bottom` stay readable as raw strings for the first-load import, `shell/legacyImport.ts`) |
| `shell/flag.ts`, `palette/shellPreview.ts` | the shell flag, `?shell=`, "Toggle new shell (preview)"; `ShellMode` lost `"classic"`, `useShellChrome` went |
| `App.tsx` | the classic content column, content pane and side panel: the top bar, sidebar and `Shell` always |
| `shell/host.ts` | the classic half and the seam's guard (`host.guard.test.ts`); the pure tab helpers moved to `shell/tabs.ts` (`Tab`, `tabId`, `makeTab`, `pullRequestTabId`, `selectionTarget`); `showTabs`, `expandTabs` and `TabPlace.expanded` went |
| `stores/views.ts` | `togglePanelCommand`, `expandPanelCommand`, `newPanelTabCommand`, `splitPanelCommand`, `mcpPanelCommand`, `toggleBottomCommand`; `historyCommand` is the focus history only |
| `stores/ui.ts` | selection history (`history`, `back`, `forward`, `pruneHistory`, `canStepHistory`), `windowWidth`, panel and bottom constants (`PANEL_*`, `BOTTOM_*`, `CONTENT_MIN`, `panelMax`, …), the `panel` and `bottom` focus regions and their focus counters, `projectsLast` / `openProjects` |
| `stores/context.ts` | the bottom panel's focused shell as the context's terminal |
| `stores/intents.ts`, `events.ts`, `archiveCleanup.ts` | the classic reveal of a FocusTerminal, the bottom panel's reaction to new and removed terminals, the panel resets on archive and snooze (the layout's job) |
| `keys/bindings.ts` | `classicPresenters`, the classic cmd+shift+a (`jumpToAttention`), the panel verbs' presenters |
| `stores/shellList.ts` | the classic branch of `sidebarThreadOrder` |
| sidebar | the classic list (`SidebarList`, the title band, `HistoryButtons`), the Pull Requests and Projects rows (`PullRequestsNav`, `ProjectsNav`), `SidebarMenu`'s `pages`, `RowMenu`'s `terminal` and "New terminal here" |
| thread header | the classic title (`ThreadTitle`, its title menu and stale-plugin dot); `ThreadCrumb` stays for a subagent run's header, `HeaderActions` is the info toggle only |
| page headers | the panel and bottom toggles on the Projects, project, workspace, Pull Requests and Ember pages |
| `components/plugin/PluginSurfaceRows.tsx` | the side panel's plugin rows |
| `stores/terminals.ts`, `settings.ts` | `shownIn` (a terminal shown in another key's bottom panel), `panelKeepOpen` |
| vitest | the removed modules' tests: `panel*.test`, `bottomPanel`, `bottomActions`, `views.split`, `ui.history`, `host`, `host.guard`, `flag`, `shellPreview`, `components/panel/*`, `components/bottom/*`, `HistoryButtons`, `ThreadHeaderStopped`, `surfaces/ember.test`, `surfaces/pullrequest.test` (the side panel's surface list) |

## What moved onto the shell

- **Surfaces' tests** run on a small fake: `src/test/fakeLayout.ts` puts the mock daemon's own layout
  (`mock/layout.ts` MockLayout, its ops and placement) behind `applyLayoutOp` and feeds its events to the
  layout slice; `src/test/shellPanes.tsx` draws the current space's panes with the real `PaneView`;
  `src/test/layoutTabs.ts` reads them. `projectsWorld.resetPanels`/`panelActive` and
  `threadInfoWorld.activePanelTab` read the layout. `prPanelHarness.tsx` draws `ShellPanes`.
- **Terminal actions** that went to the bottom panel go to the layout (`shell/terminalActions.ts`):
  `focusTerminalTab`, `showTerminal` (`ui.focus.terminal`), `newTerminalInContext` (`terminal.new`),
  `closeTerminal`. An action run, a skill's setup, the thread info card's Open in › Terminal, the Projects
  pages' New terminal, a server row's click and a failed setup's Open use them.
- **A plugin's terminal node**: "Open in bottom panel" is "Open in a tab" (`ui.focus.terminal`); the node
  steps aside while a tab of the current space shows the terminal (`stores/pluginTerminals.ts`).
- **Thread-scoped ShowViews** (`stores/threadPanelIntent.ts`) stay: the daemon places the item's tab and the
  window brings its half (an edit request's id and asker, a diff call's file pick, `--focus`), through the
  seam. The classic panel actions (`panel.toggle`, `.expand`, `.new-tab`, `.split`, `bottom.toggle`) are
  ignored there and in `showView`, and their verbs are presented as nothing and left out of the palette
  (`keys/bindings.ts classicVerbs`) until PR 22 retires them.
- **Key presenters before the first draw** (the import's round trip): the key table's verbs do nothing
  (they did the classic window's), as cmd+shift+a does.
- **Strings**: the inline page's "Open in side panel" is "Open in a tab"; the file finder's hint and the
  skill setup's tooltip no longer name a panel.
- **e2e helpers**: `e2e/shell.ts` (seed a layout, open a thread's tab, a page's tab, find panes and tabs),
  `e2e/shell-terminals.ts`, `shell-surfaces.ts`, `shell-pages.ts`, `shell-threads.ts`;
  `fixtures.openProjects` selects the Projects index (it opens the space's Projects tab, an empty space
  too). `playwright.config.ts` takes `E2E_DIST` (two runs at once in one checkout). The panel specs'
  remaining behaviour is in `e2e/shell-tabs.spec.ts` and the bottom panel's in `e2e/terminal-tabs.spec.ts`.

## Verification

- `make check` green (vitest: 569 files, 11386 passed, 24 skipped: the vitest shell gaps below).
- `make gui-e2e`: 514 passed, 179 skipped: the 151 SHOTS-gated tests, as before, and the 28 `test.fixme`
  shell gaps below. No skip list. The first full run failed one test (lineage "cmd+shift+a and cmd+1..9
  walk the shown rows only"): cmd+shift+a pressed before the window's first draw did nothing, where the
  classic window's fallback used to act. Fixed at its cause (cmd+shift+a asks for the popup before the
  draw too; `openApp` waits for the first draw) with a unit test; 5 repeated runs pass.
- The design guards pass; there is no allow-list for removed files (the seam's guard went with the store).
- `make gui-build`. An end-to-end pass with `make drive DAEMON=dev` on a scratch home and a scratch git
  project under home (both removed after): two threads opened from the sidebar, the thread's diff beside
  it, a File tab from `view open file --focus` edited in the GUI and saved with cmd+S (the file on disk
  changed), a terminal tab from cmd+t running a command, the quick terminal from cmd+j (`terminal list`:
  the slot), the Pull Requests tab from a pane's "+" (no pull request: the scratch project has no GitHub
  repository), a tab dragged into the other pane, a second space and back with ctrl+cmd+1, a reload (the
  layout, the saved file and the terminal's output came back as they were; `layout show` agreed).

## Shell gaps found

Each is a test kept with its assertions and marked `test.fixme` (e2e) or `it.skip` (vitest) with a
`// Shell gap:` line. None is caused by this removal: the classic window hid them (it drew those paths)
or the shell never had them. The spec does not say they should stop.

### Focus and the keyboard
1. A surface opened from a page or a pane lands behind the active tab of the focused pane, unseen
   (`open_surface` with focus false; the daemon's `show` keeps the pane's active tab): a pull request
   from a Pull Requests row (prs "the list keeps focus while Enter opens a row …"), a workspace's View
   (workspace-page "a rooted workspace: View opens …"), the diff's Open file (file-tabs "Open file goes to
   the File tab …"), a revert's new pull request (vitest `PullRequestSurface`), a row's click on the
   Pull Requests page (vitest `PullRequestsPage`).
2. The file finder's Enter opens the file but the keyboard stays in the prompt (file-finder "cmd+p …").
3. Escape from the palette hands the keyboard back to a thread's prompt only: from a diff, a terminal tab
   or the quick terminal it lands nowhere (shell-tabs "the palette hands the keyboard back …",
   terminal-tabs "the palette returns to the bottom panel …").
4. `ui.focus.terminal` from outside shows the tab but not the keyboard (app "FocusTerminal intent …");
   a second press on a server row shows a hidden terminal tab without the keyboard (server-rollup
   "a second press …").
5. A quick terminal closed by its shell's exit takes the keyboard with it (terminal-tabs "cmd+j on a
   thread without shells …").
6. A terminal started under the usage sheet opens behind it, the sheet stays (usage-sheet "a terminal
   this window starts under it …").
7. A thread's model's item verb moves the user's view: the window's half sends `focus_tab`
   (thread-panel-items "a thread's model opens a file, a diff and a pull request …").
8. The row menu's Move to project… on a thread whose tab is not open loses its picker about half the
   time (move-no-project "the sidebar row's Move to project… …"); with the tab open it is reliable.

### The command context
9. A focused terminal tab is not the context's terminal (`activeTerminalId`): the palette offers no
   terminal command from it, a command started there carries no terminal, Find in Terminal is not
   listed (app "cmd+shift+p reaches the app from a focused shell …", "invoking a command sends the
   current context"; terminal-find "the palette's Find in Terminal …"; vitest
   `CommandPalette.commands`).
10. cmd+t from a worktree shell's tab starts a shell in home, not in that worktree (terminal-tabs "cmd+t
    from a Projects-page shell …").

### Surfaces in panes
11. A pane's body is not a scroll area: a long pull request is cut off (pr-panel "long conversations and
    timelines are virtualized …", pr-stale-first "the fetch landing behind a stale copy …").
12. Popups' collision boundary looks for `[data-region="panel"]`, which no pane has: menus overhang a
    pane (pr-panel "at 280px the surface's popups …", "at 280px the merge split button …";
    plugin-picker "a toolbar picker opens inside its pane …"); Escape from a pull request's Ask or Review
    composer drops the keyboard (vitest `PullRequestSurface`).
13. A surface's own keys (`SurfaceSpec.onKey`) are dispatched by nothing: cmd+shift+c in a pull request
    copies nothing (pr-panel "shift+cmd+c copies the link …").
14. An unlinked pull request tab loses its inner tab on any layout change (`prPanel` keys its state by
    `""`) (pr-panel "an unlinked pull request tab keeps its Code tab …").
15. A plugin surface linked to a thread follows the window's selection, not its thread (plugin-streams
    "a plugin surface linked to a thread keeps its view …").
16. An action run from the card opens no tab for its terminal (`action.run --terminal` places none, in the
    daemon too): the run cannot be seen (thread-info "an action run from the card …").
17. Run in terminal: the thread's timeline leaves its end when the terminal's pane narrows it
    (code-block-actions "Run in terminal: the thread's timeline stays at its end …").
18. A gutter takes no keyboard, arrow keys or double-click reset, which the side panel's edge and divider
    had (shell-tabs "a gutter takes the keyboard …").
19. No "Moving to …" while a move is in flight: only the classic crumb said it (move-no-project "while a
    move is in flight …").

### The host seam's tab identity (vitest only)
20. A tab's seam id is built from all its params (`hostShell.ts panelIdOf`), the surface's from its key
    params: an open Diff tab with a file or sources is not found and is reset (`filePanel` "an open tab
    keeps what it compares and shows"); a thread's diff call cannot find the user's own Diff tab and
    replaces its filter, folds and sources (six `threadPanelIntent` panel.diff tests); a pull request's id
    is lower case but the lookup uses the param's spelling (`prPanel`, `prLinks`: a link's anchor check
    never matches).
21. A thread's untitled diff is the same tab as the user's own (the daemon's identity is thread, project,
    worktree) (`threadPanelIntent` "framed with no title" and two more).
22. `behind` only works for an open tab: a new edit request opens in front of the editor the user types in
    (`threadPanelIntent` "a request joins the strip behind it").
23. New linked tabs go to the first pane holding the thread's tabs, not the focused one of them
    (`threadPanelIntent` "in another pane it opens as usual").
24. Reopening an open tab sends its params outside the ordered queue (`shellOpenTab`): a save landing
    first overwrites a newer request (`fileRequest` "a newer request whose tab update has not landed …").

Also seen, not tested: a provisional (italic) thread name shows plainly in its tab and header (the
classic title muted it; the sidebar row still does); the stale-plugin-environment dot went with the
classic title (the card and the menu's Restart Claude remain).

## Decisions

- **One PR, not two.** The removal leaves specs that import removed fixtures failing to load, so the
  removal and the rewrite land together; the commits are split (removal, tests, note).
- **`threadPanelIntent` stays** (rewritten on the seam) although its name says panel: without it an edit
  request loses its asker and id in the shell. PR 22 decides where that half goes when it retires the
  ShowView emission.
- **The thread steps (`thread.previous`/`next`) and cmd+1…9** follow the shell's sidebar order (Needs you
  first), the only order there is now (`keys/bindings.test.ts`).
- **Gaps are not fixed here**: this PR removes; each gap is a test that fails today, kept as `fixme`/`skip`
  with its reason, for PR 24 or the owner.
- **The shell's terminal and plugin node changes** (`showTerminal`, "Open in a tab") are ports of what the
  removed code did, not new features: the bottom panel those calls reached is gone.

## Gotchas

- `resetFakeLayout` waits for ops still in flight before resetting: an op of the previous test landing
  after the reset would apply the new snapshot twice and leave the slice empty.
- A `.tsx` test helper may export only components (fast refresh lint): `layoutTabs` lives in a `.ts`.
- e2e: after `resetMock` the space is empty, with no pane and no "+": open pages by selection (or seed a
  layout) before using a pane's "+".
- e2e: a verb run right after a sidebar click can reach the daemon before the thread's tab is open and land
  behind it; wait for the layout to hold the thread's tab (`shell-surfaces.ts threadTabOpen`).
- The mock does not close a thread's quick terminal when its shell goes, does no smart swap of terminal
  tabs, and always focuses a new terminal tab; the terminal specs work around each.

## For later PRs

- **PR 22**: retire `view.panel.toggle`, `.expand`, `.new-tab`, `.split`, `view.bottom.toggle` (the GUI's
  `classicVerbs` and the `showView` cases go with them), the ShowView emission and `threadPanelIntent`'s
  half (move what it adds to an edit request into the daemon's tab params), `appearance.panel_keep_open`,
  the daemon's "in its side panel" messages (`commands_view_inline.go`, `commands_capabilities.go`).
- **PR 23**: about 95 source files still say "side panel" or "bottom panel" in comments; the welcome
  tutorial's prompt says "in the side panel" (its wording is measured: change it with a run).
- **PR 24**: the gaps above; `SurfaceSpec.available`, `warm`, `openDefault`, `hotkey` look unused now (the
  surface list went); the e2e titles that still name the bottom or side panel (kept so the table maps).

## The 199 skipped tests

Every test `e2e/cutoverSkips.ts` listed, by its file and line before this PR: rewritten (where), deleted
(why), or a shell gap (above). Grouped as they were worked.


### Terminals (app, code-block-actions, font, server-rollup, terminal-find, plugin-owned, plugin-streams, bottom-panel, terminal-routing, layout)

Final specs run twice (`--repeat-each=2`, `CUTOVER_SKIPS=0`, ports 8721/9621, `dist-e2e-terminals`): 84 passed, 32 skipped (the 10 `test.fixme` gaps and the SHOTS tests, each ×2). `bun check -b` clean; oxlint clean on every file touched. Each fixme was also run as a real test once: all 10 fail as described.

New files: `e2e/shell-terminals.ts` (helpers), `e2e/terminal-tabs.spec.ts` (what was left of bottom-panel.spec and terminal-routing.spec). Deleted: `e2e/bottom-panel.spec.ts`, `e2e/terminal-routing.spec.ts`.

| spec:line | title | outcome |
| --- | --- | --- |
| app.spec.ts:8 | selecting a thread shows its conversation; switching watches the other one instead | rewritten (app.spec.ts, same title): s-1 then s-3 (s-2 is in Needs you, so its row opens the popup), the prompt focused, one WatchThread |
| app.spec.ts:25 | keystrokes are written to the attached terminal in order | rewritten (app.spec.ts, same title): s-1's quick terminal via cmd+j |
| app.spec.ts:43 | cmd+shift+p reaches the app from a focused shell, and the palette lists for that shell | split: rewritten "cmd+shift+p reaches the app from a focused terminal tab" (app.spec.ts) + **gap** (fixme, same title): the palette lists no terminal command for a focused terminal tab |
| app.spec.ts:52 | invoking a command sends the current context | split: rewritten "invoking a command sends the current context: a thread's" (app.spec.ts) + **gap** (fixme, same title): no activeTerminalId from a focused terminal tab |
| app.spec.ts:113 | FocusTerminal intent: a shell shows in its owner's bottom panel | split: rewritten "ui.focus.terminal: a worktree's shell opens as a tab in the focused pane, a thread's beside its thread" (app.spec.ts; the window ignores the intent, the CLI verb's layout commit shows the tab) + **gap** (fixme, same title): the keyboard does not go into it |
| app.spec.ts:129 | WebGL context loss falls back to the DOM renderer | rewritten (app.spec.ts, same title): on s-1's quick terminal |
| bottom-panel.spec.ts:56 | the header toggle and cmd+j show and hide a thread's bottom panel | rewritten as terminal-tabs.spec.ts "cmd+j shows and hides a thread's quick terminal, and the keyboard goes in and back to the prompt" (in, out to the prompt, back, keyboard-only move, the close button, 0 streams). The header toggle, its tooltip and the panel's geometry are gone |
| bottom-panel.spec.ts:105 | the palette returns to the bottom panel, and the panel is per thread | split: "per thread" rewritten as terminal-tabs.spec.ts "Toggle Quick Terminal from the palette starts the thread's own, with the keyboard in it; each thread keeps its own" + **gap** (fixme, same title, terminal-tabs.spec.ts): Escape from the palette does not return the keyboard to the terminal (tab or quick) |
| bottom-panel.spec.ts:130 | the toggle and "+" start shells for the thread, which open there focused | rewritten, merged with terminal-routing:27 into terminal-tabs.spec.ts "cmd+t on a thread starts a terminal tab linked to it, beside it, with the keyboard in it; cmd+t and the + menu there add more". Numbered names are vitest's (lib/terminalName.test.ts) |
| bottom-panel.spec.ts:162 | × and cmd+w close terminals through terminal.close; closing the last one hides the panel | rewritten: terminal-tabs.spec.ts "cmd+w in a terminal tab closes it and ends its terminal; the keyboard goes back to the thread's prompt" (cmd+w and ×; the terminal leaves the store; 0 streams) |
| bottom-panel.spec.ts:193 | the resize handle sizes one panel by keyboard and double-click, and the height persists | deleted: the bottom panel's handle and height are gone (the quick terminal's height is a pointer drag stored in the layout: shell/quickTerminal.test.ts) |
| bottom-panel.spec.ts:244 | no bottom panel on the composer, the Pull Requests page, or under an expanded side panel; it stays under the settings and usage sheets | rewritten (sheets part): terminal-tabs.spec.ts "a terminal tab stays attached under the settings and usage sheets". cmd+j on a tab with no thread doing nothing is shell/terminalActions.test.ts ("on a tab of no thread: nothing"); the expanded side panel is gone |
| bottom-panel.spec.ts:298 | only the active tab of the visible panel holds an Attach stream | deleted: covered by shell-terminal.spec.ts "xterm draws in a terminal tab; only the visible terminals hold an Attach stream" (tab switch keeps 1, quick adds 1, closing gives it back) and shell-rails.spec.ts "a folded pane holds no stream"; a hidden thread's quick terminal detaching is in the :364 rewrite. The strip's arrow keys are PaneTabStrip.test.tsx's |
| bottom-panel.spec.ts:334 | a shell this window did not start does not take the keyboard from the bottom panel | rewritten: terminal-tabs.spec.ts "a shell this window did not start does not take the keyboard from the terminal being typed in" (TerminalService.Create + LayoutService.Apply open_surface focus:false, as the daemon opens a model's terminal.new) |
| bottom-panel.spec.ts:350 | expanding the side panel from the bottom panel moves the keyboard to the side panel | deleted: the side panel's expand and the bottom panel are gone |
| bottom-panel.spec.ts:364 | switching between two threads with open panels keeps one bottom stream | rewritten: terminal-tabs.spec.ts "switching between two threads with open quick terminals keeps one Attach stream, and the prompt takes the keyboard" (smart swap of terminal tabs would be the closer case, but the mock does not port smart swap) |
| bottom-panel.spec.ts:385 | the resize handle is part of the panel: cmd+j from it hides the panel | deleted: the panel's focusable handle is gone (the quick terminal's is a pointer-only separator); cmd+j from the quick terminal is in the :56 rewrite |
| bottom-panel.spec.ts:399 | cmd+j on a thread without shells starts one with the keyboard in it; its exit hands the keyboard back; the next cmd+j starts a fresh one | split: rewritten terminal-tabs.spec.ts "cmd+j on a thread without a quick terminal starts one with the keyboard in it; after its shell exits, the next cmd+j starts a fresh one" + **gap** (fixme, same title): the keyboard is not handed back to the prompt |
| bottom-panel.spec.ts:423 | a daemon restart that pruned the shells leaves the panel closed; cmd+j starts a fresh one | rewritten: terminal-tabs.spec.ts "a daemon restart that pruned the shells leaves the quick terminal closed; cmd+j starts a fresh one" (the daemon's start sweep is applied by the test: see notes) |
| bottom-panel.spec.ts:446 | when terminal.new fails, cmd+w on the empty state hands the keyboard to the content pane; its button's shell takes it | deleted: the bottom panel's empty state and its button are gone; a refused terminal.new opens no tab |
| code-block-actions.spec.ts:45 | Run in terminal: hidden while the block streams, then a new shell in the thread's panel runs the command | split: rewritten "Run in terminal: hidden while the block streams, then a new terminal tab linked to the thread runs the command" (code-block-actions.spec.ts) + **gap** fixme "Run in terminal: the thread's timeline stays at its end when the terminal opens beside it" |
| font.spec.ts:10 | the bundled Nerd Font is served, loaded before the terminal opens, and is the terminal's font | rewritten (font.spec.ts, same title): s-1's quick terminal |
| layout.spec.ts:88 | the app name and the history buttons fit whole at the minimum sidebar width, zoomed in and out | deleted: both moved to the top bar, laid out across the window on its own (shell-model.md, Structure), so the sidebar's width no longer squeezes them; the bar is shell-spaces.spec.ts's and TopBar.test.tsx's |
| layout.spec.ts:106 | the sidebar band holds the empty traffic-light gutter, the app name and the history buttons, and drags the window | deleted: the band is gone; the top bar (gutter, app name, history, drag and no-drag) is shell-spaces.spec.ts "the top bar drags the window, and its controls still take clicks" and TopBar.test.tsx |
| layout.spec.ts:171 | the history buttons step through selections, float their tooltips down and clear the resize handle | deleted: selection history is gone; back/forward through focus is shell-spaces.spec.ts "back and forward go through the focus across panes and spaces" |
| layout.spec.ts:199 | the panes start a shell gap (12px) from the top and their 44px headers drag the window, with the sidebar shown and hidden | deleted: the classic content pane, its header, crumb and the side panel are gone; the strip not dragging and the top bar dragging are shell-spaces.spec.ts's |
| layout.spec.ts:259 | every page header is 44px, ends on the band and drags; its controls do not | deleted: the pages are tabs under the top bar, which is the window's drag band (shell-spaces.spec.ts); no page header ends on a band |
| layout.spec.ts:294 | the headerless composer (home and a project's) drags the window from the same 44px band | deleted: the composer is a tab; the window drags by the top bar (shell-spaces.spec.ts) |
| layout.spec.ts:311 | the daemon status sits at the bottom of the sidebar, its glyphs on the pane's bottom edge | rewritten (layout.spec.ts, same title): against a shell pane's bottom edge |
| layout.spec.ts:334 | sidebar sits on the sheet and the bottom panel's terminal matches its pane | rewritten: layout.spec.ts "sidebar sits on the sheet and a terminal tab's terminal matches its pane" |
| plugin-owned.spec.ts:49 | the Shell tab attaches the plugin's terminal; Open in bottom panel moves it to a bottom tab | rewritten: plugin-owned.spec.ts "the Shell tab attaches the plugin's terminal; Open in a tab moves it to a terminal tab" (plugin-terminal-open-tab, then the tab moved beside the surface so plugin-terminal-in-tab shows; closing the tab reattaches the node) |
| plugin-streams.spec.ts:51 | a shell in the bottom panel adds a stream and takes none from a node | rewritten: plugin-streams.spec.ts "a terminal tab beside the nodes adds a stream and takes none from a node"; found a **gap** on the way: fixme "a plugin surface linked to a thread keeps its view while an unlinked tab has the focus" |
| plugin-streams.spec.ts:94 | a wall holds a stream for what is on screen: never more at first, and scrolling swaps them | rewritten (plugin-streams.spec.ts, same title): the surface's pane full screen instead of the expanded panel; the peak counts live nodes inside the surface (full screen floats the thread's composer, which is live too) |
| server-rollup.spec.ts:37 | a child's terminal opens in the parent's panel with the keyboard in it, on one Attach stream | split: rewritten "a child's terminal opens in a tab with the keyboard in it, on one Attach stream" (server-rollup.spec.ts; a second press shows the same tab on one stream) + **gap** fixme "a second press on the row shows the child's terminal tab again with the keyboard in it". The classic's "Hide" (× keeps the run) is gone: closing a terminal tab ends it |
| terminal-find.spec.ts:103 | the bar floats at the terminal's top right, over it and inside it | rewritten (same title): a terminal tab from cmd+t on s-3 |
| terminal-find.spec.ts:114 | the current match is outlined in the theme's warning colour, in WebGL and the DOM fallback, and follows a theme change | rewritten (same title): terminal tab |
| terminal-find.spec.ts:143 | a tab's query is its own and nothing crosses a tab switch | rewritten (same title): two terminal tabs of s-3 in one pane |
| terminal-find.spec.ts:175 | the count follows new output, and a reattach counts the snapshot once | rewritten (same title): terminal tab |
| terminal-find.spec.ts:194 | hiding the panel ends the stream and keeps the query; it comes back highlighted, the keyboard left in the terminal | rewritten (same title): on the quick terminal, hidden and shown by cmd+j |
| terminal-find.spec.ts:210 | closing the tab takes its find with it | rewritten (same title): cmd+w from the terminal (a text field yields no cmd+w, shell-20-cutover.md Keys) |
| terminal-find.spec.ts:223 | it works on an exited terminal | rewritten (same title): terminal tab |
| terminal-find.spec.ts:239 | the palette's Find in Terminal lands in the bar | **gap** (fixme, same title): terminal.find needs activeTerminalId, which a focused terminal tab does not give |
| terminal-find.spec.ts:248 | in the alternate screen it sees the screen; back out, the scrollback | rewritten (same title): terminal tab |
| terminal-find.spec.ts:284 | Ctrl-C reaches the prompt within seconds of a flood with the bar open on a word on every line | rewritten (same title): terminal tab |
| terminal-find.spec.ts:48 | cmd+f takes the keyboard from xterm; what is typed stays out of the PTY; Escape gives it back | rewritten (same title): terminal tab |
| terminal-find.spec.ts:68 | cmd+f follows the keyboard: the thread's in its prompt, the terminal's in the terminal | rewritten (same title): thread and its terminal tab side by side |
| terminal-find.spec.ts:82 | from xterm with the bar open, cmd+f selects the query and cmd+g steps without taking the keyboard | rewritten (same title): terminal tab |
| terminal-routing.spec.ts:27 | cmd+t on a thread starts its shell in the bottom panel, with the keyboard in it | rewritten, merged into terminal-tabs.spec.ts "cmd+t on a thread starts a terminal tab linked to it, beside it, …" (context, keyboard, no sidebar row, no toast) |
| terminal-routing.spec.ts:42 | cmd+t from a Projects-page shell starts another in its worktree | **gap** (fixme, same title, terminal-tabs.spec.ts): from a worktree shell's tab cmd+t runs terminal.new-free (home), not terminal.new in that worktree |

Also: terminal-routing.spec.ts's SHOTS test (row menu "New terminal here", the project page's menu, the bottom panel) deleted with the file; terminal-find's, server-rollup's and code-block-actions' SHOTS paths now go through the rewritten helpers.

Counts: 49 listed tests. Rewritten 36 (7 of them with a gap part split out as a fixme), deleted 11, gap only 2 (terminal-find :239, terminal-routing :42). Gaps in all: 10 fixmes (the 7 split parts, the 2 gap-only tests, and one found while rewriting plugin-streams :51).

### Surfaces (diff, files, gallery, inline pages, MCP, plugins, thread info, welcome, sheets, panel specs)

Every listed test, by its line before the rewrite. "Pane width" below means the side panel's width
became the width of the pane the surface sits in, set by a seeded split's sizes
(`e2e/shell-surfaces.ts` `setPaneSize` / `setSurfaceWidth`, a re-seed of the mock's layout) or by a
real gutter drag (`dragGutterBeside`); "expand" became the pane's full screen (`fullScreenSurface`)
only where the test reads the surface at full width.

| spec:line | title | result |
| --- | --- | --- |
| diff-viewer.spec.ts:29 | the list follows the panel's own width, not the window's, and keeps the file on screen | rewritten: diff-viewer.spec.ts "the list follows its pane's own width, not the window's, and keeps the file on screen" (thread + diff seeded side by side, the diff's pane sized 760/480) |
| diff-viewer.spec.ts:133 | the Commits toggle stays in reach at every height, rail | rewritten: same title (pane width; `openDiff` seeds the layout) |
| diff-viewer.spec.ts:169 | a long subject leaves the diff in reach, and the band keeps its share of a short tab | rewritten: same title |
| diff-viewer.spec.ts:281 | the list on top comes back on the current row, not at the top | rewritten: same title |
| diff-viewer.spec.ts:314 | the list on top leaves the code readable: 1280x800, alone | rewritten: same title; code threshold rebased 400 → 320 (the pane's Diff tab is 654px there, the top bar and strip take more than the panel header did) |
| diff-viewer.spec.ts:314 | the list on top leaves the code readable: 1280x800, a stacked split | rewritten: same title; the diff in a pane over the Pull Requests page (a seeded column), threshold 200 → 140 (tab 282px) |
| diff-viewer.spec.ts:314 | the list on top leaves the code readable: 1024x640, a stacked split | rewritten: same title; the diff's pane 360 wide (the thread's pane keeps its 360 minimum), threshold 130 → 70 (tab 202px) |
| diff-viewer.spec.ts:314 | the list on top leaves the code readable: 1920x1080, a stacked split | rewritten: same title, threshold unchanged (180) |
| file-edit.spec.ts:79 | with the caret in the editor, its chords are its own and typing fires no shortcut | rewritten: same title; strip read from the diff's pane; cmd+j now opens the thread's quick terminal (terminal.quick from a linked surface) |
| file-edit.spec.ts:174 | contents leave the library: on leaving a saved tab, on Discard, on the pencil, on closing | rewritten: same title (the linked pane's strip) |
| file-edit.spec.ts:209 | cmd+S saves the editor with the keyboard, not the focused group's tab, and never a hidden draft | rewritten: file-edit.spec.ts "cmd+S saves the editor with the keyboard, not the focused pane's tab, and never a hidden draft" (a.txt and b.txt seeded in two panes; layout `focusPane` gives b's pane the focus with the keyboard in a's editor; b's tab hidden behind the diff) |
| file-edit.spec.ts:284 | a draft survives leaving the tab, and a long file edits through the virtualizer | rewritten: same title |
| file-finder.spec.ts:27 | cmd+p from a thread's prompt opens the finder; Enter opens the file in the shut side panel; ⌥⏎ tags it in the prompt | gap: `test.fixme` "cmd+p from a thread's prompt opens the finder; Enter opens the file in a tab beside the thread; ⌥⏎ tags it in the prompt" (the keyboard stays in the prompt after Enter); the rest kept passing in "… Enter opens the file in a tab beside the thread, shown; ⌥⏎ tags it in the prompt" |
| file-request.spec.ts:90 | a request for another file leaves the document under the user's fingers | rewritten: same title (the File tabs' pane strip) |
| file-tabs.spec.ts:41 | a row shows its file in the tab, and @pierre/diffs draws its lines | rewritten: same title (thread opened by its row, its diff linked beside it) |
| file-tabs.spec.ts:55 | Open file goes to the File tab: a markdown image decodes; Source marks the first change in the code view | gap: `test.fixme` same title (Open file adds the File tab behind the diff); decoding and the Source mark kept passing in "Open file's File tab: a markdown image decodes; Source marks the first change in the code view" (the tab clicked) |
| file-tabs.spec.ts:69 | a TypeScript file at a line scrolls to it; the HTML sandbox runs its page; an image decodes | rewritten: same title; `openFile` presses the thread's tab first (a path chip is in the conversation, so the thread's pane has the focus) |
| file-tabs.spec.ts:107 | a PDF shows its pages; a 1.5 MB image comes back whole | rewritten: same title |
| gallery.spec.ts:50 | it fits a narrow panel in two columns and takes more as the panel grows | rewritten: gallery.spec.ts "it fits a narrow pane in two columns and takes more as the pane grows" (pane width 360 → 720) |
| inline-html.spec.ts:68 | expand shows the page over the thread pane's body only; the sidebar and side panel stay usable; Close has focus; Esc closes it | rewritten: inline-html.spec.ts "expand shows the page over the thread pane's body only; the sidebar and the pane beside stay usable; Close has focus; Esc closes it" (the page's File tab beside the thread instead of the side panel) |
| inline-html.spec.ts:135 | the open page is kept per thread: the sidebar works while it is up, and its page loads again on return | rewritten: same title; the other thread is s-1 (Active), not the first row (a Needs-you row opens its popup) |
| mcp-panel.spec.ts:51 | the palette's Show MCP Servers opens the MCP tab in the thread's panel | rewritten: mcp-panel.spec.ts "the palette's Show MCP Servers opens the MCP tab beside the thread" |
| mcp-panel.spec.ts:68 | the CLI's view.panel.mcp opens it; a tool's hint icons show their tooltips on hover | rewritten: same title |
| mcp-panel.spec.ts:165 | long names truncate: the status pill stays in the card and the panel never scrolls sideways | rewritten: mcp-panel.spec.ts "long names truncate: the status pill stays in the card and the pane never scrolls sideways" (the pane body and the surface) |
| page-verbs-panel.spec.ts:27 | view.panel.page opens the page in the thread's side panel with its bridge, and adds no card | rewritten: page-verbs-panel.spec.ts "view.panel.page opens the page in a tab beside the thread with its bridge, and adds no card" |
| panel-split-drag.spec.ts:82 | dropping a tab on the band splits the panel with it in the second group: … | deleted: shell-drag.spec.ts "a tab dropped on a pane's edge splits it, into the rectangle the preview showed" |
| panel-split-drag.spec.ts:132 | the band's edge follows the threshold, and an expanded panel's real width: … | deleted: no band or threshold; edge zones are src/shell/drag/targets.test.ts, the drop preview drop.test.ts |
| panel-split-drag.spec.ts:161 | a single-tab panel shows no band; a drop on the body outside the band, or Escape, puts the tab back | deleted: shell-drag.spec.ts "Escape cancels a drag: nothing moves and nothing is sent" |
| panel-split-drag.spec.ts:191 | a tab dragged onto the other strip lands at the slot under the pointer; within a strip it still reorders; alt+arrows stay in the group | deleted: shell-drag.spec.ts "an inactive tab drags into another pane's strip, at the place the bar shows" and "a tab reorders in its own strip…"; alt+arrow tab moves do not exist in the shell |
| panel-split-drag.spec.ts:234 | a drop on the other group's body appends the tab there, tinting it while over; moving a group's last tab out collapses the split | deleted: a drop on a pane's middle is src/shell/drag/drop.test.ts ("a tab onto another pane" → tab.move; its preview the whole pane), the preview over a body shell-drag.spec.ts (iframe/terminal tests); a pane closing with its last tab: shell-drag.spec.ts edge split (p-3 gone) |
| panel-split-drag.spec.ts:263 | a drag over the other group's HTML render keeps moving and drops on that body (…) | deleted: shell-drag.spec.ts "a drag over an iframe's body keeps tracking the pointer" (drops and stores) |
| panel-split.spec.ts:86 | view.panel.split from the palette splits a stacked panel; … | deleted: the panel split and its verb are gone; panes split by a drop on an edge (shell-drag.spec.ts) |
| panel-split.spec.ts:178 | cmd+\ joins and splits again; the CLI's view.panel.split does too | deleted: cmd+\ retired (shell-model.md Keys; TestRetiredChords) |
| panel-split.spec.ts:204 | the orientation flips when the panel's resize drag ends, not during it | deleted: no orientation; the pane tree only scales (shell-grid.spec.ts, geometry/rects.test.ts) |
| panel-split.spec.ts:234 | dragging the divider sets the persisted ratio, within each group's minimum; keys move it; a double-click resets it | drag deleted: shell-grid.spec.ts "a gutter drag resizes the panes beside it, keeps the tiling, and is stored", minimums src/shell/resize.test.ts; keys/double-click → gap: shell-tabs.spec.ts `test.fixme` "a gutter takes the keyboard and its arrow keys move it" |
| panel-split.spec.ts:305 | cmd+\ splits a one-tab panel onto a focused list; cmd+alt+\ moves between groups; cmd+w on an empty group collapses the split | deleted: cmd+\ and cmd+alt+\ retired (shell-model.md Keys); a pane closes with its last tab (shell-tabs.spec.ts cmd+w test) |
| panel.spec.ts:77 | the header toggle shows the empty surface list and hides the panel again | deleted: no side panel or toggle; the surfaces are the "+" menu's (shell-linked.spec.ts, linkedTabs.test.tsx) |
| panel.spec.ts:124 | dragging the handle resizes the panel within its bounds, and the width persists | deleted: shell-grid.spec.ts gutter drag (stored), resize.test.ts (minimums); its keys/double-click: the gutter gap above |
| panel.spec.ts:202 | cmd+shift+e toggles the panel, even from the thread's prompt, and the daemon intent does too | deleted: cmd+shift+e retired (shell-model.md Keys; TestRetiredChords) |
| panel.spec.ts:231 | under the settings sheet the chord and the CLI still toggle the panel; the keyboard stays in the sheet | deleted: the chord and the panel are gone (panes under a sheet: usage-sheet.spec.ts "the panes stay laid out under it") |
| panel.spec.ts:258 | cmd+w in the focused empty panel is handled and hides the panel | rewritten: shell-tabs.spec.ts "cmd+w on a pane's last tab is handled and closes the pane; the keyboard goes back to the Pull Requests list" |
| panel.spec.ts:273 | the header drags the window from the strip's empty space, never from a tab or its × | deleted: the strip's free space drags the pane now (shell-linked.spec.ts "the + is not the pane's drag grip…"), the window drags by the top bar (shell-spaces.spec.ts "the top bar drags the window…") |
| panel.spec.ts:287 | tabs are keyboard reachable: arrows move, Enter activates, Tab reaches the × | rewritten: shell-tabs.spec.ts "tabs are keyboard reachable: arrows move, Enter and Space activate, Tab reaches the ×" |
| panel.spec.ts:311 | dragging starts from the rendered width after the room shrinks | deleted: a gutter drag starts from the drawn frame (src/shell/resize.ts startDrag, resize.test.ts) |
| panel.spec.ts:327 | the palette hands focus back to the panel, and its toggle moves focus | gap: shell-tabs.spec.ts `test.fixme` "the palette hands the keyboard back to the pane it was opened from"; the toggle half deleted (no panel) |
| panel.spec.ts:355 | closing the last tab on the Pull Requests page focuses the page's list | rewritten: shell-tabs.spec.ts "cmd+w on a pane's last tab is handled and closes the pane; the keyboard goes back to the Pull Requests list" |
| panel.spec.ts:384 | expand fills the content area, keeps the thread mounted, and restores the split | deleted: shell-fullscreen.spec.ts "cmd+shift+enter shows the pane over the whole grid, the others unmounted; …" (the spec unmounts the others) |
| panel.spec.ts:450 | expanded is per panel, survives a reload, and outlives hiding the panel | deleted: no per-panel expand; full screen is one pane's (shell-fullscreen.spec.ts, shell/fullscreen.test.ts) |
| panel.spec.ts:493 | view.panel.expand from the palette and the CLI; focus follows the hidden thread | deleted: the verb went with the panel; full screen is cmd+shift+enter (shell-fullscreen.spec.ts) |
| panel.spec.ts:540 | cmd+w while picking from the + only goes back, handled | deleted: no picking state; "+" is a menu (shell-linked.spec.ts) |
| panel.spec.ts:564 | view.panel.new-tab from the palette shows a hidden panel picking, with the keyboard | deleted: the verb went with the panel; the "+" menu from the keyboard: shell-linked.spec.ts |
| panel.spec.ts:602 | dragging a tab onto its neighbour reorders the strip without activating it; the order survives a reload | deleted: shell-drag.spec.ts "a tab reorders in its own strip…" (the order is the daemon's stored layout) |
| panel.spec.ts:638 | dropping a tab on the + puts it last, …; Escape mid-drag cancels, even while picking | deleted: shell-drag.spec.ts reorder and "Escape cancels a drag…" |
| panel.spec.ts:673 | the drop settle leaves no transform or animation behind, and a tab picked up again mid-settle follows the pointer | deleted: the shell drags a ghost, tabs never transform (shell-drag.spec.ts, ShellDnd) |
| panel.spec.ts:715 | dragging a tab to the strip's edge scrolls the strip …; alt+Right past the edge scrolls too | deleted: a shell strip never scrolls, tight tabs go icon-only (geometry/tabFit.test.ts, PaneTabStrip.test.tsx "tight, tabs go icon-only…"); no alt+arrow moves |
| plugin-menu.spec.ts:70 | a narrow row folds its buttons into the ⋯; a pick in the Priority submenu comes back checked; widening shows the buttons | rewritten: same title (pane 420 → 920 at 1680 wide) |
| plugin-picker.spec.ts:34 | a toolbar picker opens inside the panel, searches the plugin and filters the runs | gap: `test.fixme` "a toolbar picker opens inside its pane, searches the plugin and filters the runs" (the popover is bounded by the window, overhangs its pane) |
| plugin-stats-bars.spec.ts:36 | stats wrap to two by two in the side panel and one row expanded, figures on one line | rewritten: plugin-stats-bars.spec.ts "stats wrap to two by two in a narrow pane and one row full screen, figures on one line" |
| plugin-table-meter.spec.ts:46 | in the side panel the tracks share the cell with the label slot and line up, and every label fits uncut | rewritten: plugin-table-meter.spec.ts "in a pane the side panel's width the tracks share the cell…" (pane 420) |
| plugin-table-meter.spec.ts:67 | at the narrowest panel the labels go and each track takes its whole cell | rewritten: plugin-table-meter.spec.ts "at the narrowest pane the labels go and each track takes its whole cell" (300, a plugin pane's minimum; the panel's was 280) |
| plugin-table.spec.ts:39 | the panel's width drops columns without overflow; expanded, every column and the buttons; … | rewritten: plugin-table.spec.ts "a narrow pane drops columns without overflow; full screen, every column and the buttons; the header lines up with the cells" |
| plugins-layout-fuzz.spec.ts:63 | a long list in a wide master-detail's detail renders as the detail side scrolls | rewritten: same title (real gutter drag) |
| plugins-layout-fuzz.spec.ts:180 | tab switching mid-act and resize thrash end on the plugin's tab with its drafts | rewritten: same title (8 real gutter drags) |
| plugins-layout-fuzz.spec.ts:238 | a fill pane in the second of stacked columns follows its top when the columns go side by side | rewritten: same title (pane 420, then a gutter drag) |
| plugins-layout-fuzz.spec.ts:378 | live-7: a wide master-detail's side at its end hands the wheel on to the body | rewritten: same title (gutter drag) |
| plugins.spec.ts:34 | Settings → Plugins: a plugin's surface opened from its row closes Settings and shows live in the panel | rewritten: plugins.spec.ts "… closes Settings and shows live beside the thread" |
| plugins.spec.ts:50 | the layout tab: columns stack in the panel and sit side by side once it is wide enough; … | rewritten: plugins.spec.ts "the layout tab: columns stack in a narrow pane and sit side by side once it is wide enough; collapse first adds the thread there" |
| plugins.spec.ts:104 | the layout tab's toolbar and footer stay pinned while the body scrolls between them | rewritten: same title (the pane's body for the panel's) |
| plugins.spec.ts:140 | the layout tab: the grid stacks in the panel and goes to columns as it widens; … | rewritten: plugins.spec.ts "the layout tab: the grid stacks in a narrow pane and goes to columns as it widens; dividers, inline groups and a flex spacer" |
| plugins.spec.ts:216 | the runs tab: the back button and the row take the keyboard; the log pane's height; side by side when wide | rewritten: same title |
| theme-editor-fuzz.spec.ts:74 | 2: with the side panel open on a thread, the Themes page still fits at 900px | rewritten: theme-editor-fuzz.spec.ts "2: with a thread and a pane beside it, the Themes page still fits at 900px" |
| thread-info.spec.ts:30 | one project: the toggle, the usage card's lines, an open fold's background, the card stepping aside for the panel, a reload | rewritten: thread-info.spec.ts "… the card stepping aside for a pane beside, a reload" (Changes opens the diff beside; closing its tab brings the card back) |
| thread-info.spec.ts:122 | split rows: a click runs the row, the ellipsis opens its menu under the row; … | rewritten: same title (2200 wide so the card stays inline once Open in › Terminal opens a terminal tab; that tab asserted); the action run's tab → gap: `test.fixme` "an action run from the card shows its terminal as a tab beside the thread, with the keyboard in it" |
| usage-sheet.spec.ts:127 | the side and bottom panels stay laid out under it | rewritten: usage-sheet.spec.ts "the panes stay laid out under it" (thread + diff + quick terminal); the cmd+t half → gap: `test.fixme` "a terminal this window starts under it takes the keyboard: the sheet closes" |
| welcome-page.spec.ts:26 | the welcome page in the panel: steps, a sent bubble, Add a project, the board, a reload on write | rewritten: welcome-page.spec.ts "the welcome page beside its thread: steps, a sent bubble, Add a project, the board, a reload on write" |

Counts: 75 listed tests (the 1280x800/1024x640/1920x1080 variants counted apart). Rewritten 45,
deleted 26, gaps 4 (file-finder:27, file-tabs:55, panel:327, plugin-picker:34). Three more gaps
came out of rewritten or deleted tests (the gutter's keys from panel-split:234, the action run's
tab from thread-info:122, cmd+t under a sheet from usage-sheet:127): 7 `test.fixme` in all.
file-finder:27 and file-tabs:55 also keep a passing sibling for what still works.

### Pull Requests and Projects pages

How they are reached now: the pages are seeded as tabs (`e2e/shell-pages.ts`: `openPrsTab`,
`openProjectsTab`), and a pull request is a tab of its own seeded beside the Pull Requests page
(`openPrBesidePage`) or beside its thread as a linked tab (`openPrBesideThread`). "At 280/360/420/560px"
is the pull request's pane sized with `sizePane` (layout `set_sizes`, as a gutter drag sends), or the
window resized for the single-pane page tests.

| spec:line | title | result |
| --- | --- | --- |
| pr-code.spec.ts:64 | the Code tab lists the files and renders the diff; split, file rows scroll, hunks expand | rewritten (same test; #145 in a tab beside the Pull Requests page) |
| pr-open-instant.spec.ts:34 | a pointer resting on a row reads its detail once; a sweep across the table reads at most the row it ends on | rewritten (same test; the page as a tab) |
| pr-panel.spec.ts:132 | the readiness box fits at 360, 420 and 560px in every state … | rewritten (same test; the PR's pane sized to each width, each PR opened in that pane and its tab focused) |
| pr-panel.spec.ts:146 | the Code tab's compact box: headline and footer on one line … the diff keeps the height | rewritten (same test; #145 as s-3's linked tab, since an unlinked tab loses its Code tab on a resize, gap 5; "the diff has most of the panel" measured against the pane, not the 800px window) |
| pr-panel.spec.ts:169 | Timeline at the default 420px … | rewritten (same test; pane at 420px) |
| pr-panel.spec.ts:224 | shift+cmd+c copies the link while the panel has focus | gap (test.fixme, same title): nothing in the shell dispatches `SurfaceSpec.onKey` |
| pr-panel.spec.ts:311 | panel state is per selection; a thread or worktree on a PR branch enables the surface | deleted: the side panel per selection is gone; which pull requests a thread's + submenu offers is `src/components/shell/linkedTabs.test.tsx` ("lists a diff per checkout and every linked pull request") |
| pr-panel.spec.ts:353 | cmd+w from inside the surface closes its tab; the last tab gone, the panel hides | rewritten (same title): cmd+w from the surface closes its tab, its pane goes, the page's pane takes the grid |
| pr-panel.spec.ts:362 | at 280px nothing overflows: header, readiness box, inner tab bar, logins, popups; the active tab is revealed | rewritten (same title) for header, box, inner bar, logins, Timeline; the popups and the Review composer moved to the new fixme test "at 280px the surface's popups stay inside its pane: …" (gap 3); the strip-reveal part deleted (a pane's strip fits tabs, icon-only when tight: `PaneTabStrip.test.tsx`) |
| pr-panel.spec.ts:424 | long conversations and timelines are virtualized in the panel's scroll | gap (test.fixme, same title): a panel surface does not scroll in a pane (gap 4) |
| pr-panel.spec.ts:467 | Explain this PR selects the new thread (the daemon's FocusThread), and the PR tab stays … | rewritten (same title): the new thread's tab opens and its row is selected; the PR tab stays, back on it #145 with the menu closed |
| pr-panel.spec.ts:492 | Ask from a thread's panel selects the new thread; back on that thread its panel keeps #145 without the composer | rewritten (same title): s-1 with #145 as its linked tab; pr.ask carries s-1's worktree; back on s-1 and its PR tab, no composer |
| pr-panel.spec.ts:528 | choosing Ask again with the composer open focuses it; the menu reopened right after Ask stays open | rewritten (same test; #145 tab) |
| pr-panel.spec.ts:565 | at 280px the composer's hint fits and its field grows, then scrolls | rewritten (same test; pane at 280px) |
| pr-panel.spec.ts:597 | #142 merges from a menu inside the side panel; the dashboard moves it to recently merged | rewritten (same title; menu inside the pane, the page beside it moves the row) |
| pr-panel.spec.ts:615 | at 280px the merge split button stays inside the box and its dropdown inside the panel | gap (test.fixme, same title): the dropdown runs past the pane (gap 3) |
| pr-panel.spec.ts:636 | Review on #139 sits left of Auto-merge in the box's footer; its menu stays inside the panel | rewritten (same title; menu inside the pane at its default width) |
| pr-stale-first.spec.ts:25 | the fetch landing behind a stale copy leaves the panel where it was scrolled | gap (test.fixme, same title): the surface never scrolls in a pane (gap 4) |
| pr-tasks.spec.ts:27 | the box hangs in the gutter, rings on hover, and a tick comes back from the daemon | rewritten (same test; #145 tab; "read again" is a reload) |
| projects.spec.ts:135 | narrow: with the Diff tab open, Sync and the slug drop and Open in Finder shows its icon only | rewritten (same title): the page with the checkout's Diff tab seeded in a pane beside it is compact; closing the Diff tab (its pane goes) gives the room back. Show changes itself lands behind the page (gap 1) |
| projects.spec.ts:161 | Details' Open in Finder: two blocks with a 2px seam … | rewritten (same test; the Projects tab) |
| projects.spec.ts:193 | each page has its own side panel; the sidebar row reopens the last page and goes to the index from one | deleted (per-page side panel, the sidebar row, selection history walking pages); what is left rewritten as "the Projects tab keeps its page across a reload; the + menu focuses the space's one tab" |
| projects.spec.ts:232 | a page's scroll position is remembered while the window lives | rewritten (same test; the Projects tab) |
| projects.spec.ts:262 | Worktrees without threads: at the width Show diff leaves, the reason truncates … Resume … | rewritten (same title): the Diff tab seeded beside the page with the page's pane at 520px (Show diff itself: gap 1); Resume opens the thread's tab in the focused pane |
| projects.spec.ts:41 | narrowing drops Activity, then Updated, then Default branch; Needs a look stays | rewritten (same test; the Projects tab) |
| projects.spec.ts:76 | keyboard: a project page's list has the keyboard; Shift+F10 opens the cursor row's menu, Escape returns | rewritten (same test; the Projects tab) |
| projects.spec.ts:93 | … bright with its submenu open | rewritten (same test; the Projects tab) |
| prs.spec.ts:106 | beside the side panel, the tables drop columns instead of running past their right edge | rewritten (same title): the page's pane narrowed to 600px by the window |
| prs.spec.ts:127 | a capped project list arrives over the gh stream with its footer | rewritten (same test; the page as a tab) |
| prs.spec.ts:136 | activity charts share the hovered month; one tooltip, in the card under the pointer | rewritten (same test; the page as a tab) |
| prs.spec.ts:161 | the list keeps focus while Enter opens a row in the side panel | gap (test.fixme, same title): Enter opens #139's tab behind the page; nothing visible changes (gap 1) |
| prs.spec.ts:173 | cmd+shift+d runs view.pullrequests and the ShowView intent switches the page | rewritten as "the palette runs view.pullrequests and the ShowView intent shows the page's tab" (cmd+shift+d is the thread's diff now, per the spec's key table; that part deleted) |
| prs.spec.ts:26 | End and Home bring a virtualized list's cursor row into view | rewritten (same test; the page as a tab) |
| prs.spec.ts:70 | the five cards sit in one row under the half-height charts, and wrap beside the side panel | rewritten (same title): wide, then the page's pane narrowed to 600px by the window |
| workspace-page.spec.ts:30 | a rooted workspace: View opens the root's instructions as a File tab in the page's own panel | gap (test.fixme, same title): the File tab opens behind the page (gap 1) |
| workspace-page.spec.ts:41 | a member's actions (Start here) are hidden at rest and shown on hover | rewritten (same test; the Projects tab) |
| workspace-page.spec.ts:62 | … block at full height, its submenu on hover there, a click on its text reveals | rewritten (same test; the Projects tab) |

Counts: 37 listed. Rewritten 30 (one, projects:193, mostly deleted with its remainder rewritten; one, pr-panel:362, partly moved to a new fixme), deleted 1 (pr-panel:311), gap 6 of the listed (pr-panel:224, :424, :615, pr-stale-first:25, prs:161, workspace-page:30), plus 2 new fixme tests (pr-panel: unlinked tab's Code tab across a resize; 280px popups and Review composer).

SHOTS-only tests in these files were moved to the same seeded tabs; all run green with SHOTS set. "reviewer picker (screenshots)" was already broken before this PR (it looked for a reviewer by text; reviewers are avatars): it now finds it by `data-login`.

### Threads, the sidebar, the header, drafts

All 18 spec files of the group run green twice in full with `CUTOVER_SKIPS=0` (74 passed, 23 skipped:
SHOTS-only tests and the 3 `test.fixme`), and once with `SHOTS=<dir>` (100 passed, 3 skipped: the fixmes).
`bun check -b` clean; oxlint `--type-aware --deny-warnings` clean on every file touched.
Line numbers below are the old ones (the list's).

| spec:line | title | outcome |
| --- | --- | --- |
| compose.spec.ts:201 | the draft survives switching away; Esc on an empty draft shows the project | rewritten (compose.spec.ts, same title): typing makes a draft (its row listed); a thread opens beside it and the draft keeps its tab; New thread on the same project opens a second, empty composer; the draft's row brings its text back; Esc with text does nothing; emptied, Esc goes to the project's page (Projects tab, `data-project=repo-gp`) |
| buttons.spec.ts:11 | sidebar new-thread button: the project picker, then typing in the composer starts the thread | rewritten (same title): s-2 (Needs you) opened by its row's first line (`openRowThread`), the rest unchanged |
| buttons.spec.ts:38 | thread pane header: the title's menu renames in the sidebar; fork is palette-only | rewritten (same title): Rename from the header's one menu (`thread-header-menu`); the fork found by name in the invocations (its tab's `thread.open` may come last) |
| home.spec.ts:42 | cmd+[ never goes past home: back from a thread lands on the composer, and again stays there | deleted: the classic selection history and its "home" rule are gone. Back/forward through focus is e2e/shell-spaces.spec.ts "back and forward go through the focus across panes and spaces" and src/stores/focusHistory.test.ts; a thread opened on the first load's empty space replaces it, so there is no composer to go back to. Comment left in its place |
| lineage.spec.ts:104 | a child open (from the card): arrows in the sidebar start from its creator's highlighted row | rewritten (same title): `openFromCard` checks the thread pane's id and the active tab's title (the classic `thread-title` is gone); the creator's highlighted row and the arrows unchanged |
| lineage.spec.ts:72 | cmd+shift+a and cmd+1..9 walk the shown rows only | rewritten (same title): cmd+shift+a opens s-2's Needs-you popup (3×, wrapping); cmd+1, 5, last open the list's rows (no child among them); orphaned, the child is a row cmd+N opens, and cmd+shift+a's round reaches the waiting orphans s-l-allow and s-l-cookie (C's finished turn is not an ask, so it is not in Needs you) |
| linkedprs.spec.ts:34 | the sidebar tag opens its pull requests as tabs in the thread's panel, the shown one's surface, and the prompt keeps no focus | rewritten (same title): on s-3 (a Needs you row has no tag); both PRs are `pullrequest` tabs in one pane beside the thread's, the shown one's surface (#12), the prompt not focused |
| move-no-project.spec.ts:20 | the sidebar row's Move to project… opens the thread and the picker under its crumb; a move lands over the streams | gap: kept as `test.fixme` (same title), the picker under the header's No project chip (`thread-header-place` / `thread-crumb-move`) then a whole move (`moveFromPicker`). From a thread whose tab is not open the picker shows only ~half the time (see gaps). Rewritten reliably as "with its thread open, the sidebar row's Move to project… opens the picker under the header's chip; a move lands over the streams" (15/15). The classic "Moving to code-foundry…" check is split into its own `test.fixme` "while a move is in flight the thread's header says where it is moving" (gap) |
| move-no-project.spec.ts:55 | the palette's Move Thread and the title menu's Move to project… open the picker after they close; Esc closes it | rewritten (same title): the header's one menu's Move to project…; waits for the opened thread's prompt focus before cmd+k (see notes) |
| move-no-project.spec.ts:73 | a refused move leaves the keyboard in the thread's prompt | rewritten (same title): the No project chip stays "No project" (was the crumb's place) |
| no-project.spec.ts:20 | No project: cmd+N, cmd+1 and a real send start a thread placed nowhere; cmd+T's shell; cmd+N and Enter again | rewritten (same title): the header's No project chip; cmd+t is a terminal tab linked to the thread, named by shell and folder while idle: `zsh · ~` (home) per the spec's Terminals section (the classic "No project" title is gone); stale unit-test references dropped |
| project-sets.spec.ts:71 | Save as workspace: the name takes the keyboard as the menu closes | rewritten (same title): from the header's one menu |
| project-sets.spec.ts:83 | New thread on this branch: Escape goes back to the thread; from the palette it takes the prompt | rewritten (same title): from the header's one menu; Escape shows the thread's tab again (thread pane id, row selected) |
| sidebar.spec.ts:147 | the menu pane: under the band, gutter to edge, surface fill, divider border, pane radius, 4px inside; the threads 8px below | rewritten as "the menu pane: under the top bar, gutter to edge, surface fill, divider border, pane radius, 4px inside; the list 8px below": no band and no Pull Requests / Projects rows; the pane right under the top bar, 12px gutter, to the sidebar's edge, 12px radius, 1px divider border, surface fill, New thread 5px in (28px), the list's first row (Needs you's header) 8px below |
| sidebar.spec.ts:189 | hovering a thread row shows its card right of the sidebar, 260px wide; a click or right-click closes it, the keyboard never opens it | rewritten (same title): s-3 → s-4 (s-2 is a Needs you row, with the inbox card instead); a click opens s-4's thread; the rest unchanged |
| sidebar.spec.ts:237 | at the narrowest sidebar the actions never cover the branch, on a selected row too, and the name and status stay | rewritten (same title) for the shell row: at 260px, unselected and selected, a long branch: the hover actions sit in line 1 (the status's slot), the branch on line 3 below them inside the row, the project stays (cut) left of the actions, the name does not move; a Needs you row has no actions and keeps its ask |
| sidebar.spec.ts:264 | a long permission prompt: the row keeps its branch; the card wraps all of it between the name and the project | deleted: a thread asking is a Needs you row (project and ask, then the title; no branch line by the spec) with the inbox card, not the classic card. The card growing with a long ask and scrolling: e2e/shell-needs.spec.ts "a long command grows the card to its maximum width and height, then scrolls inside it"; its content: src/components/needs/NeedsCard.test.tsx. Comment left in its place |
| sidebar.spec.ts:49 | status kinds: cmd+1 and cmd+shift+a through the keymap, and the window title's count | rewritten (same title): cmd+1 opens s-k-plan (Needs you's first row; its thread pane shows); cmd+shift+a opens s-k-approval's popup; the title counts 7 |
| sidebar.spec.ts:92 | thread rows sit 8px apart, snoozed rows 2px and 24px tall, at both densities, each row's box (and its selection) the row's own height | rewritten (same title) for the shell list: Active and Working rows 8px apart (their height is their lines', not a fixed 60), Snoozed rows 24px and 2px apart, at both densities; each row's slot is exactly its own height, selected too |
| snooze.spec.ts:149 | the hover snooze menu keeps the row's card shut, and clicking away leaves it shut | rewritten (same title): the click away lands on the pane area (`shell-grid`) instead of the classic `content-pane` |
| snooze.spec.ts:60 | the keyboard walks main → Working → Snoozed → Archived; collapsed sections are skipped | rewritten (same title): the walk and cmd+N unchanged (the shell's order is the same here); cmd+shift+a opens s-2's popup, never a snoozed thread's |
| thread-dock-height.spec.ts:43 | after a switch to another thread and back, the answer's end clears the composer and the chip sits above it (dark) | rewritten (same title): s-2 opened by its row's first line as a second tab, back to s-r1's tab (a tab not active draws nothing, so the dock is new) |
| thread-header.spec.ts:34 | the title menu: a pick gives the keyboard back to the thread's prompt | rewritten (same title): Pin from the header's one menu; the prompt has the keyboard after |
| thread-panel-items.spec.ts:39 | a thread's model opens a file, a diff and a pull request in its own panel; the window stays on the user's thread | gap: `test.fixme` (same title), asserting the daemon's rule: s-1's three tabs wait in the focused pane behind s-2's tab, s-2 stays shown, then s-1's PR from its tab. Fails: the window's half of the ShowView focuses the PR tab (see gaps) |
| thread-prompts.spec.ts:117 | a subagent's label cut short by a narrow prompt has a tooltip | rewritten (same title): the spec's `openThread` opens s-r1 by its Needs you row's first line |
| thread-prompts.spec.ts:134 | question keyboard from the editor: digits pick, Enter moves on and submits | rewritten (same title), as above |
| thread-prompts.spec.ts:177 | fields keep their keys: the Other field and the deny reason take digits and Escape; an open reason ignores 1 and 2 | rewritten (same title), as above |
| thread-prompts.spec.ts:80 | keyboard: an empty editor's digits answer, a typed message keeps them, Escape hands focus back | rewritten (same title), as above |
| thread-reconnect.spec.ts:35 | a thread switch reopens the Watch without the reconnecting chip | rewritten (same title): s-2 and back as tabs of one pane; one WatchThread open at the end, the chip never seen |
| thread.spec.ts:100 | the timeline: an earlier turn unfolded above the viewport, its Edit's diff, the answer's table | rewritten (same title): the spec's `openThread` opens s-r1 by its Needs you row's first line |
| thread.spec.ts:313 | a pending permission docks above the editor; the timeline's waiting word is amber (dark) | rewritten (same title), as above |
| thread.spec.ts:313 | a pending permission docks above the editor; the timeline's waiting word is amber (light) | rewritten (same title), as above |
| thread.spec.ts:382 | leaving a thread scrolled up: back on it, the list is pinned at the bottom with the turn folded | rewritten (same title): s-2 as a second tab and back to s-r1's |
| thread.spec.ts:577 | only the visible thread holds a Watch; a page holds none | rewritten (same title): the Projects page as a tab of the same pane (`openPageTab` from "+") in front of the thread: 0 Watches; back on the thread's tab: 1; s-2 in the same pane: still 1, no Attach |
| threads.spec.ts:100 | new thread: a checkout's New thread here on its project page opens the composer with that worktree | rewritten (same title): the Projects page opened from the palette ("Show Projects": the first load's empty space has no "+", so `openProjects`'s "+" path cannot run there); `thread.new`'s args gain the shell's `compose` |
| threads.spec.ts:172 | the whole app runs on one events stream plus one thread Watch | rewritten (same title): s-2 by its Needs you row's first line; the stream counts unchanged |
| threads.spec.ts:74 | needs-attention: window title and cmd+shift+a | rewritten (same title): s-1 joins Needs you above s-2; cmd+shift+a opens s-1's, s-2's, s-1's, s-2's popups (from inside the popup after the first); 1 in s-2's popup allows and the title count drops to 1 |
| waiting-strip.spec.ts:77 | back on a thread the strip says what is true now, not what it said when left | rewritten (same title): s-2 as a second tab and back to s-r1's |

Counts: 38 listed rows (thread.spec.ts:313 twice): 34 rewritten, 2 deleted, 2 gaps (both kept as `test.fixme`),
plus 1 more `test.fixme` for a gap split out of a rewritten test, and 1 new reliable test beside a gap.
