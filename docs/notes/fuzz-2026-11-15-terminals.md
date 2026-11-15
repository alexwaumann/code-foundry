# Fuzz pass 2026-11-15: terminals

Three findings from a fuzz pass over terminal tabs, the quick terminal and linked tabs (since
v0.21.7), fixed in one PR.

## 1. Action runs opened as anonymous "zsh · repo" tabs (a regression)

A user who ran a project action got a tab named like any shell in that checkout, with the shell
icon, no Stop, no Rerun, and only the shell's "Process exited with code N" pill once it finished.
v0.21.7's bottom panel named these tabs after the action, drew the action's icon, and showed the
command above the output and a status line under it; the bottom panel's removal (d93130eb1) left
`components/actions/ActionTabParts.tsx` mounted nowhere.

Cause: an action run's argv is `[$SHELL, "-lc", <command>]`, so `terminalName` took it for a shell,
and with no job control it never has a foreground job either.

Fix: `terminalName` takes the terminal's labels and names a `kind=action` terminal after its
`action.name` label (a manual name still sticks). `TerminalTabIcon` draws `ActionTabIcon` for one.
`TerminalTabBody` mounts `ActionEcho` above the xterm and `ActionStatusLine` under it for an action
run, and turns off the exit pill there (the status line says it), as v0.21.7 did. Nothing new was
designed: the parts are the orphaned ones, with `ActionTabIcon` taking the strip's `className`.

Rerun is `rerunAction` as it was: the action runs again, its tab opens, the keyboard goes in, and
the old tab closes, so tabs do not pile up. The new tab opens where `action.run` places one (the end
of the pane's strip), not at the old tab's index; v0.21.7 also appended it.

Left out: v0.21.7's status mark beside the tab name (spinner, check, x). A strip tab draws only an
icon and a name, and a narrow pane shows the icon alone, so it would need a slot in the strip
(another worker is changing `PaneTabStrip.tsx`). The status line carries the same state.

## 2. A snoozed thread's action tabs came back as unrelated empty shells

Cause: the snooze hook (`layoutShellsGoing`) remembered every terminal tab of the thread as one to
come back as a fresh login shell, with the command it ran for "Run again". An action run has no
foreground job or last command, so it came back as an empty shell with nothing saying what it was.

Fix (the smaller option): the hook drops a thread's action-run tabs (`drop_terminal`, which
forgets an open tab and a remembered running one) before `snooze_thread`, as an archive drops
them. The run itself ends with the thread's other shells. Pinned by
`TestLayoutGlueSnoozeDropsActionRuns` (a running and a finished run dropped, the shell restored).

## 3. Reset left the keyboard nowhere

Cause: `resetTerminal` ran `terminal.reset` and did nothing with its result; the Reset button goes
with the old shell's hint, so focus fell to the body. "Run again" on a restored tab or quick
terminal had the same gap (its line unmounts once it ran): checked in the app, the keyboard was on
the body after it.

Fix: Reset reads the new terminal's id from the result and moves the keyboard into it, with the
existing helpers: `focusQuick` for a quick terminal (read from the old terminal's labels, since the
new one may not be in the store yet), `focusTerminalTab` for a tab. Run again does the same once it
ran and its line is forgotten.

## Verified

On a dev daemon with a scratch repository and three actions: action tabs named Dev and Fail with
their icons, echo and status line (Running and Stop; Exited with code 3 and Rerun); Stop then
Rerun replaced the tab and the keyboard went into the new run; snooze with a shell running
`sleep 600` plus a running and a finished action left only the shell in `layout show`, and it came
back with "Run again"; Reset in a linked tab and the quick terminal, and Run again, left
`document.activeElement` in the terminal's textarea, and typed text reached the shell.
