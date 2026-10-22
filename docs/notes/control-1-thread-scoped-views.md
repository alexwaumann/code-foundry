# Thread-scoped panel verbs and ui.presence (2026-10-22)

A user asked for the model in a thread to be able to show things in the app without
taking over what they are looking at. Before this, every `view.panel.*` verb emitted
`UiIntent.ShowView{name}` to every window, and each window applied it to whatever it had
selected: a model that ran `code-foundry view.panel.worktree` opened the worktree tab in
the user's current thread, not its own. Now the model can open a surface in its own
thread's side panel, and find out first whether the user is watching. Daemon, CLI, GUI
and the help skill; no visible chrome change.

## Behaviour

- `UiIntent.ShowView` has an optional `thread_id`. Set, a window applies the panel action
  to that thread's panel entry (`thread:<id>` in `stores/panel.ts`) and never changes its
  selection: with the thread selected the change shows at once, otherwise the tab is
  there when the user opens the thread. Empty, nothing changed.
- Every panel verb (`view.panel.toggle`, `expand`, `new-tab`, `split`, `workspace`,
  `linked-prs`, `usage`, `mcp`, `agents`, `threads`, `worktree`) takes `--thread` (String,
  ContextThread, ThreadID; defaults to the caller's thread) and `--focus` (Bool).
- `--focus` emits the existing `FocusThread` for the thread before the ShowView. Default
  off.
- `ui.presence` (View, NoKeybinding) reports `state` (`presence.State.String()`: none,
  background, foreground, foreground+attended), `attended`, `windows` and `viewed` for
  the caller's thread or `--thread`; text and `--json`.
- The help skill's `reference/commands.md` gains the View category, and its SKILL.md a
  "Showing things in the app" section (9 lines).

## Decisions

- **When a call is scoped.** `panelThread` (internal/command/commands_view_thread.go):
  the `--thread` value when the CLI sent the call (`ActiveView` is empty only there) or
  the caller passed `--thread` explicitly (`Args.Given`); otherwise "". The GUI's palette
  and keybindings send the selection as the context, so the context-defaulted arg would
  name the selected thread; scoping those would change multi-window behaviour (another
  window would act on this window's thread instead of its own selection), so they stay
  unscoped. The CLI outside a thread has no `--context-thread`, so it is unscoped too,
  as before. A CLI call with `--context-thread` but no `$CODE_FOUNDRY_THREAD` is scoped:
  it names the thread just as explicitly.
- **Every scoped call reads its thread** (`ThreadService.Get`): an unknown thread fails
  with NotFound and nothing is emitted. `view.panel.workspace` refuses a thread in no
  workspace and `view.panel.worktree` one with no project or worktree path
  (FailedPrecondition, "thread s-… is in no workspace"). `RegisterView` takes a
  `ThreadGetter` for this; `McpBackend` embeds it (the real thread API has it already).
- **Availability from the CLI.** `view.panel.workspace` and `view.panel.worktree` were
  only available with the thread's placement in the context (`--context-workspace`,
  `--context-project` plus `--context-worktree`), which a thread's CLI never sends. Their
  `When` now also accepts a CLI call that names a thread (`cliThread`); Run checks the
  placement instead, like `hasThreadOrCLI` commands do. So `code-foundry commands` inside
  any thread lists both as available.
- **Results.** An unscoped call answers as before (`EmitResult`, no message: the GUI
  toasts non-empty messages). A scoped call answers `PanelResult{delivered, thread,
  focused}`, and from the CLI also the message `delivered=N thread=s-…`.
- **`--focus` without a thread** is an arg error from the CLI ("needs a thread to
  select"); in the app the selection is the target already, so it is ignored there.
- **The GUI side** is `stores/threadPanelIntent.ts`: a registry from ShowView name to an
  action on a thread's panel key, reusing the surfaces' `open*Surface(sel)` helpers with
  a thread selection. Unlike the window's own commands (`stores/views.ts`) a scoped
  action never requests keyboard focus (the user may be typing in another thread's
  prompt), never toasts ("No linked PRs yet" about a thread the user is not looking at
  would puzzle them), applies while the settings or usage page is up (it changes the
  thread's panel, not the screen), and does not drop a pending focusThread/focusTerminal
  (the window does not move). A name that is no panel action, or a thread the window
  does not know, is ignored rather than applied to the selection.
- **`viewed`** is the thread store's viewer count (`Manager.Viewed`, a read-only accessor
  over the existing `viewers` map): a GUI view holds the thread's `WatchThread` stream,
  in any window, attended or not. `windows` is the GUI client registry's stream count
  (`api.Clients.Windows`); CLI `events` streams are not counted. Both come into the
  command deps from internal/daemon next to `pres.Current`, the source the thread store's
  `Options.Attended` reads.
- **The skill** tells the model to check `ui.presence --json`, open directly only when
  `viewed` and no saved preference (`memory add`, control-3) says not to, otherwise say
  it in the reply or `ui.notify`, and never pass `--focus` unasked. One paragraph, not
  numbered steps: the file sits at 119 of its 120-line cap after the app memory section
  landed on main. The description is unchanged: it is at 387 of its 400 characters, and
  "or before you open something in the app's side panel" did not fit. The View category
  is one line per command (not detailed): the SKILL.md section carries the flags. The
  orchestrate skill is unchanged.

## Gotchas

- `delivered` counts the windows (and `code-foundry events --source ui` streams) that
  received the intent, not that it did anything: a surface with nothing to show (Linked
  PRs without links, Agents without runs, Threads without lineage, Worktree for a thread
  the window places in no worktree) is a silent no-op in the window.
- Panel state lives in the GUI (persisted localStorage), not the daemon. With no window
  connected (`windows: 0`) a scoped intent reaches nobody and nothing waits for later.
- `panel.toggle`, `panel.expand` and `panel.split` flip state the model cannot see; the
  skill only names surfaces.
- `--focus` reuses `FocusThread`'s rules (lib/inSidebar.ts `threadFocus`): a hidden child
  thread created less than 10 s ago is not selected.
- The mock daemon's panel verbs take the same args (`mock/panelVerbs.ts`); it only sees
  the app's calls, so a passed `thread` counts as explicit.
- `make gui-e2e`: `e2e/skills.spec.ts` "the settings search finds the Skills page's
  sections" fails on main already (its expected Registries description differs from
  `guiPages.ts`); not touched here.

## End to end (2026-10-22, isolated home)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-ctl1 bin/code-foundry daemon --dev` with the
`CLAUDE*` variables unset; a non-git scratch folder `~/cf-scratch-ctl1` registered;
`code-foundry events --source ui --json` running; a thread "ctl e2e" (s-a141d3855c33)
created without a prompt. With `CODE_FOUNDRY_THREAD=s-a141d3855c33`:

```
$ code-foundry view.panel.worktree
delivered=1 thread=s-a141d3855c33
$ code-foundry view.panel.usage --focus --json
{"delivered":1,"thread":"s-a141d3855c33","focused":true}
$ code-foundry ui.presence --json
{"state":"none","attended":false,"windows":0,"thread":"s-a141d3855c33","viewed":false}
$ code-foundry view.panel.workspace
code-foundry view.panel.workspace: thread s-a141d3855c33 is in no workspace   (exit 2)
$ CODE_FOUNDRY_THREAD= code-foundry view.panel.toggle --json
{"delivered":1}
$ CODE_FOUNDRY_THREAD= code-foundry view.panel.toggle --focus
code-foundry view.panel.toggle: needs a thread to select (--thread, or run it inside a thread)   (exit 2)
$ code-foundry view.panel.usage --thread s-000000000000
code-foundry view.panel.usage: thread not found: s-000000000000   (exit 2)
```

The events stream:

```
{"ui":{"showView":{"name":"panel.worktree", "threadId":"s-a141d3855c33"}}, "seq":"5", …}
{"ui":{"focusThread":{"threadId":"s-a141d3855c33"}}, "seq":"7", …}
{"ui":{"showView":{"name":"panel.usage", "threadId":"s-a141d3855c33"}}, "seq":"8", …}
{"ui":{"showView":{"name":"panel.toggle"}}, "seq":"9", …}
```

Then a throwaway Go client played a window (EventService.Watch as a GUI client, visible
and focused, plus WatchThread on s-a141d3855c33):

```
$ code-foundry ui.presence
presence: foreground+attended (the user is looking at the app)
windows: 1
thread s-a141d3855c33: viewed (a window shows it)
$ code-foundry ui.presence --thread 58c0d06a3138 --json      (a second thread, not watched)
{"state":"foreground+attended","attended":true,"windows":1,"thread":"s-58c0d06a3138","viewed":false}
$ CODE_FOUNDRY_THREAD= code-foundry ui.presence --json
{"state":"foreground+attended","attended":true,"windows":1,"viewed":false}
```

The window side is covered by `stores/threadPanelIntent.test.ts` and the mock e2e
`worktree-panel.spec.ts` ("a ShowView scoped to another thread … the tab waits there").
The daemon log had no WARN or ERROR lines. The threads were removed, the daemon stopped,
and the scratch folder and home deleted.

## Daemon restart

Needed: new commands and args, and the help skill is rewritten at daemon start. The GUI
and daemon ship together.
