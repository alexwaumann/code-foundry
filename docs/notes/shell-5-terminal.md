# Shell PR 5: free shells, the quick slot, live directory and foreground command (2026-11-12)

The daemon half of what the shell window's terminals need (`shell-model.md`, "Terminals";
`shell-plan.md` 2.10 and PR 5). Additive: the classic window and its bottom panel work as
before. Nothing here touches the layout (PRs 1-4); PR 6 wires the two together.

## What changed

- **Labels** (`internal/termlabel`): `Free()` / `IsFree` (kind `shell`, no thread, project or
  worktree), `QuickShell` / `IsQuick` (`slot=quick` on a thread's shell), and `Replaces`
  (`replaces=<old id>` on a shell `terminal.reset` started). Documented on `Terminal.labels`.
- **Facts** (`internal/store/terminal/facts.go`, `proc.go`): `Terminal.LiveCwd`, `Foreground`,
  `LastCommand`; proto `live_cwd = 13`, `foreground = 14`, `last_command = 15`, published with
  `TerminalUpdated` through the same per-terminal throttle as the title.
- **Reaper** (`internal/daemon/shells.go`): a free shell is its own case. It is removed when it
  exits, and the owner checks (worktree gone, project unregistered, thread removed, and the
  sweep's versions of them) skip it explicitly. Before this PR it would have been skipped only
  because its labels were empty.
- **Commands** (`commands_terminal_shell.go`, plus one flag on `terminal.new`):
  - `terminal.new-free [--argv] [--run]`: `$SHELL -l` in the home directory, labels `Free()`.
    `NoPalette` and no chord for now (below).
  - `terminal.new --quick`: needs a thread. Returns the thread's running quick terminal when
    there is one (`--run` then types into it), else starts one. A mutex shared with
    `terminal.reset` serializes the check and the start, so concurrent calls make one (tested
    with 8 at once).
  - `terminal.reset <id>`: a shell only. Starts a fresh shell with the old argv and size in the
    owner's directory (a thread's checkout as the thread has it now, so its project and
    worktree labels are refreshed; a worktree shell's worktree; home for a free shell), keeps
    the labels (a quick terminal stays quick), adds `replaces=<old>`, then closes the old one.
    Start first, close second, so a tab can move to the new id before the old one's
    `removed_id` arrives. A failed close returns an error that names the new terminal.
  - `terminal.rerun <id> [--command]`: types the last command (or `--command`) with the same
    path as `terminal.new --run` (waits for the prompt, bracketed paste when on). Refused while
    something is in the foreground, when there is no last command, when the line was cut, and
    on an exited or non-shell terminal. `Page` is PageRuns (it runs a program).
  - `terminal.list` shows the live directory and a RUNNING column.
- **Mock** (`gui/frontend/mock/world.ts`): `terminal.new-free`, and `live_cwd` (= cwd) on every
  mock terminal. The plan named `mock/shells.ts`, but that file is Claude's background shells;
  the terminal mock lives in `world.ts`.
- **Plugin skill**: `host-commands.md` was already within a few bytes of its 32 KiB read budget
  and these three verbs pushed it over, so the Thread and View categories moved to a new
  generated `host-commands-thread-view.md` (SKILL.md, manifest.md and host-api.md point at both).

## How the facts are read, and what it costs

- **Directory**: the `proc_info` system call (number 336, `PROC_PIDVNODEPATHINFO`), which is what
  libproc's `proc_pidinfo` wraps, on the terminal's main pid. No cgo: `unix.Syscall6`, and the
  struct offsets (path at byte 152 of a 2352-byte `proc_vnodepathinfo`) are pinned by a test
  against `os.Getwd` and a child started in a known directory. ~2 µs.
- **Foreground**: `TIOCGPGRP` on the PTY master (the existing `foregroundGroup`). When the group
  is the main process's own, nothing runs (the shell is at its prompt). Otherwise the group
  leader's argv from `kern.procargs2`, quoted for a shell; if the leader is gone, the oldest
  member's; if the arguments cannot be read (a root process such as sudo), its short name from
  `kern.proc.pgrp`. A job-control shell makes a pipeline's first process the leader, so
  `git log | less` shows `git log`. ~13 µs.
- **Last command**: a foreground command that ends, or gives way to another job, becomes
  `last_command`. When the shell exits with a job in the foreground, that job is the last command.
- **When**: 200 ms after output (at most once per 200 ms while output keeps coming, so `yes`
  costs five samples a second), then again 1 s and 4 s later if the terminal stays quiet, then
  nothing until the next output. A prompt follows every command and every `cd`, so output is the
  signal; the quiet rechecks catch a job that started after the echo of Enter, or ended without
  printing. An idle terminal costs nothing. Everything runs on the terminal's actor, which owns
  the master; no goroutine, no process, no busy loop. `Options.FactsDelay` and `FactsRecheck`
  tune it (tests use short ladders).
- **Cut lines**: a command line over 4 KiB is cut and ends in "…". Quoting puts any non-ASCII
  argument in single quotes, so only a cut line can end in a bare "…"; `terminal.rerun` refuses it.

## Decisions

- **No shell integration**, as the spec says: no OSC 7, no prompt hooks. A shell function or a
  builtin never shows as foreground; an alias shows as what it expands to.
- **The live directory is the main process's.** In a nested shell (`bash` typed into zsh) the
  inner shell is the foreground job and its `cd` does not move `live_cwd`. Good enough for the
  hint; noted for PR 13.
- **The store stays program-agnostic**: every terminal gets facts (action runs and plugin
  terminals too). A program that does not hand the terminal to a job (`sh -c`, an action run)
  never has a foreground.
- **`terminal.new-free` is unlisted** (`NoPalette`) until the shell window shows free shells.
  The classic window's bottom panel files a shell without a thread under the Projects page
  (`ownerKeyOf`), so a free shell started from the CLI shows there, named after the home
  folder; started from the palette inside a thread it would have appeared nowhere visible.
- **The quick slot is a label plus a check in the command**, not a store rule:
  `TerminalService.Create` with those labels could still make a second one. The commands are
  the only creators.
- **Reset follows the thread**: a thread moved to another checkout resets into the new one.

## Gotchas

- staticcheck marks `unix.SYS_PROC_INFO` deprecated (SA1019): x/sys wants libSystem wrappers
  on darwin, and the wrapper, libproc's `proc_pidinfo`, needs cgo. The call carries the repo's
  first `//lint:ignore`, with the reason; `TestCwdOf` pins the syscall's behaviour.
- A forked child shows its parent's argv in `kern.procargs2` until it has exec'd. The group
  fallback test waits for the member to become `sleep` rather than reading once.
- A plain `go test` or `go build` of the terminal store needs `PKG_CONFIG_PATH` (and the macOS
  deployment target) for libghostty-vt; the Makefile exports both.
- `terminal.rerun` and `terminal.reset` look the terminal up with `List`, so `TerminalBackend`
  did not grow a `Get`.
- A shell closed by `terminal.reset` exits with code 1 (zsh on SIGHUP): expected.

## End to end (scratch `CODE_FOUNDRY_HOME=$(mktemp -d)`, `make build`, `code-foundry daemon --dev`)

```
$ code-foundry terminal new-free
created terminal t-2eddb25cb45d in /Users/alex
$ code-foundry thread new --no-project --name "shell-5 e2e" --focus=false --created-by=
created thread shell-5 e2e (s-c9af8fdbe40f) in /Users/alex (no project)
$ code-foundry terminal new --quick --context-thread s-c9af8fdbe40f
created thread s-c9af8fdbe40f's quick terminal t-74b4913ad881
$ code-foundry terminal new --quick --context-thread s-c9af8fdbe40f
thread s-c9af8fdbe40f's quick terminal is t-74b4913ad881
$ code-foundry terminal list
ID              STATE    CWD          RUNNING  LABELS
t-2eddb25cb45d  running  /Users/alex  -        kind=shell
t-74b4913ad881  running  /Users/alex  -        kind=shell project= slot=quick thread=s-c9af8fdbe40f worktree=/Users/alex
$ code-foundry terminal rerun t-74b4913ad881 --command "cd /private/tmp/cf-shell5-e2e"
ran cd /private/tmp/cf-shell5-e2e in terminal t-74b4913ad881
$ code-foundry terminal rerun t-74b4913ad881 --command "sleep 30"
ran sleep 30 in terminal t-74b4913ad881
$ code-foundry terminal rerun t-2eddb25cb45d --command "cd /usr/share && tail -f /dev/null"
ran cd /usr/share && tail -f /dev/null in terminal t-2eddb25cb45d
$ code-foundry terminal list
ID              STATE    CWD                         RUNNING            LABELS
t-2eddb25cb45d  running  /usr/share                  tail -f /dev/null  kind=shell
t-74b4913ad881  running  /private/tmp/cf-shell5-e2e  sleep 30           kind=shell project= slot=quick thread=s-c9af8fdbe40f worktree=/Users/alex
$ code-foundry terminal rerun t-74b4913ad881
code-foundry terminal.rerun: terminal t-74b4913ad881 is running sleep 30; run it again once that has ended
# 30 s later
$ code-foundry terminal list --json   (the facts of each terminal)
t-2eddb25cb45d {'cwd': '/Users/alex', 'liveCwd': '/usr/share', 'foreground': 'tail -f /dev/null', 'lastCommand': None}
t-74b4913ad881 {'cwd': '/Users/alex', 'liveCwd': '/private/tmp/cf-shell5-e2e', 'foreground': None, 'lastCommand': 'sleep 30'}
$ code-foundry terminal rerun t-74b4913ad881
ran sleep 30 in terminal t-74b4913ad881
$ code-foundry terminal list
t-74b4913ad881  running  /private/tmp/cf-shell5-e2e  sleep 30           kind=shell project= slot=quick ...
$ code-foundry terminal reset t-74b4913ad881
reset terminal t-74b4913ad881: t-180b4e9e9e2d starts in /Users/alex
$ code-foundry terminal new --quick --context-thread s-c9af8fdbe40f
thread s-c9af8fdbe40f's quick terminal is t-180b4e9e9e2d
$ code-foundry terminal list
ID              STATE    CWD          RUNNING            LABELS
t-2eddb25cb45d  running  /usr/share   tail -f /dev/null  kind=shell
t-180b4e9e9e2d  running  /Users/alex  -                  kind=shell project= replaces=t-74b4913ad881 slot=quick thread=s-c9af8fdbe40f worktree=/Users/alex
$ code-foundry thread remove s-c9af8fdbe40f --yes
removed thread s-c9af8fdbe40f
$ code-foundry terminal list          (the quick shell went with its thread; the free one stays)
t-2eddb25cb45d  running  /usr/share   tail -f /dev/null  kind=shell
$ code-foundry terminal close t-2eddb25cb45d
closed terminal t-2eddb25cb45d
```

`code-foundry events --source terminal --json` over the same run (trimmed to the facts):

```
t-74b4913ad881  liveCwd /Users/alex
t-74b4913ad881  liveCwd /private/tmp/cf-shell5-e2e                                   seq 1
t-74b4913ad881  liveCwd /private/tmp/cf-shell5-e2e  foreground "sleep 30"            seq 2
t-2eddb25cb45d  liveCwd /usr/share  foreground "tail -f /dev/null"                    seq 3
t-74b4913ad881  liveCwd /private/tmp/cf-shell5-e2e  lastCommand "sleep 30"           seq 5
t-74b4913ad881  foreground "sleep 30"  lastCommand "sleep 30"                         (Run again)
t-180b4e9e9e2d  labels replaces=t-74b4913ad881 slot=quick  liveCwd /Users/alex       seq 7
t-74b4913ad881  EXITED, then removedId                                                seq 8-9
```

No warnings or errors in the daemon log.

## Version windows

New proto fields: an older GUI ignores them, and an older daemon leaves them empty. The GUI's
view model (`src/api/terminal.ts`) does not map them yet, so a facts update changes nothing on
screen and `sameTerminal` keeps the old object (no re-render).

## For later PRs

- **PR 6** (lifecycle glue): move a tab to the terminal whose `replaces` names its terminal; end
  a free shell when its tab closes (`terminal.close`); build `terminal.quick` / `terminal.cycle`
  on `terminal.new --quick`; record `foreground`, else `last_command`, as a terminal tab's `ran`
  before a snooze removes the shells, and restore with a fresh shell plus `terminal.rerun
  --command <ran>` only when the user clicks Run again.
- **PR 13** (terminal tabs, quick terminal): map `live_cwd`, `foreground`, `last_command` in
  `src/api/terminal.ts` and add them to `sameTerminal`; the names (`lib/terminalName.ts`); the
  Reset hint when `live_cwd` is not the thread's directory; drop `NoPalette` from
  `terminal.new-free` and map cmd+shift+t to it in `src/shell/keys.ts`.
- **PR 21** (classic panels removed): the Projects-page fallback that shows a free shell in the
  classic bottom panel goes with it.
- **PR 4** and later verbs: a command lands in `host-commands.md` or
  `host-commands-thread-view.md` by its category; if either nears 32 KiB, split by category again
  (`hostSplitCategories` in `internal/skills/plugin.go`).
