# Phase 3 UI: near-black panes, no footer, command buttons

Status: done on `t3code/customize-window-title-bar`, after `phase3-ui-panes.md`.
`make check` is green (Go, 23 vitest files / 293 tests). `make gui-e2e` passes 124/124
(62 WebKit, 62 Chromium). The real app (`make gui-build`, `gui/bin/CodeFoundry`) ran
against a daemon with an isolated `CODE_FOUNDRY_HOME` in dark mode.

## 1. Darker dark mode

| Token | Dark before | Dark now |
|---|---|---|
| `--sheet` | `oklch(0.13 0 0)` (#070707) | `#000000` |
| `--pane` | `#101010` | `#060606` (via `#0a0a0a`) |
| `--pane-border` | `oklch(1 0 0 / 8%)` | `oklch(1 0 0 / 11%)` |

These stay tied together:

* `src/terminal/theme.ts` dark `background` and `cursorAccent` are `#060606`, equal to `--pane`.
* `gui/main.go` `BackgroundColour` is `NewRGB(0, 0, 0)`, equal to `--sheet`.

Light mode is unchanged. The border alpha went up because the pane is now only 10/255
above the sheet, and 8% white left the edge hard to see. Sampled from the live window:
sheet (0,0,0), pane and terminal (10,10,10), pane edge (37,37,37).

`--sidebar-accent` (0.235) was not changed. The selected row still reads clearly on black.

## 2. Footer and chord hints removed

Removed:

* `components/footer/Footer.tsx`, along with its `Hints` list and the `data-testid="hints"` element.
* `keys/hints.ts` and its `hintsFor` tests in `keys/bindings.test.ts`.
* The `Kbd` lists in `Dashboard.tsx`: the Welcome list and the "Press ⌘N / ⌘T" empty states.
* The chord label and the chord tooltip on `PullRequestsNav`.
* The "Press A" banner text and the "Toggle with A" tooltip on the Pull Requests page.
  The banner now has a "Show pull requests from every repository" link that runs the
  same toggle.
* The `useChord` kbd on the Reconnect button in `SessionDisconnected`.
* `(⌘⇧A)` in the attention badge's tooltip.
* `Kbd` in `prs/PrBits.tsx`, which became unused.

Chords now appear only in the command palette, the Keyboard Shortcuts overlay
(`view.help`), and the keybinding editor in Settings. The overlay also lists what the
footer used to teach and nothing else did: ↑/↓ to move, ↵ to open, ←/→ to fold, and `A`
on the Pull Requests page (`extraChords` in `HelpOverlay.tsx`).

Moved:

* `DaemonStatus` (and its test) moved from `components/footer/` to `components/status/`.
  It now clips instead of forcing its width (`min-w-0 overflow-hidden`), and its
  tooltip carries the full line (status, pid, version, uptime, error). At the default
  260px width the uptime is clipped.
* `UpdateIndicator` lost its leading `· ` and now gets its own line above the status
  when an update is pending. The e2e texts were updated to match.
* Both sit in `components/sidebar/SidebarStatus.tsx` (`data-testid="sidebar-status"`) at
  the foot of the sidebar: 11px, muted, on the sheet. When the sidebar is hidden (⌘B),
  the row is hidden with it.

Layout: `<main>` gains `mb-2`, so the pane sits 8px from the bottom edge, matching the
right edge (asserted in `e2e/layout.spec.ts`). The toast offset went from
`{ bottom: 40, right: 16 }` to `{ bottom: 20, right: 20 }`.

## 3. Buttons

Every button goes through `components/command/CommandButton.tsx`. It calls
`startCommandNamed(name)` (`keys/bindings.ts`), which calls `startCommand`, the same
path the palette and keybindings take:

* GUI presenters first.
* Then arg prompts in the palette.
* Then `runCommand` with the current `getUiContext()`, including the confirm flow.

No new user action exists. Availability comes from a narrow selector:
`useCommandsStore(s => s.commands.find(c => c.name === name && c.available)?.title ?? null)`.
`CommandService.List` only returns available commands, so an unlisted command is
unavailable. The button then hides (`whenUnavailable="hide"`, the default) or is
disabled (`"disable"`). The tooltip and aria-label are the command's title, never a
chord. Icon-only buttons are shadcn `ghost` / `icon-xs` with 14px lucide icons.

By default (`keepFocus`), a button has `tabIndex={-1}` and calls `preventDefault` on
mousedown. A click therefore does not move focus out of the sidebar tree or the
terminal, and `data-region` focus tracking and arrow-key navigation are unaffected. The
dashboard buttons opt out (`keepFocus={false}`) and are normal tab stops.

| Location | Button | Command |
|---|---|---|
| Sidebar "Repositories" header | Sparkles | `session.new` (disabled when no repo/worktree is in context; opens the palette's model/effort prompts) |
| Sidebar "Repositories" header | SquareTerminal | `terminal.new` (cwd = context worktree, else home) |
| Sidebar status row | Command | `ui.palette.open` |
| Sidebar status row | CircleHelp | `view.help` |
| Sidebar status row | Settings | `view.settings` |
| Pane header, session | Pencil | `session.rename` (presenter: inline rename in the sidebar) |
| Pane header, session | GitFork | `session.fork` |
| Pane header, session | Power | `session.close` |
| Pane header, plain terminal | OctagonX | `terminal.kill` (daemon confirm) |
| Overview "No sessions here." | "New session" | `session.new` |
| Overview "No terminals here." | "New terminal" | `terminal.new` |
| Welcome panel | "New session" (disabled with nothing selected), "New terminal", "Command palette" | `session.new`, `terminal.new`, `ui.palette.open` |
| Welcome panel prose | "Keyboard Shortcuts" link | `view.help` |

The pane header stays 36px (`h-9`, asserted in e2e). `terminal-header` and
`terminal-title` are unchanged. Nothing was added to `TitleStrip.tsx`.

`ui.palette.open` gets a presenter in `commandPresenters`. Like ⌘K, it opens this
window's palette locally, with no daemon round trip and no "delivered=1" toast. It is
deferred with `queueMicrotask` because the palette closes itself after running a
presenter, so picking it inside the palette closes and then reopens it. The CLI still
reaches every window through the daemon.

Skipped: a `repo.register` button. The command takes a required `path`, and nothing
supplies a native folder picker. The Wails host has no dialog binding, and the frontend
never calls `@wailsio/runtime` `Dialogs`. As a button it could only reopen the palette's
free-text path prompt. A follow-up could call `Dialogs.OpenFile({ CanChooseDirectories: true, CanChooseFiles: false })`
and pass the result to `runCommand("repo.register", { path })`, after checking that it
works without host code.

Mock daemon: it gained `session.fork` (new session in the same worktree, focused) and
`ui.palette.open`, so the buttons have something to show in e2e.

## Tests

* `components/command/CommandButton.test.tsx`: hide/disable table, title without a
  chord, tabIndex, and that a click starts the command.
* `e2e/buttons.spec.ts`:
  * no footer, hints or `kbd` outside the palette and help;
  * the sidebar new-session button runs `session.new` through the palette prompts for
    the selected worktree, and the new session is selected and attached;
  * the sidebar new-terminal button;
  * the status row's settings, help and palette buttons (the palette opens locally);
  * pane-header rename, fork and close, with the session context;
  * terminal kill confirms;
  * the welcome and empty-state buttons.
* `e2e/layout.spec.ts`: the 8px bottom gap, and the daemon status at the foot of the sidebar.
* `e2e/update.spec.ts`: the indicator texts no longer have the `· ` prefix.

## Live run

```
export CODE_FOUNDRY_HOME=/tmp/cfv2-home
./bin/code-foundry daemon &
./bin/code-foundry repo.register --path /tmp/cfv2-scratch
./bin/code-foundry settings set appearance.theme dark
gui/bin/CodeFoundry &
./bin/code-foundry terminal.new --cwd /tmp/cfv2-scratch
./bin/code-foundry ui.focus.terminal --id <id>
screencapture -o -x -l <windowid> /tmp/cf-panes-v2.png
```

The window id came from `CGWindowListCopyWindowInfo` filtered by the GUI's pid. Another
CodeFoundry instance may be running, so match the pid. No mouse or keyboard events were
sent, so the buttons were exercised only in e2e, not in the real window.

## Gotchas

* `wails3 build` again dropped the blank line in `go.mod`. It was reverted, not committed.
* The scratch terminal under `/tmp` lands in "Other terminals", not under the scratch
  repo. `/tmp` is a symlink to `/private/tmp`, and placement compares the raw cwd.
  This predates this change.
* In the live screenshot the zsh pane had no visible prompt. The attach phase and
  rendering were not investigated further here. The e2e attach tests pass, and the pane
  and terminal colours match.
