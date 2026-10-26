# Palette: NoPalette commands

The palette listed every command the daemon made available in the context, about 180
of 199, minus a frontend set (`paletteHidden`: thread.agent.open, thread.reseed) and an
`ember.` prefix test. Half of those are not things a person picks from a palette.

## Decision

`Command.NoPalette` (Go) → `Command.no_palette` (proto) → `CommandView.noPalette`.
`inPalette` in `keys/bindings.ts` is now "startable here and not noPalette". The
frontend set and the prefix test are gone. The registry owns the rule, like
`NoKeybinding` and `ReadOnly`, and `internal/command/palette_test.go` pins the list so
a new verb is a decision (unlisted by default; a verb is listed unless marked).

Three tests put a verb on the list:

- a query whose only output is a text toast (every ReadOnly listing, thread.get,
  settings.get, usage.show): the GUI shows the same thing in a panel or a page;
- a verb for the model or the CLI to drive the app (ui.notify, ui.focus.*,
  ui.palette.open, view.open.url, view.inline, view.panel.file/diff/pr, thread.respond,
  thread.report, thread.focus, thread.subscribe, thread.send, thread.label,
  settings.set, memory.add, theme.save, plugin.act, action.stop) and Ember's board;
- a verb whose required arg is an opaque id the palette can only take as typed text,
  while a page offers the action on the right row: pr.* with a repo slug and number
  (pr.create and pr.open stay, their worktree defaults from the context), plugin.* and
  skill.* by name, action.run/edit/remove by id, thread.mcp-reconnect by server,
  project.branch.delete, workspace.remove/add-project/remove-project/set-primary.

Kept: anything with a presenter, a chord, an enum pick list or no prompt, and a
required id that defaults from the context (the API already sends such an arg as not
required, so thread.fork or terminal.kill run in one Enter). Judgment calls:
thread.interrupt stays for the keyboard; thread.budget is an Ember and agent knob, so it
is out; thread.workspace is out because the palette would run it with no workspace and
clear the thread's; workspace.set-root stays (a path, with completion).

114 commands are marked; about 85 remain listed.

## Gotchas

- The mock daemon's `CmdDef` (and `gitops.ts`'s `Spec`) got the same optional field,
  set on the mock's copies of the marked verbs, so the e2e palette matches the daemon.
- `NoKeybinding` is not in the proto; `NoPalette` is, because the palette is a client.
- The CLI, pages (bridge) and chords see no change: the flag is a listing hint only.
