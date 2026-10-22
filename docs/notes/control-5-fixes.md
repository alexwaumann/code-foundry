# Control fixes after testing (2026-10-22)

Testers ran control-1 (thread-scoped panel verbs, ui.presence) and control-4
(daemon.capabilities) against a live daemon and GUI. This PR fixes what they found and
adds three panel verbs that open one item. Daemon, CLI, GUI and mock; a proto change.

## What changed

- **Windows, not receivers.** `bus.Publish` counts subscriptions, and the events hub
  shares one subscription between every `EventService.Watch` stream, so a CLI
  `events --source ui` stream or a plugin made `delivered=1` with no window open. The
  `Emitter` interface gained `Windows()` (`BusEmitter.CountWindows` is
  `api.Clients.Windows`, already behind ui.presence). `EmitResult` is now
  `{windows, receivers}` (`delivered` renamed to what it was), `PanelResult` adds
  `windows`. Every ui.* and view.* verb, and thread.focus, theme.pick,
  thread.agent.open/up, notifications.test and plugin show verbs, report windows; with
  none the message is "no app window is open: nothing was shown" (exit 0, JSON still
  out). The comment on `uiSource` said the count was of windows; it now says why not.
- **Unscoped verbs answer from the CLI.** `EmitResult.CLIResult`: a message (`windows=N`
  or the no-window one) when `ActiveView` is empty; none from the app, which toasts
  non-empty messages.
- **`focused`** is set only with `--focus` and a window open. The FocusThread it sends
  has a new `explicit` field; the GUI selects the thread even when it is a hidden child
  created under 10 s ago (`threadFocus`'s skip rule is for thread.new's own focus, not
  for a user's request).
- **Empty surfaces refuse** (FailedPrecondition, scoped calls only): linked-prs without
  links ("thread s-… has no linked pull requests yet"), agents without runs, threads
  without lineage (no creator and no child; children found with `ThreadService.List`
  filtered by `created_by`). Checks are `panelCheck`s, the old `panelPlace` generalised
  to also return the ShowView's params.
- **Page verbs only show.** A ShowView of settings or usage used to toggle, so
  `view.usage` closed an open Usage page. `showView` now only shows (settings keeps the
  page it is on); the window's own cmd+, and sidebar buttons go through `toggleView`.
- **Page verbs from an unwatched thread refuse.** view.dashboard, usage, pullrequests,
  projects, settings and help take `--focus`. From a thread's CLI (`CallerThreadID` set,
  `ActiveView` empty) while no window views that thread (`Manager.Viewed`), they refuse:
  "the user is looking at something else; pass --focus to take them there anyway".
  With no window open there is nothing to take over: no refusal, the no-window message.
  The app and the CLI outside a thread are unchanged. view.settings and view.help moved
  from RegisterSettings to RegisterView (now `ViewDeps`) to share this.
- **ui.presence** checks `--thread` exists (`PresenceDeps.Thread`, set by all.Register).
  A viewed thread while no window is visible reads "viewed (a window has it open; the
  window is hidden or covered)"; the State doc says background covers fully covered
  windows and foreground means at least partly visible but unfocused.
- **New item verbs** (`commands_view_items.go`), always scoped (in the app the selection
  is the thread), NoKeybinding, with `--thread` and `--focus`:
  - `view.panel.file <path> [--line N]`: ReadFile with the thread's checkout as base
    (under home only, symlinks followed); not found and directories refuse. Params
    path (absolute), line, project, base.
  - `view.panel.diff <path> [--scope working|branch]`: the thread must run in a project
    worktree holding the path; GetWorktreeFileDiff must find changes (status not "").
    Params project, worktree, path (relative), scope.
  - `view.panel.pr <number>`: a number the thread links names that link's repository
    (two repositories: an arg error), else the thread's project's GitHub repository;
    GhService.GetPullRequest (cache, else GitHub) must find it. Params slug, number.
  `UiIntent.ShowView` gained `map<string,string> params`; `threadPanelIntent.ts` has an
  entry per verb over `openFileInPanel`, `openDiffInPanel` and `openPullRequestInPanel`
  (which gained an optional target).
- **usage.show** defaults to the caller's thread (`--thread` is ContextThread); `--all`
  is every thread plus removed ones, also inside a thread.
- **Tip source refs** are the commit: release.yml keeps five tip releases and deletes
  older tags, so `/tree/vX.Y.Z-tip.N` links died within a day. Stable tags unchanged; a
  tip with no known commit still uses its tag; the version stays in the provenance text.
