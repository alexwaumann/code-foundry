# Shell PR 12: linked tabs: the row under the strip, the pane's plus menu, the thread header

Twelfth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on, a
tab linked to a thread has a quiet row under its strip that names the thread and links back; a
pane's strip ends in a "+" menu of surfaces; a thread's pane has the spec's header (branch chip,
thread info toggle, one three-dot menu); a thread that needs the user marks its tab's icon; and
cmd+shift+d and cmd+shift+i are in the interim key table. With the flag off nothing changes.

## What is in it

| File | Holds |
| --- | --- |
| `shell/linked.ts` | pure: a thread's surfaces in a space (a diff per checkout, its linked pull requests, its terminal tabs), each with the tab that has its identity when open; the row's state (live, dormant, the thread's other space); the action of every menu item and of the row, as a verb with its args, a tab to focus, or a note |
| `shell/linkedRun.ts` | runs an action: the verb quietly (with the thread's context when it names one), or `tab.focus` with the keyboard following, or a toast |
| `shell/tabCut.ts` | whether each pane's active tab name is cut short or hidden, measured by the strip |
| `shell/useThreadName.ts` | a thread's name by id |
| `components/shell/LinkedRow.tsx` | "Diff of ● thread" under a linked tab's strip; `linkedRowEnd` slot at its right |
| `components/shell/PanePlusMenu.tsx` | the "+" after the last tab |
| `components/shell/ThreadSurfaceItems.tsx` | the Open ▸ items (shared by the header and the "+" submenu) and the Move to space ▸ items |
| `components/shell/ThreadDot.tsx` | the status dot before a thread's name in the row and the "+" menu |
| `components/thread/ThreadHeader.tsx` | the thread's header in a shell pane |
| `shell/surfaces/types.ts` (+ `panel.ts`, `thread.tsx`) | `linkedNoun`, `linkedRowEnd`, `useAttention` on `ShellSurface` |
| `PaneView.tsx`, `PaneTabStrip.tsx` | the row between strip and body; the "+", the attention dot, the linked tab's hover, publishing the cut |
| `stores/threadInfoOverlay.ts`, `components/threadinfo/*` | the card's room per thread |
| `shell/keys.ts` | cmd+shift+d (`view.thread-diff`), cmd+shift+i (`view.thread-info`) |
| `internal/command/commands_terminal*.go` | `--pane` on `terminal.new` and `terminal.new-free` |
| `internal/command/commands_ui*.go` | `--pane` on `ui.focus.terminal`: a running terminal with no tab gets one in that pane |
| `shell/terminalActions.ts` (PR 13's) | `newTerminalTab({thread, pane})`, `newFreeTerminalTab(pane)`, `openTerminalIn(id, pane)` |
| `shell/surfaces/terminal.tsx` (PR 13's) | `linkedNoun` "Terminal" and `linkedRowEnd`: `TerminalCwdHint` |
| `stores/intents.ts` | the classic `focusTerminal` intent does nothing while the shell draws |
| `mock/layoutVerbs.ts`, `mock/github.ts`, `mock/world.ts` | the mock's `view.thread-diff`; `--pane` on its `view.pullrequests` and `view.projects` |
| `e2e/shell-linked.spec.ts` | the submenus' pointer and keyboard paths, the narrow pane's overlay, SHOTS |

## Decisions

- **Names come from the thread, by id**, everywhere: the row, the linked tab's hover, the "+"
  menu's thread item, the header. A rename shows at once.
- **The row** is one button across the row (the link) and an end slot. Live while the thread's
  tab is open in the tab's space: the link focuses it. Dormant otherwise: muted text, a faded dot,
  the name not bold. A dormant link opens the thread with `thread.open --pane <this pane>
  --focus`: the thread-tab rule is "the focused pane", which the press on the row just made this
  pane; passing it avoids racing the pane's own `pane.focus`. A thread living in another space is
  named with "· in <space>", and its link only toasts where it is until spaces show (PR 15).
- **The row's dot is the thread's status** (working accent, needs-you warning, error, idle muted),
  the sidebar's `threadBadge`. The sketch's blue dot was a working thread.
- **A linked tab's hover always opens** (a tooltip that is not `whenTruncated`): "Diff of
  <thread>", with the tab's own name above it while that is cut. Other tabs keep `whenTruncated`.
- **The header does not repeat the thread's name.** The strip publishes whether the pane's active
  tab is cut short or icon-only (`shell/tabCut.ts`); while it is, the header shows the name before
  the branch chip, so the name is always on screen exactly once.
- **The header's left** is the branch chip (the sidebar row's branch: `useThreadPlace`, which
  falls back to the head or folder when the thread record has no branch). A thread with no project
  shows "No project" instead, as the move picker's trigger while it can move, so the menu's "Move
  to project…" still has its anchor. The classic header's crumb (place › parent) is gone in the
  shell; the thread info card has the place and the lineage.
- **One menu**: Open ▸, Move to space ▸, separator, `ThreadMenuItems` unchanged (Rename,
  Regenerate name, Move to project…, Pin, Snooze ▸, New thread on this branch, Save as workspace,
  Run in ▸, Restart Claude, Clear flags, Archive), then Close ⌘W (`thread.close`). The side and
  bottom panel toggles stay out of shell panes (PR 11).
- **Open ▸ items**: a Diff per checkout (`view.open.diff`, with the checkout's root as the path
  when the thread has several, named "Diff · <project>"), each linked pull request newest first
  ("PR #n", `view.open.pr <n>`), then "Terminals": the thread's terminal tabs in the space, each
  marked "open", and New terminal tab (`terminal.new` with the thread's context). An item whose
  tab is open is marked "open" and is focused with `tab.focus`, never reopened: `open_surface`
  would replace a diff's chosen file and sides (PR 7's reason for `view.thread-diff`). The open
  mark compares the daemon's identity keys (`diff:<thread>:<project>:<worktree>`,
  `pr:<slug>#<n>`) with the tabs' `key`.
- **The header's Open ▸ places by the rules** (no `--pane`); the "+" submenu passes `--pane`.
  The space the items look in is the pane's.
- **Move to space ▸** lists the spaces in order, the thread's own marked "here" and disabled;
  with one space until PR 15 it shows just that one. No "New space" item: a thread moved to a
  space the window cannot show yet would vanish.
- **The "+" menu**: with a thread's own tab active, "This thread" and the thread's item (dot and
  name) opening the Open ▸ items; then New thread ⌘N (`composer.new --pane`), Terminal
  (`terminal.new-free --pane`: cmd+shift+t's free shell in the home folder), Pull Requests
  (`view.pullrequests --pane`) and Projects (`view.projects --pane`). A linked tab's thread is not
  offered when the active tab is the diff: the spec says "with a thread tab active".
- **`--pane` on the terminal verbs**: `terminal.new` and `terminal.new-free` had none, so the "+"
  menu's terminals would have been placed elsewhere. `openTerminalTab` takes the pane and passes
  it to `open_surface`. A small additive change in PR 13's area.
- **The menus' terminals are cmd+t's and cmd+shift+t's.** "New terminal tab" and the "+" menu's
  Terminal run PR 13's own `newTerminalTab` / `newFreeTerminalTab` (shell/terminalActions.ts),
  which now take an optional thread and pane: the same verbs (`terminal.new` with the thread's
  context, `terminal.new-free`), and the keyboard goes into the new tab as after the keys. A
  `LinkedAction` of kind `terminal` carries them, so the menus' actions stay pure and tested.
- **Running terminals with no tab** (the owner's open question, built as the likely answer): under
  the "+" menu's Terminal, each running terminal that belongs to no thread and has no tab in any
  space (a shell, an action run or a setup the classic window's Projects bottom panel started, or
  one made through `TerminalService.Create`), named as its tab would be (`terminalName`, with its
  icon). A pick gives it a tab in that pane. A thread's terminals are not listed: its quick
  terminal is not a tab, and the tabs its close put away come back with the thread. Plugins' own
  terminals are not listed either. The daemon could already give a terminal a tab
  (`ui.focus.terminal` opens one by the rules when it has none), so the smallest addition was
  `--pane` on that verb, not a new one; a terminal that has a tab is still focused where it is.
- **The classic `focusTerminal` intent is ignored in the shell.** `ui.focus.terminal` also sends
  it for the classic window; the shell's handler revealed the shell in the classic bottom panel,
  which for a shell of a checkout routed to the Projects page and opened a Projects tab over the
  new terminal tab (seen end to end). PR 7's note had asked for this.
- **The linked terminal row**: "Terminal of ● thread", and PR 13's `TerminalCwdHint` in the slot
  at its right. The link button shrinks first, so the hint's Reset stays visible.
- **The "+" is not the pane's grip** (PR 14 made the strip's free space drag the pane): its
  pointer down stops at the button, as PR 13's name field does, so a press and move there opens
  the menu and never lifts the pane. PR 14's `shell-drag.spec.ts` pressed 24 px from the strip's
  end for its grip, which in a narrow pane is the "+"; its helper now presses between the "+" and
  the strip's end.
- **Focus after a pick**: an item that focuses or opens a tab keeps the keyboard where the action
  put it (the menu's `onCloseAutoFocus` is prevented); a focus action requests the pane's focus.
- **Attention dot**: `ShellSurface.useAttention` (thread tabs: `isAttention` and not archived)
  draws a warning dot on the tab icon, active or not, with the label "Needs you". The spec puts
  it on the icon (and in a rail, PR 19); the sketch had it after the name.
- **Thread info per pane**: the card's room was one window-wide value (the classic window has one
  thread body). Two thread panes overwrote each other, so a narrow pane could get the inline card
  and a wide one the overlay. `useCardRoom.rooms` keeps each thread body's measure (a thread has
  one tab); `room` stays the last one, for callers that name no thread. The toggle and
  `toggleThreadInfo` read the selected thread's. `threadInfoOpen` stays the window's preference,
  so every wide thread pane shows the card; a narrow one floats it until a press back in its
  conversation (the overlay's existing outside-press rule). The overlay's Escape returns focus to
  its own pane's toggle.
- **Keys**: cmd+shift+d runs `view.thread-diff --tab <focused> --focus` and the keyboard follows
  the commit; cmd+shift+i runs `view.thread-info`'s presenter (`toggleThreadInfo`, focused, as a
  key does). cmd+shift+i was already the command's own chord; the table now lists it so the key
  table test covers the spec's row.
- **Mock**: `view.thread-diff` (the same three cases as Go: back from the diff, focus an open
  one, else open it); `view.pullrequests` and `view.projects` open their tab only with `--pane`
  (without one they still only send the classic ShowView, so the existing suite's flows are
  unchanged). Since the rebase onto PR 13, the mock's `terminal.new` and `terminal.new-free` take
  `--pane`, and the mock has `ui.focus.terminal` (`--pane`; the quick slot not ported).

## Visible differences from the sketches (01, 04a-04d)

- The header has no thread name while the tab shows it whole (the brief's rule); the sketch shows
  the name before the branch chip.
- The header shows the thread info toggle beside the three dots; the sketch shows only the dots.
- The menu ends with Close ⌘W; the sketch has no Close (the spec lists it).
- Open ▸ has no "Files…" item; cmd+p is the file finder.
- Open ▸ lists only the thread's terminal tabs, each marked "open"; the sketch also lists a
  running shell of the thread with no tab. Untabbed terminals of no thread are listed under the
  "+" menu's Terminal instead (not in any sketch).
- Move to space ▸ shows one space and no "New space"; the spaces' icon is a generic grid, not
  each space's layout glyph (PR 15 has that glyph).
- The attention dot is on the tab's icon, not after its name (the spec's placement).
- No full-screen button at the strip's right (PR 19).

## Verification

- `make check` green.
- vitest: `shell/linked.test.ts` (surfaces with one and several checkouts and pull requests, the
  open marks, every action's verb and args with and without a pane, the row live, dormant and in
  another space, the space choices), `components/shell/linkedTabs.test.tsx` (the "+" menu with and
  without a thread tab, each general item's verb in its pane, the thread submenu by keyboard and
  New terminal tab; Open ▸ with two checkouts and two pull requests, a thread with neither, which
  verb or focus each item runs; the row's text, live link, dormant link, rename; the header's
  name only while the tab is cut, its menu's order, Move to space, Close), `PaneTabStrip.test.tsx`
  (the attention dot, active or not, never archived; the linked tab's hover; the cut published),
  `threadInfoOverlay.test.ts` (rooms per thread), `keys.test.ts` (the two rows). After the
  rebase: `untabbedTerminals` (which terminals are listed), the "+" menu listing them under
  Terminal and a pick running `ui.focus.terminal --id --pane`, the linked terminal row with the
  hint once the shell left, and `intents.test.ts` (the shell ignores `focusTerminal`; the classic
  window still reveals).
- Go: `TestTerminalNewOpensATab` gained `--pane` for a thread's shell and a free one;
  `TestFocusTerminalInAPane` (a tab in another space's pane; a second call keeps it there).
- e2e `shell-linked.spec.ts` (WebKit, mock): the "+" thread submenu opens on hover and its open
  diff is focused in the other pane; the same path by Enter, ArrowRight, Enter; the header's Open
  to Move to space by the pointer; thread info floats over a narrow pane (about 360px) until a press in its
  conversation while the wide pane shows the card inline; a press and move on the "+" opens the
  menu and lifts nothing, while the same move from the strip's free space lifts the pane. The four
  shell specs (grid, drag, terminal, linked) pass together.
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home and a scratch repository
  under the home folder (both removed after): two threads made with `thread new --project repo`,
  the first opened from the CLI. cmd+shift+d in the window opened its diff in a new pane to the
  right, focused; cmd+shift+d again focused the thread (`layout show`: rev 5 then rev 6). As the
  second thread (`CODE_FOUNDRY_THREAD`), `view open diff` opened its diff behind the first
  thread's tab in the focused pane (its tab was not open: the spec's rule), the focus unmoved; the
  tab's row read "Diff of Second thread", dormant, and its link opened Second thread in that
  pane. "+" › Terminal in the other pane put an unlinked terminal tab there, and "+" › Second
  thread › New terminal tab a linked one in the "+"'s pane.
- After the rebase, again on a dev daemon: a shell made with `TerminalService.Create` (labels
  `kind=shell` only, as the classic bottom panel makes them) showed under "+" › Terminal as
  "zsh · tmp"; a pick gave it a tab in that pane, active, with the keyboard in its xterm, and
  `layout show` listed it. The first attempt, before the intent fix, also opened a Projects tab.

## Gotchas

- Radix ignores a pointer moving from an open submenu's trigger toward the submenu (its grace
  area), judging each move by the direction of the move before it. A single Playwright `hover`
  onto the next submenu trigger is ignored; two moves, the second leftwards, are not.
- `document.getAnimations()` includes the spinner's infinite animation: wait for finite ones only
  before a screenshot of a menu that zooms in.
- jsdom's text content has no space between the row's spans; the noun's span ends with a space.

## For later PRs

- **PR 15 (spaces)**: a dormant row of a thread in another space should switch to it; Move to
  space ▸ can gain "New space" and the spaces' layout glyphs.
- **PR 16 (sidebar)**: the row menu's Open ▸ for a thread whose tab is not open is the same
  `ThreadSurfaceItems` (it goes to the focused pane by the daemon's rules).
- **PR 19 (rails)**: the attention dot should show on a rail's icons through the same
  `useAttention`.
- **Cutover (PR 20)**: cmd+shift+d and cmd+shift+i move into the commands' keybindings with the
  rest of the table.
