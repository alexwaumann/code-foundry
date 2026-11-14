# Shell PR 13: terminal tabs and the quick terminal

Thirteenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on, a
terminal is a tab in any pane and each thread has a quick terminal under its conversation; the
spec's "Terminals" section and the key rows cmd+t, cmd+shift+t, cmd+j, cmd+shift+j, cmd+r and
cmd+shift+r work. With the flag off nothing changes.

## What is in it

| Where | Holds |
| --- | --- |
| `lib/terminalName.ts` | pure: a tab's name and icon kind (manual name, else the foreground command, else `<shell> · <folder>`), `cwdHint`, `normalizeDir` |
| `shell/surfaces/terminal.tsx` | the `terminal` surface: name, icon that follows what runs, body, context menu |
| `shell/surfaces/types.ts` | two optional fields: `TabIcon` (an icon that follows the tab) and `tabMenu` (context menu items) |
| `shell/quickTerminal.ts` | pure: `quickMode` (push or overlay), `quickHeight`, `quickTerminalOf`, `quickKeyAction` (cmd+j); the keyboard handle (`focusQuick`, `registerQuickHost`, `quickHasFocus`) |
| `shell/terminalActions.ts` | what the keys and controls run: cmd+t, cmd+shift+t, cmd+j, cmd+shift+j, cmd+r, cmd+shift+r, Reset, Run again, a code block's Run in terminal; the tab rename store |
| `shell/terminalTab.ts` | hooks: `useTerminalTabName`, `useTerminalDir`, `useTerminalCwdHint` |
| `components/shell/TerminalTab.tsx` | the tab's body (xterm, the restored line), its icon, its name field, its menu |
| `components/shell/QuickTerminal.tsx` | `ThreadWithQuick` (the thread surface's body) and the quick terminal: header, resize edge, xterm |
| `components/shell/TerminalCwdHint.tsx` | the "· thread is in … · Reset" hint, exported for the linked row |
| `components/shell/terminalIcons.ts` | icon kind to lucide icon |
| `components/shell/PaneTabStrip.tsx` | small: the tab's icon from `TabIcon`, a context menu when the surface has `tabMenu`, the name field over the tab while renaming |
| `shell/keys.ts` | six rows; `keys.test.ts` checks them against the spec's table |
| `components/thread/CodeActions.tsx` | Run in terminal: a linked terminal tab when the shell draws the window |
| `api/terminal.ts`, `stores/terminals.ts` | `liveCwd`, `foreground`, `lastCommand` mapped and compared |
| `internal/command/commands_tab.go` | `tab.rename [tab] [--name] [--auto]` |
| `internal/command/commands_terminal_quick.go` | `terminal.quick --height`; `QuickResult.rev` |
| `mock/layout.ts` | `set_quick` ported (and run against Go's cases); an `applied` hook after each op |
| `mock/terminalVerbs.ts`, `mock/world.ts`, `mock/server.ts` | `terminal.quick`, `terminal.cycle`, `terminal.reset`, `terminal.rerun`, `tab.rename`; new shells get tabs; a closed terminal tab ends its shell; a removed terminal closes its tab; terminal facts (`cd` moves `liveCwd`, a typed line is `lastCommand`, `POST /__mock/terminal/facts`) |
| `e2e/shell-terminal.spec.ts` | xterm in a tab and in the quick slot, Attach counts, push versus overlay, SHOTS |

## Decisions

- **Two new verbs' worth of flags, no new behaviour in the daemon.** cmd+r and cmd+shift+r on a
  terminal tab need a command (every user action is one): `tab.rename` sets or clears the layout
  tab's manual name (`rename_tab`, which existed). The quick terminal's height drag is
  `terminal.quick --height`, which alone keeps the open state, as `pane.resize` is the gutter's
  verb. `QuickResult` now carries the commit's `rev` so the window can wait for it.
- **cmd+r and cmd+shift+r on a thread's tab** keep today's behaviour: the sidebar's inline rename
  (`thread.rename`) and `thread.regenerate-name`. On other tabs they do nothing.
- **cmd+j's three states** are `quickKeyAction` (pure). Open and focus runs
  `terminal.quick --open --focus` and asks the quick terminal for the keyboard as soon as it
  mounts. "Focus when open" runs no command: it only moves the keyboard. Close runs
  `terminal.quick --close` and the keyboard goes back to the thread's prompt. From a linked surface
  (a diff, a terminal tab) it is `terminal.quick <thread> --open --focus`.
- **cmd+t** runs `terminal.new` with the focused tab's thread as the context (the daemon places
  the tab by the rules and focuses it); with no thread, a Projects-page checkout's shell, else
  `terminal.new-free`. cmd+shift+t is `terminal.new-free`. After either, the keyboard goes into the
  new tab once the layout has it.
- **cmd+shift+j** is `terminal.cycle --tab <focused> --focus`; the keyboard follows the focus.
- **Names** (`lib/terminalName.ts`): a manual name sticks; else the foreground command line as
  the daemon gives it; else `<shell> · <folder>` (`~` for home). An action run is named by its
  argv. The icon is by the command's program (a small table of programs in 13 kinds), skipping
  `sudo`, `env` and `VAR=value`; a program not in the table is `run` (play), the idle shell
  `shell`. A manual name keeps the running command's icon.
- **The hint's condition** (`cwdHint`): the terminal's thread directory (the thread's
  `worktreePath`) and the shell's `live_cwd` both known and different after normalising trailing
  slashes and macOS's `/private/tmp`, `/private/var`. A shell of no thread has none. The header
  shows the directory the same way (`/tmp`, not `/private/tmp`).
- **Push or overlay** (`quickMode`): it pushes while the pane's height minus its own leaves the
  thread's header, its composer dock (both measured with a ResizeObserver) and `CHAT_MIN` (120 px)
  of conversation; otherwise it is drawn absolutely over the bottom of the thread's body. Its
  height defaults to 260 px, never under 96 px, and leaves 44 px of the pane above it.
- **Streams**: the quick terminal mounts only while its thread's tab is its pane's active tab and
  the thread's `quick.open` is set, so it holds an Attach only then; a terminal tab mounts its
  xterm only while active (the pane's rule).
- **The restored line** shows while the tab has a `ran` param (the daemon sets it on a snooze's
  restored tab). Run again (a click or Enter on the line) runs `terminal.rerun --command <ran>` and
  then clears the param with `set_tab_params` straight through LayoutService (bookkeeping, like the
  seam's own param writes). A quiet × drops it without running. It never runs by itself.
- **The context menu** of a terminal tab: Rename…, Automatic name (off without a manual name),
  Close terminal. The name field is drawn over the tab's label; Enter or leaving it renames,
  Escape keeps the name, an empty name is the automatic one.
- **Run in terminal** from a code block, with the shell drawn: `terminal.new --run` with that
  thread as the context, a new linked tab each time (as the classic panel starts a fresh shell).
- **`NoPalette` stays** on `terminal.quick`, `terminal.cycle` and `terminal.new-free` (the
  shell-5 and shell-6 notes said to drop it here). With the flag off the classic window's palette
  would list three verbs whose result it does not draw. They go into the palette with the
  cutover (PR 20), when the chords move into `Command.Keybindings` too.

## With PR 14's drags (rebased onto it)

- **One element, two sets of props.** A tab whose surface has `tabMenu` is wrapped in a Radix
  context menu trigger (`asChild`), and the same element is dnd-kit's draggable. `ShellTabBox`
  sets both refs and calls both handlers for an event they share (`mergeHandlers`: the trigger's,
  then the drag's). A terminal tab drags like any tab, active or not.
- **What does not drag.** A right press opens the menu: dnd-kit's pointer sensor starts only on the
  primary button. The name field takes no drag: the strip drops the drag listeners while the tab is
  renamed, and the field stops its pointer down.
- **Rename… from the menu starts once the menu has closed** (`renameAfterMenuCloses`, then
  `takeRenameAfterMenu` in the menu's `onCloseAutoFocus`). Started at once, the field mounted inside
  the menu's focus trap and lost the keyboard; the WebKit spec caught it, jsdom did not.
- **The drag shield over a terminal**: `shell-drag.spec.ts` drags a tab across a terminal tab's
  xterm to that pane's edge; the preview follows, the drop lands, and the terminal keeps its stream
  and never takes the keyboard. Another case drags an inactive terminal tab into another strip and
  checks that a moved right press and a drag inside the name field start nothing.

## Visible differences from the sketches (05a, 05b, 05c, 01)

- The hint reads "· thread is in ~/… · Reset" (05c: "thread is now in"), and it sits at the right
  end of the header before ⌘J and ×, as the spec says, not right after the path as 05c draws it.
- ⌘J in the header is the app's key chip, not plain text.
- 05b shows the overlay in the lower of two stacked thread panes; the screenshot shows one pane in
  a short window. Same rule.
- The overlaying quick terminal has a shadow on its top edge to separate it from the conversation
  it covers.
- A `make dev` tab shows a hammer (build) icon; 01 shows the generic terminal icon.
- No "Terminal of ● thread" row under a linked terminal tab's strip (PR 12), so a linked tab's
  Reset hint does not show yet (see below).
- Unchanged from PR 11: no top bar (PR 15), the classic sidebar (PR 16), today's thread header
  (PR 12).

## Verification

- `make check` green (numbers in the PR).
- vitest: `lib/terminalName.test.ts` (names and icons, the hint's condition, `normalizeDir`),
  `shell/quickTerminal.test.ts` (cmd+j's states, push or overlay, heights, the quick slot, the
  keyboard handle), `shell/terminalActions.test.ts` (which command each key runs with which args,
  cmd+j's three states and the linked surface, rename and automatic name on terminal, thread and
  other tabs, Reset, Run again), `components/shell/TerminalTab.test.tsx` (the restored line and its
  Enter, the strip's names from the facts, the context menu, the name field, the hint),
  `keys.test.ts` (six new rows), `registry.test.ts` (no kind left for later), `mock/layout.test.ts`
  (set_quick against Go's six cases).
- e2e `shell-terminal.spec.ts` (WebKit, mock): xterm live in a tab, one Attach with a hidden
  terminal tab, still one after switching, two with the quick terminal open (opened by cmd+j
  through the keymap), one after cmd+j closes it; push at 900 px with the composer above it,
  overlay at 520 px over the dock and flush with the pane's bottom, push again at 900 px.
- Go: `TestTabRename`, `TestTerminalQuickHeight`, the classification lists.
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home under /tmp (removed
  after): a no-project thread opened; cmd+t twice put two linked terminal tabs in a pane to the
  right; cmd+shift+j from the prompt went terminal, terminal, thread, terminal with the keyboard
  following; cmd+j opened the quick terminal with the keyboard in it; `cd /tmp` showed
  "/tmp · thread is in ~ · Reset"; Reset started `t-82f…` with `replaces=` in the home directory and
  the hint went; `terminal rerun --command "sleep 60"` renamed that tab "sleep 60"; closing the
  other tab's × removed its terminal (`terminal list`); `thread close` kept both shells running and
  `thread open` brought back the tab and the open quick terminal; a snooze and unsnooze brought the
  tab back as "zsh · ~" with "Last command sleep 60 Run again", and Enter on the line ran it;
  cmd+shift+t made a free shell's tab, cmd+r renamed it "scratch", cmd+shift+r gave back "zsh · ~".

## Gotchas

- The strip's hidden measuring row repeats every tab's label: a test reading labels reads them
  from `[role="tab"]`.
- A Radix context menu hands the focus back to its trigger as it closes, which would blur the
  name field it just opened: the strip prevents that close focus while a rename started.
- `/__mock/terminal/facts` is `mockPost("terminal/facts?...")` in e2e (the fixture adds `/__mock/`).

## For later PRs

- **PR 12 (linked row)**: mount `<TerminalCwdHint terminalId={tab.params.terminal} />` at the right
  end of the row under a linked terminal tab's strip ("Terminal of ● thread"). It renders nothing
  when there is nothing to say, shortens its directory first, and Reset is `terminal.reset`.
  `useTerminalCwdHint(terminalId)` is the hook if the row wants its own layout. The pane's "+" menu
  can call `newTerminalTab()` / `newFreeTerminalTab()` from `shell/terminalActions.ts`.
- **PR 19 (rails, full screen)**: a folded pane mounts no body, so its quick terminal detaches too.
- **PR 20 (cutover)**: drop `NoPalette` from `terminal.quick`, `terminal.cycle` and
  `terminal.new-free`; the six chords move into `Command.Keybindings` (cmd+t and cmd+r are today's
  `terminal.new` and `thread.rename` chords, which change meaning: the classic bottom panel's
  cmd+j is `view.bottom.toggle`).
- **PR 21 (panels removed)**: `runInThreadTerminal` and the classic branch in `CodeActions.tsx` go.