- **Capabilities text:** the commands group no longer claims every button is a command
  (Copy, Cite, a path chip's click and the Diff and Pull request tabs' controls have
  none); pages says page verbs move every window, the refusal rule, and that Ember and
  Themes (theme.pick) have no view verb; panel parses a surface's description after its
  first ": " outside parentheses (descriptions now say "in a thread's side panel (from a
  thread: its own; in the app: the selected one): …") and describes the item verbs,
  path chips and interactive .html; skills says it is not the thread's full list;
  rendering's images, html and file tab rows are corrected. The CLI hints
  `--group pages` for `daemon.capabilities pages` (any stray word that is a value of
  exactly one enum flag). The settings `projects` group description covers the group.

## Decisions

- **`--scope` instead of `--base`** for view.panel.diff: both of the Diff tab's scopes
  compare against the branch's base (working: the file on disk; branch: HEAD), so
  `--base` would not say which. The flag uses the Diff tab's own words.
- **receivers kept** in the JSON under its true name: tests and debugging use it, and
  `windows` sits next to it.
- **Item verbs always scope** (no unscoped form): a file or pull request belongs to a
  thread. From the palette they open in the selected thread.
- **The page-verb refusal needs a window open.** Without one nothing would move.
- **thread.focus is not explicit**: it keeps the hidden-child rule; only `--focus` on
  panel verbs is the user's request.

## Left out

- `--thread` by unique thread name (optional item): every ThreadID arg resolves by
  suffix in one place, and names are not unique or stable; not cheap.
- The plugin skill's host-api.md says plugin asks answer `delivered: <windows>`; that
  count is receivers. Skill files were out of scope here.

## Gotchas

- The CLI prints a connect error's message, not a wrapped Go error's text: the
  view.panel.pr check rebuilds the connect error to name the pull request.
- `Path` args must be absolute by the time they reach the daemon (the CLI resolves
  relative ones against its own directory), so the item verbs never see a relative path.
- e2e/usage-page.spec.ts asserted the CLI's ShowView toggled; it now asserts it shows.

## End to end (2026-10-22, isolated home)

`make gui-build`; daemon and GUI with `CODE_FOUNDRY_HOME=/tmp/cf-ctl5` and the CLAUDE*
variables unset; a local clone of this repository under home registered (origin set to
GitHub, README.md edited); threads "ctl5 viewer" and "ctl5 model". From the model
thread's shell (`CODE_FOUNDRY_THREAD` set), first with no window and a CLI events
stream running:

```
$ code-foundry view.panel.file README.md --json
{"windows":0,"receivers":1,"thread":"s-303536408b01"}
$ code-foundry view.projects
no app window is open: nothing was shown
$ code-foundry ui.presence --thread s-000000000000
code-foundry ui.presence: thread not found: s-000000000000          (exit 2)
$ code-foundry view.panel.linked-prs
… thread s-303536408b01 has no linked pull requests yet              (exit 2)
$ code-foundry view.panel.threads
… has no related threads: no thread created it and it created none   (exit 2)
$ code-foundry view.panel.diff internal/version/source.go
… has no changes in thread s-303536408b01's worktree (… against the file on disk)
$ code-foundry view.panel.pr 999999
… (not found on GitHub)                                              (exit 2)
$ code-foundry usage.show
Thread s-303536408b01 (ctl5 model): 0 requests · 0 tokens · $0.00
$ code-foundry daemon.capabilities pages
… unexpected arguments [pages] (did you mean --group pages?)
```

Then with the GUI open on the viewer thread:

```
$ code-foundry view.projects
code-foundry view.projects: the user is looking at something else; pass --focus to take them there anyway
$ code-foundry view.projects --focus
windows=1                                  (the window moved to Projects)
$ code-foundry view.panel.file README.md --line 3
windows=1 thread=s-303536408b01            (the window stayed on the viewer)
$ code-foundry view.panel.diff README.md
$ code-foundry view.panel.pr 312
```

Opening the model thread showed the three tabs (File rendered, Diff with the added
lines on the working tree, #312 merged with its description). A child created by the
model thread (hidden) was selected at once by `view.panel.usage --thread <child>
--focus`, and the model's `view.panel.threads` then opened. No ERROR lines in the
daemon log (one WARN: the scratch clone's branch is not on origin). The threads were
archived (resetting their panel entries) and removed, the daemon stopped, and the home
and clone deleted.

## Daemon restart

Needed: new commands and args, changed results, and a proto field the GUI reads. The GUI
and daemon ship together.
