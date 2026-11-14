# Threads and terminals of its own

{{cf.provenance}}

## The nodes

```go
ui.Node{Key: "helper", Thread: &ui.Thread{ThreadID: id, Placeholder: "Ask about this run", Height: ui.HeightFill}}
ui.Node{Key: "shell", Terminal: &ui.Terminal{TerminalID: id, Title: "test run", Height: ui.HeightPx(320),
	Actions: []ui.Button{ui.EventButton("rerun", "Rerun", "rerun")}}}
```

The plugin's own Claude thread (`h.CreateThread`, permission `threads`) drawn inline with
the host's thread view and composer (`readOnly: true` leaves the composer out), or its own
terminal (`h.CreateTerminal`, permission `terminals`) with the host's terminal view, an
"Open in a tab" button (it moves the terminal to a terminal tab, and the node steps aside
while that tab shows it) and up to 2 buttons of yours. `height` is `"auto"` (the
default: about 420 px for a thread, `rows` text rows (4..60, default 16) for a terminal),
`"fill"` (the rest of its box: the surface's body, or the pane node around it, `reference/ui-layout.md`;
at least 240 px) or pixels (120..1600). A view naming
another owner's thread or terminal is refused; one that is gone (removed, closed) shows a
muted empty state; an archived thread still renders, composer included, with no archived
cue (`SendThread` unarchives it), so drop its node when you archive it. Each one holds a
live stream while it is on screen in the active tab. A view draws each thread or terminal
once: a later node naming the same id shows only "Shown above".
Check `h.HasCapability("view.node.thread")` (`view.node.terminal`) before relying on
them; the calls that make them are below.

## The calls (permissions `threads`, `terminals`)

```go
// A skill for the thread: Claude Code loads <add-dir>/.claude/skills/<skill>/SKILL.md.
skillDir := filepath.Join(h.DataDir(), "claude")
_ = os.MkdirAll(filepath.Join(skillDir, ".claude", "skills", "deploy-helper"), 0o755)
_ = os.WriteFile(filepath.Join(skillDir, ".claude", "skills", "deploy-helper", "SKILL.md"), skillMD, 0o644)
id, err := h.CreateThread(ctx, pluginsdk.ThreadCreateParams{Title: "Deploy helper",
	AddDirs: []string{skillDir}, Env: map[string]string{"DEPLOYBOT_URL": url}})
err = h.SendThread(ctx, id, "Summarize the last failed deploy in one line.")
term, err := h.CreateTerminal(ctx, pluginsdk.TerminalCreateParams{Argv: []string{"make", "test"}, Title: "tests"})
```

`CreateThread` makes a Claude thread the plugin owns: hidden from the sidebar, `thread
list`, attention counts and the dock (`code-foundry plugin threads <name>` lists them),
shown by a `thread` node. `Cwd` defaults to the plugin's data dir (with `ProjectID`, the
project's main worktree; a `cwd` must be under home); `Env` and `AddDirs` follow the
session environment's rules, but a bad one refuses the call, and they replace the
plugin's own session environment for this thread; `Model` and `Effort` default to the
user's settings (`Model` a model id, `Effort` `low` … `max`: the values `code-foundry help
thread.new` lists for `--model` and `--effort`); `PermissionMode` is `supervised`,
`accept-edits` or `auto` (`--permission`'s values; default Claude's own, which asks);
`Prompt` is an optional first message.
An `AddDirs` entry (here or in `SetEnvironment`) is a directory Claude Code may read and
loads skills from: a skill is `<dir>/.claude/skills/<skill>/SKILL.md` (with `name` and
`description` front matter), as above; `<dir>` itself is passed. It runs like any thread: a
message starts its Claude, which stops at cache expiry, and it costs what it costs (the
Usage page counts it). `SendThread` and `ArchiveThread` reach only the plugin's own
threads (-32004 otherwise; an archived thread's node still renders,
so drop it from the view); `Threads` lists them. To write to the
user's thread, `Invoke` `thread.send` with the id from `act.Context`. `CreateTerminal`
starts a terminal the plugin owns (cwd the data dir unless given, under home; env checked
like a thread's; `$SHELL -lc` for the user's tools), shown by a `terminal` node and, on
request, in a terminal tab; `CloseTerminal` and `Terminals` as for threads, and an exited
terminal stays until closed. At most 32 live threads and 16 terminals. Disabling the
plugin archives its threads (enabling it again finds them with `Threads`; a send
unarchives one) and closes its terminals. Uninstalling it (with or without `--purge`), or
another source taking its name with `--force`, removes its threads for good, as `thread
remove` does (Claude stops first; the user is told how many), and closes its terminals.
Terminals end with the daemon, threads do not (find them again with `Threads` in Init).
plugintest keeps both
in memory (`CreatedThreads`, `ThreadSends`, `PluginTerminals`, `ExitTerminal`,
`SetTerminalText`).

A terminal's output is readable: `h.ReadTerminal(ctx, id, maxBytes)` returns the text on
its screen, plain (no escape sequences), one line per row with trailing spaces trimmed:
the rows the terminal shows (24 by default, more when a viewer made it taller), not the
scrollback above them, and at most `maxBytes` of it (0: 64 KiB, at most 256 KiB; its end,
from a line start, with `Truncated`). Blank rows below the text are dropped and no read
ends with a newline; `Lines` counts the text's lines (a host before pluginsdk v0.2.1
sets it with the scrollback only, and its screen text may end with a newline). When its process exits the plugin gets
`terminal/exited` `{terminalId, exitCode}` (`Plugin.OnTerminalExit`; 128+n when signal n
killed it), once; read the screen then rather than polling `Terminals`. For a run whose
whole output matters, read it with the scrollback:
`h.ReadTerminalWith(ctx, id, pluginsdk.ReadTerminalOptions{Scrollback: true})` returns
everything the terminal kept, the scrollback then the screen, oldest line first, plain
like the screen but with a soft-wrapped line as one line, and `Lines`, how many lines
that is; at most `MaxBytes` (0 and at most: 1 MiB), its end from a line start with
`Truncated` when longer. A terminal keeps its last 30,000 rows (the user's *Scrollback
rows* setting, 1,000 to 100,000; a full-screen program on the alternate screen has none),
so there is no need to `tee` or `script(1)` the run into a file; do that only for output
beyond those bounds. Check `h.HasCapability("terminal.scrollback")` first: an older
Code Foundry ignores `Scrollback` and answers the screen. plugintest answers it with
`SetTerminalScrollback` and records every read (`TerminalReads`).
