# Page calls that run a program ask first (2026-11-07)

A page shown in the app can run scripts and reach the network, so its script is not trusted
the way the user is. `settings-user-only.md` covered settings. This covers the rest of the
registry: a page's call that runs a program, installs or runs code, or writes outside the
app's state now shows the user the call and "Asked by" first, and only a yes runs it.

## What changed

- **`Command.Page` (`PageClass`).** `PageRuns` asks, `PageDrives` is a verb that drives a
  Claude thread, `PageState` is the app's own state. `PageRuns` is the zero value, so a new
  verb asks until someone classifies it, and so does every plugin's own command, which
  nobody classifies. `ReadOnly` verbs never ask. `page_class_test.go` holds the lists: a
  verb on no list fails, as `readonly_test.go` does.
- **`ArgSpec.PageAsks`** is a flag that makes a verb safe without it run a program:
  `terminal.new`'s `argv` and `run`. A plain shell stays as it was.
- **`Command.PageDetail`** adds what the call alone does not show: `action.run`'s command
  line, `skill.setup`'s script.
- **The rule is in `Registry.Invoke`**, after `Confirm`, so a page's own script and the GUI
  cannot go round it, and it does not depend on the host's check that the user is in the
  page. The question is a `ConfirmError`, which the bridge host puts to the user as a
  guarded request (`settings-user-only.md`, "A page's question"): the same focus, wait,
  queue and limits, nothing of its own.
- **Who is asked: `Context.Untrusted`.** A page, and anything that did not say who it is.
  The GUI's controls send a view; the CLI now says it is one (`CALL_ORIGIN_CLI`). A call
  with neither gets `OriginUnknown` in `internal/api` (`callerContext`), and an origin the
  daemon does not know counts too. `pageAsks` and `pinToView` use the same test.
- **`plugin.act` from a page.** A button's command keeps the page's origin, so it meets its
  own class, and the yes to `plugin.act` is the yes to that command. An event runs the
  plugin's code, which no class covers, so it asks in Run. Both are pinned to the view, and
  to what was asked: the question binds `asked`, a digest of the branch (command or event),
  its target and its args, and a yes whose re-invoke comes to anything else runs nothing.
  Pinning replaces a nested command's own `Bind`; the host never passed that on through
  `plugin.act`, so nothing changes for that command.
- **A `Confirm` command from a page** keeps its own words and adds the call under them, with
  the same limit. A value that would draw lines of its own shows quoted in the words too,
  in `DynamicConfirm` text as well, since the value is replaced wherever it appears. The
  digest `BindConfirm` carries stays that of the command's own words, which is what a store
  compares. A second-stage question from `Run` is as it was.
- **`ui.palette.open` from a page** opens the palette empty: the palette takes the keyboard
  and Enter runs its first row, so what fills it is the user's to type.
  The other verbs that fill a control (`composer.stage`, `thread.new-like`'s composer
  prompt) lead to a message to Claude, which a page can send anyway.
- **The dialog.** Each key or pointer press or release restarts the 600 ms wait, so a run of
  presses never finds Allow on. Once on, a pointer press anywhere but the answers restarts
  it too. Keys do not, because Tab has to reach Allow. A guarded dialog's colours are plain
  values in `.cf-guarded` (`index.css`), the same in every theme. They are not slots, so no
  theme reaches them and the slot guards hold; the palette is the dark one on a light theme too.
- **The question** is the call in the CLI's words, every value `strconv.Quote`d, so a value
  cannot draw lines in the dialog and a control character shows as an escape; a flag passed
  as false shows as `--flag=false`. A call over
  800 characters is refused, not cut as `askValue` cuts a setting's value: what runs has to
  be all there, and 800 fits the dialog without scrolling.

## Decisions

- **Not `Command.Confirm`.** It lists `requires_confirmation`, which gives the verb `--yes`
  in the CLI and the agents' command index. The CLI and agents are as they were.
- **A plugin is not asked.** It runs as the user, with their consent, and can run a program
  without a verb. This matches `settings-user-only.md`.
- **The unknown caller is decided in `internal/api`, not the registry.** In process, a zero
  `Context` is the daemon's own call. On the wire, nothing from the app or the CLI has
  neither an origin nor a view.
- **Writes to git and GitHub ask** (`git.pull`, `git.push`, `pr.comment`, `pr.review` and the
  like): they leave the app, under the user's name.
- **`pr.ready` and `pr.draft` do not ask**: they are reversible and run nothing, so they are
  `PageState`.
- **`git.fetch` asks.** It can run what a repository's config names, and asking was simpler
  than running it with that config off.
- **`project.add-workspace` asks, and `project.add` asks when given a `path`** (`PageAsks`):
  adding a folder reads that repository's config. With no args `project.add` only opens the
  Add Project dialog, where the user picks. The welcome page's Add Project step uses that
  form and asks nothing.
- **`--check` is not told apart.** `plugin.update --check` and `skill.update --check` only
  list, but asking is harmless and a page has little use for them.
- **`settings.set`, `settings.reset`, `ember.enable` and `dictation.download` are
  `PageState`**: they ask in Run (`pageAsks`), in words of their own, and the user-only
  refusal has to come before any dialog.
- **`dictation.hold` is `PageState`**: the GUI host calls it with no context, and it opens
  a visible session. `dictation.start` asks.
- Verbs that destroy app state and have no `Confirm` (`action.remove`, `memory.remove`) are
  `PageState`: they run nothing, and a board with a remove button is what pages are for.

## Pages and skills

The pages skill says what asks and how often a page may ask, and `verbs.md` marks
`pr.ready`, `pr.draft` and `pr.auto-merge`. `examples.md` said a loop of `pr.merge` asks once
per PR; a page has one question open at a time, so it now says one button per PR. The other
examples in `internal/skills/files` and `docs/` still run: each verb they call was checked
against the lists. `welcome.html` asks only where `settings-user-only.md` says.

## Compatibility

- Needs a daemon restart.
- New GUI, old daemon: nothing changes until the restart.
- `plugin.act` from a page needs the host to pass `asked` on. Every GUI that passes `version`
  does: it merges all of `Bind`.
- Old GUI, new daemon: a page sends no origin and no view, so it is an unknown caller and
  gets the strict path, which replaces what `settings-user-only.md` says of this case.
- New CLI, a daemon with `settings-user-only.md` but not this: `CALL_ORIGIN_CLI` is an
  origin it does not know, so a plain CLI's change to a user-only setting is refused until
  the restart. Settings works.
- No on-disk change.

## The limit

As in `settings-user-only.md`: this stops a page, not a process of the user's that forges a
caller. The dialog is only as good as its reading: a user who presses Allow agrees.

Verbs that start a thread or send between threads do not ask, by decision, so a page can
reach Claude whatever this gate does. The gate is defence in depth, not a sealed boundary.

## Open

Known and not done here:

- The presence check while the pointer rests on a page.
- `dictation.hold`.
- An event's question does not show what is sent with it.
- `action.run` and `skill.setup`: what runs is read again after the question.
- Wide glyphs near the 800 limit.
- A page holding the focus.
- The question limit is per frame.
- `workspace.new --root`.
- `terminal.close`.
- `app.relaunch`.
- `thread.setup.retry`.
- The classes of `thread.fork` and `search.promote`.
- `skill.refresh`.
