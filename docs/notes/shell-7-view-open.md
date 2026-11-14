# Shell PR 7: view.open verbs place linked tabs; the panel item verbs alias them

Seventh PR of the shell stack (`docs/notes/shell-plan.md` section 4, plan section 2.9). The verbs
a model uses to show the user a thread's file, diff, pull request, page, images or MCP servers
are now `view.open.*`. Each one opens a tab linked to the thread in the daemon's layout through
`open_surface`, placed by the rules. When a tab with the same identity is open, it uses that
tab. The old `view.panel.<item>` names are aliases of the same command, kept for one stable
release.

Until the cutover every one of these verbs works in both windows. It applies the layout op, then
sends the classic window the same `ShowView` as before. The classic window ignores the layout,
so it sees one effect, as before. `thread.focus`, `ui.focus.terminal`, `view.pullrequests` and
`view.projects` work in both windows too. `view.thread-diff` is the "thread's diff, and back"
verb that cmd+shift+d will bind at the cutover. No chord changed.

## The verbs

| Old name | New name | What changed for a model |
| --- | --- | --- |
| `view.panel.file` | `view.open.file` | Opens a tab linked to the thread, beside it by the placement rules. The same path again uses the open tab. It never takes the user's focus from a thread; `--focus` does. `--pane` puts it in a pane. Args, checks and `--edit` are unchanged. |
| `view.panel.page` | `view.open.page` | The same, as a File tab with `page=1`. Its identity is the path, like a file. |
| `view.panel.diff` | `view.open.diff` | The same. There is one tab per thread and checkout, so a second checkout's diff gets its own tab. A `--title` makes a tab of the thread's own. In the shell, `--path`, `--note` or a side without a title update the checkout's tab (the spec's identity). The classic window still gives them a tab of their own. |
| `view.panel.pr` | `view.open.pr` | The same. There is one tab per pull request, so another number gets another tab. |
| `view.panel.gallery` | `view.open.gallery` | The same. There is one tab per thread and title. |
| `view.panel.mcp` | `view.open.mcp` | The same. There is one tab per thread. It stays in the palette under its title, "Show MCP Servers". |
| `view.inline --panel` | unchanged | `--panel` also opens the page's tab beside the thread. |
| `thread.focus` | unchanged | Also `thread.open --focus`: the thread's space becomes current and its tab takes the focus, opened (with its remembered tabs) if it was closed. It works with no window open. |
| `ui.focus.terminal` | unchanged | The terminal's tab takes the focus. With no tab, one opens by the rules, linked to the terminal's thread label or unlinked. A quick terminal opens under its thread, and the thread's tab takes the focus. |
| `view.pullrequests`, `view.projects` | unchanged | They also open (or focus) the page's tab in the current space; there is one of each per space. `--pane` is new. A plain `view.projects` keeps the page the tab shows; `--project` and `--workspace` change it. The refusal from a thread no window shows stays. From a thread with a window, the tab opens without the focus. |
| (new) | `view.thread-diff` | The user's key: from a thread's tab or a surface linked to it, the thread's own diff, focused; from that diff, back to the thread. It is a focus-only verb, so from a thread it is refused without `--focus`. It is out of the palette and the index, with no chord until the cutover. |

`--json` of an item verb is `PanelResult` with `tab`, `pane`, `space`, `rule` and `existing`, and
`tab_focused` when it took the focus. Of a page verb it is `PageTabResult`. The CLI says where the
tab went, for example "opened tab t-… in pane p-… for thread s-… (in a new pane right of the
thread); windows=1", or "… is already open in pane p-… (nothing new opened)".

## What is in it

| Where | Holds |
| --- | --- |
| `internal/command/commands_view_open.go` | `tabs` (the layout half), `showTab` / `showPanelTab` (check, then tab, then `ShowView`), `openAlias` / `withAliases`, the page verbs' `showPageTab`, `view.thread-diff`, and the shared `--thread`, `--focus` and `--pane` |
| `commands_view_items.go`, `commands_view_panel_page.go`, `commands_view_panel_gallery.go`, `commands_view_diff.go` | the verbs under their new names, running through `showItem` |
| `commands_mcp.go` | `view.open.mcp` and its alias; `WithMcpLayout` |
| `commands_view.go`, `commands_view_projects.go` | `ViewDeps.Layout`; the page verbs open their tab (`refusePage` split out of `showPageWith`) |
| `commands_thread_compose.go`, `commands_thread_lifecycle.go` | `thread.focus`'s `open_thread --focus` |
| `commands_ui.go`, `commands_ui_focus_terminal.go` | `ui.focus.terminal`'s tab; `WithTerminalTabs` |
| `commands_capabilities.go` | the `panel` group lists `view.open.*`, and `view.thread-diff` is not a page |
| `internal/command/all/all.go` | the layout given to the view, MCP and UI verbs |
| `internal/guide/layout.go` | the `layout` topic says to open surfaces with `view open …` and let placement work |
| skills, `ThreadPrompt` | the new names; "your own side panel" becomes "a tab beside you" |
| `gui/frontend/mock/panelItemVerbs.ts` (+ `world.ts`, `settings.ts`) | the mock's `view.open.*` verbs and their aliases, applying `open_surface` to the mock layout |

## Decisions

- **One command, two names.** `openAlias` copies the command: the same `Run` and `Args`, the name
  `view.panel.<item>`, `NoIndex` and `NoPalette`, and a description that starts "The old name of
  view.open.…, kept for one stable release." Nothing can drift between the two names.
- **Order: check, layout, `ShowView`.** The layout op runs inside the item's check, after it
  passes and before the classic intent goes out. A refusal changes neither window. A layout
  failure is the call's error, and the classic window shows nothing either.
- **Focus** is the layout verbs' rule (`wantsFocus`). The user's own call (the app, or the CLI
  outside a thread) focuses the tab. A thread's call runs with `KeepFocus`. `--focus` does both:
  it focuses the tab in the layout, and it sends the classic `FocusThread` first, as before.
- **The tab's params are the `ShowView`'s params**, so the shell's surfaces read what the panel's
  read today. The tab also gets a title for `layout show`: a file's name (or a page's `--title`),
  `#<n>` for a pull request, and the gallery or diff title.
- **Diff identity follows the spec**, not the classic window: one tab per thread and checkout,
  plus one per `--title`. The verb's description now says only that `--title` names a tab of your
  own, which is true in both windows.
- **The app's unscoped MCP call** (no `--thread`) still acts on each window's selection in the
  classic window. Its tab goes to the app's active thread.
- **`--pane`** is on every `view.open.*` verb and on the page verbs, for the pane's "+" menu. A
  linked tab that is already open is still focused where it is.
- **No `view.open.prs` or `view.open.projects`.** Plan 2.8 lists them, but `view.pullrequests` and
  `view.projects` already are those verbs, and a second name would only duplicate them.
- **`view.thread-diff`** focuses an open diff with `focus_tab` rather than `open_surface`, so the
  user's choices in it (the selected file, the sides) stay. `open_surface` would replace its params.
  A thread with no project worktree, or a tab of no thread, is refused.
- **`thread.focus` always takes the focus.** Taking the user there is the verb's whole meaning.
- **The guide budget.** The guide went from 10,971 to 10,915 bytes (budget 11,000). The six item
  verbs leave the index under their old names and come back under shorter names and titles. No
  trim was needed. `ThreadPrompt` stays at 1,638 bytes (budget 1,641): "view.open" is one byte
  shorter than "view.panel", twice, which pays for "a tab beside you" over "your own panel". The
  `view` topic grew from 14,335 to 16,264 bytes (budget 29,000), from the longer lead, `--pane`
  and the new `--thread` text. The aliases and `view.thread-diff` are not in any topic.

## Verification

- `make check` green.
- Command tests (`commands_view_open_test.go`, over `layouttest`):
  - `TestViewOpenPlacesALinkedTab`: each of the six verbs under both names, from the thread's CLI.
    It checks one `open_surface`, a tab linked to the thread in a new pane on its right (rule 5),
    the user's focus unmoved, the classic `ShowView`, the JSON, and the message.
  - `TestViewOpenFocus`: the app focuses, the thread's CLI does not, `--focus` does (and sends
    `FocusThread`), `--focus=false` from the app does not, and `--pane` gives rule `pane`.
  - `TestViewOpenIdentity`: the same diff twice through both names, another checkout's diff, a
    titled diff, the same and another pull request, the same and another file, a gallery title,
    and mcp. A second open is rule 1 and opens nothing. A different item joins the first by
    rule 2. The focus never moves.
  - `TestViewOpenRefusedOpensNothing`, `TestViewInlinePanelOpensATab`,
    `TestThreadFocusOpensItsTab` (from another space, and when the tab is closed),
    `TestFocusTerminalOpensItsTab` (a thread's shell, again, a free shell, a quick terminal),
    `TestPageVerbsOpenTheirTab`, `TestThreadDiffToggle`.
  - Two hand mutations each failed these tests: always taking the focus, and always
    `open_surface` in the toggle.
- The existing item-verb tests (`TestPanelFile`, `TestPanelPR`, `TestPanelDiff*`,
  `TestPanelVerbsThreadScope`, `TestPageVerbs`, the MCP tests, ...) pass unchanged. Their
  registry has no layout, so they see the classic half alone. The classification lists gained the
  new names. The capabilities test reads `view.open.*`. The skills' rule test reads the new names.
- vitest: `mock/panelItemVerbs.test.ts` checks that each verb and its alias place a linked tab and
  still show, that the alias is unlisted, the focus rule, `--pane`, and that a refusal places
  nothing. `mock/palette.test.ts` checks the keybinding parity.

### End to end with the built binary

`make build`. A daemon ran on `CODE_FOUNDRY_HOME=$(mktemp -d)`, with a project from a scratch git
repository under the home directory (`project.add` refuses temp folders), whose origin is this
repository on GitHub so pull requests resolve. The daemon was killed and both folders removed
afterwards. The first `thread open` has a mistyped suffix. That left the thread's tab closed, and
the run shows the spec's rule for that case: its surfaces open in the focused pane.

```
$ code-foundry thread open 3e3c3e
code-foundry thread.open: no thread id ends in "3e3c3e"
[exit 2]
$ code-foundry thread open b072
opened thread s-71275ebbb072 as tab t-gfdkaybs in pane p-6i6sne4d of space sp-5ulytc6w
[exit 0]
# as thread s-3eb7da2e3c3e (CODE_FOUNDRY_THREAD set), its tab not open:
$ code-foundry view open diff
opened tab t-ajo333y5 in pane p-6i6sne4d for thread s-3eb7da2e3c3e (in the focused pane); no app window is open
$ code-foundry view open file ~/cf7-e2e.DcTL/repo/notes.md --line 1
opened tab t-aipr5bot in pane p-6i6sne4d for thread s-3eb7da2e3c3e (in the focused pane); no app window is open
$ code-foundry view open pr 685
opened tab t-xxsew7yy in pane p-6i6sne4d for thread s-3eb7da2e3c3e (in the focused pane); no app window is open
$ code-foundry layout show
space sp-5ulytc6w "Main" (current) (default: threads with no space live here)
  pane p-6i6sne4d (focused)
    * t-gfdkaybs thread s-71275ebbb072 "Other thread"
      t-xxsew7yy pullrequest of s-3eb7da2e3c3e "View open e2e" "#685"
      t-aipr5bot file of s-3eb7da2e3c3e "View open e2e" "notes.md"
      t-ajo333y5 diff of s-3eb7da2e3c3e "View open e2e"
# the user's CLI: close those, open the thread's tab, then focus Other thread again
$ code-foundry tab close xxsew7yy        (and aipr5bot, ajo333y5)
$ code-foundry thread open 2e3c3e
opened thread s-3eb7da2e3c3e as tab t-u4hef3it in pane p-6i6sne4d of space sp-5ulytc6w
$ code-foundry thread open b072
thread s-71275ebbb072 is open as tab t-gfdkaybs in pane p-6i6sne4d of space sp-5ulytc6w
# as thread s-3eb7da2e3c3e:
$ code-foundry view open diff
opened tab t-qm34pcl6 in pane p-suxeyogk for thread s-3eb7da2e3c3e (in a new pane right of the thread); no app window is open
$ code-foundry view open file ~/cf7-e2e.DcTL/repo/notes.md --line 1
opened tab t-kpqawzfb in pane p-suxeyogk for thread s-3eb7da2e3c3e (beside the thread's other tabs); no app window is open
$ code-foundry view open pr 685
opened tab t-t6bkjjjl in pane p-suxeyogk for thread s-3eb7da2e3c3e (beside the thread's other tabs); no app window is open
$ code-foundry layout show
rev 12, laid out in 1180x820
space sp-5ulytc6w "Main" (current) (default: threads with no space live here)
  row s-wupqyanw [0.55 0.45]
    pane p-6i6sne4d (focused)
      * t-gfdkaybs thread s-71275ebbb072 "Other thread"
        t-u4hef3it thread s-3eb7da2e3c3e "View open e2e"
    pane p-suxeyogk
        t-qm34pcl6 diff of s-3eb7da2e3c3e "View open e2e"
        t-kpqawzfb file of s-3eb7da2e3c3e "View open e2e" "notes.md"
      * t-t6bkjjjl pullrequest of s-3eb7da2e3c3e "View open e2e" "#685"
# the same verbs again, and an old name: the open tabs; then a different PR and file
$ code-foundry view open diff
thread s-3eb7da2e3c3e's tab t-qm34pcl6 is already open in pane p-suxeyogk (nothing new opened); no app window is open
$ code-foundry view panel pr 685
thread s-3eb7da2e3c3e's tab t-t6bkjjjl is already open in pane p-suxeyogk (nothing new opened); no app window is open
$ code-foundry view open pr 684
opened tab t-377w2tc3 in pane p-suxeyogk for thread s-3eb7da2e3c3e (beside the thread's other tabs); no app window is open
$ code-foundry view open file ~/cf7-e2e.DcTL/repo/a.go
opened tab t-xfyyhj72 in pane p-suxeyogk for thread s-3eb7da2e3c3e (beside the thread's other tabs); no app window is open
$ code-foundry layout show
rev 16, laid out in 1180x820
space sp-5ulytc6w "Main" (current) (default: threads with no space live here)
  row s-wupqyanw [0.55 0.45]
    pane p-6i6sne4d (focused)
      * t-gfdkaybs thread s-71275ebbb072 "Other thread"
        t-u4hef3it thread s-3eb7da2e3c3e "View open e2e"
    pane p-suxeyogk
        t-qm34pcl6 diff of s-3eb7da2e3c3e "View open e2e"
        t-kpqawzfb file of s-3eb7da2e3c3e "View open e2e" "notes.md"
        t-t6bkjjjl pullrequest of s-3eb7da2e3c3e "View open e2e" "#685"
        t-377w2tc3 pullrequest of s-3eb7da2e3c3e "View open e2e" "#684"
      * t-xfyyhj72 file of s-3eb7da2e3c3e "View open e2e" "a.go"
# (the user's focus is still Other thread in p-6i6sne4d) --focus takes it:
$ code-foundry view open file ~/cf7-e2e.DcTL/repo/notes.md --focus
thread s-3eb7da2e3c3e's tab t-kpqawzfb is already open in pane p-suxeyogk (nothing new opened); it has the user's focus; no app window is open
$ code-foundry view thread-diff
code-foundry view.thread-diff: view.thread-diff only moves the user's focus; from inside a thread pass --focus, and only when the user asked to be taken there
[exit 2]
$ code-foundry view open diff --json
{"windows":0,"receivers":0,"thread":"s-3eb7da2e3c3e","tab":"t-qm34pcl6","pane":"p-suxeyogk","space":"sp-5ulytc6w","rule":"1","existing":true}
$ code-foundry view open page ~/cf7-e2e.DcTL/repo/page.html --title Page
opened tab t-lmpdcokb in pane p-suxeyogk for thread s-3eb7da2e3c3e (beside the thread's other tabs); no app window is open
# the user's CLI:
$ code-foundry tab focus gfdkaybs
$ code-foundry view thread-diff
code-foundry view.thread-diff: thread s-71275ebbb072 runs in no project worktree, so it has no diff
[exit 2]
$ code-foundry view thread-diff --tab qm34pcl6
back to thread s-3eb7da2e3c3e (tab t-u4hef3it)
$ code-foundry view thread-diff
thread s-3eb7da2e3c3e's diff is tab t-qm34pcl6
$ code-foundry view pullrequests --json
{"windows":0,"receivers":0,"tab":"t-pg5r5syi","pane":"p-suxeyogk","space":"sp-5ulytc6w","existing":true}
# daemon rebuilt and restarted; the layout was kept
$ code-foundry view pullrequests
prs tab t-pg5r5syi is already open in pane p-suxeyogk of space sp-5ulytc6w; no app window is open
$ code-foundry tab focus gfdkaybs
$ code-foundry thread focus --id 2e3c3e
thread s-3eb7da2e3c3e has the focus as tab t-u4hef3it in pane p-6i6sne4d of space sp-5ulytc6w; no app window is open
$ code-foundry terminal quick 2e3c3e --open
opened thread s-3eb7da2e3c3e's quick terminal t-86c22031ee1d (started)
$ code-foundry terminal quick 2e3c3e --close
closed thread s-3eb7da2e3c3e's quick terminal
$ code-foundry tab focus gfdkaybs
$ code-foundry ui focus terminal --id t-86c22031ee1d
opened thread s-3eb7da2e3c3e's quick terminal t-86c22031ee1d; no app window is open
$ code-foundry layout show
rev 33, laid out in 1180x820
space sp-5ulytc6w "Main" (current) (default: threads with no space live here)
  row s-wupqyanw [0.55 0.45]
    pane p-6i6sne4d (focused)
        t-gfdkaybs thread s-71275ebbb072 "Other thread"
      * t-u4hef3it thread s-3eb7da2e3c3e "View open e2e"
    pane p-suxeyogk
      * t-qm34pcl6 diff of s-3eb7da2e3c3e "View open e2e"
        t-kpqawzfb file of s-3eb7da2e3c3e "View open e2e" "notes.md"
        t-pg5r5syi prs
        t-t6bkjjjl pullrequest of s-3eb7da2e3c3e "View open e2e" "#685"
        t-377w2tc3 pullrequest of s-3eb7da2e3c3e "View open e2e" "#684"
        t-xfyyhj72 file of s-3eb7da2e3c3e "View open e2e" "a.go"
        t-lmpdcokb file of s-3eb7da2e3c3e "View open e2e" "Page"
threads
  thread s-3eb7da2e3c3e "View open e2e" in space sp-5ulytc6w, quick terminal open
```

In the first run, the page verbs and `thread.focus` printed the classic "no app window is open:
nothing was shown" after the tab's place. That is false once the layout keeps the change, so they
now end with "no app window is open". The lines after the restart show the fixed text.

## Gotchas

- `mock/palette.test.ts` finds the daemon's commands by reading `Command{ Name: "…"` in the Go
  sources. The aliases are generated, so it sees only the new names. The mock's `NO_KEYBINDING`
  needed `view.open.diff`, `.file` and `.pr`.
- `thread.focus` takes `--id`, not a positional id (unlike `thread.open`).
- The daemon's own test helper registers `RegisterMcp` without a layout. `view.panel.mcp` stays
  in `RegisterMcp` for that reason, with the layout given by an option, rather than moving to
  `RegisterView`.
- A plain `go test ./internal/...` fails to build `internal/dictate/whisper` without `make
  check`'s pkg-config path. That is not this change.

## For later PRs

- **PR 10/11 (the shell window)**: ignore the `panel.file`, `panel.diff`, `panel.pr`,
  `panel.gallery` and `panel.mcp` `ShowView`s. Also ignore the `FocusThread` and `FocusTerminal`
  that `thread.focus` and `ui.focus.terminal` send: the layout event already carries the focus.
  The tab params are the `ShowView` params, so the shell's surfaces can read them as the panel's
  do.
- **PR 12 (the "+" menu, Projects and Pull Requests)**: pass `--pane`. A checkout's diff opened
  from Projects, or a pull request opened from Pull Requests, is an unlinked tab. The item verbs
  always need a thread today, so they need an unlinked form (no `--thread`, with the page's pane).
- **PR 20 (cutover)**: bind cmd+shift+d to `view.thread-diff` (`view.pullrequests` loses it),
  and take `view.thread-diff` into the palette if wanted. Classic calls such as the linked-PR
  badge's `view.panel.pr` build layout tabs until then, as PR 6's shells do. The first-load import
  should not show them.
- **PR 22**: remove the `view.panel.<item>` aliases (`openAlias`, `withAliases`, the mock's
  `alias`) and the `ShowView` half of `showTab`, `showPageTab`, `thread.focus` and
  `ui.focus.terminal` (`refactor(command)!`). Decide then whether `view.pullrequests` and
  `view.projects` take `view.open.*` names.
- **PR 23 (docs)**: the remaining "side panel" wording (the capabilities group is still named
  `panel`, the welcome reply says "the panel on the right"), and the architecture's command
  section.
- **Plugin surfaces** (plan 2.9: `plugin.<n>.show.<s>` opens a tab, linked when thread-scoped)
  are not in this PR.
- **Diff identity**: if the owner wants a narrowed or annotated untitled diff to keep its own tab
  in the shell, as in the classic window, the `diff` key in `internal/layout/identity.go` has to
  read more than the title.
