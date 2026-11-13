# Shell PR 22: the panel verbs and the legacy view intents are retired

Twenty-second PR of the shell stack (`docs/notes/shell-plan.md` section 4, "PR 22"; sections 2.9
and 2.12). The classic window went in PR 21; this PR removes what the daemon still did for it. The
side and bottom panel verbs are gone. The item verbs (`view.open.*` and their `view.panel.<item>`
aliases), `view.pullrequests` and `view.projects` no longer send a `ShowView`: the layout's
`open_surface` is the whole effect. A thread's request to edit a file now lives whole in its File
tab's params, written by the daemon in that same `open_surface`, and `stores/threadPanelIntent.ts`
is deleted.

## Verbs

| Verb | Now | Why |
| --- | --- | --- |
| `view.panel.toggle`, `view.panel.expand`, `view.panel.new-tab`, `view.panel.split` | removed, with their `ShowView` names (`panel.toggle`, ...) | they acted on the side panel, which is gone; arranging is `tab.move`, `pane.move`, `pane.resize` |
| `view.bottom.toggle` | removed, with `bottom.toggle` | the bottom panel is gone; the quick terminal is `terminal.quick` |
| `view.open.file`, `.diff`, `.pr`, `.page`, `.gallery`, `.mcp` | kept; the tab is the whole effect, no intent | the specification's model-facing names |
| `view.panel.file`, `.diff`, `.pr`, `.page`, `.gallery`, `.mcp` | kept as unlisted aliases of the same command (`openAlias`) | `shell-model.md`, State: one stable release |
| `view.pullrequests`, `view.projects` | kept; their tab in the current space is the whole effect, no intent | the pages are tabs |
| `view.usage`, `view.settings`, `view.help` | unchanged: a `ShowView` | sheets over the window, not tabs |
| `thread.focus` | unchanged: `open_thread --focus`, then `FocusThread` | see kept intents |
| `ui.focus.terminal` | unchanged: the tab, then `FocusTerminal` | see kept intents |

The item verbs' `--focus` no longer sends an explicit `FocusThread`. In the shell that intent made
the window select the thread, and the selection bridge then focused the thread's own tab
(`thread.open --focus`), taking the focus away from the tab the verb had just focused.

`code-foundry help`, the palette and `daemon.capabilities` no longer list the removed verbs. The
capabilities `panel` group lost its `actions` (JSON) and its "Panel actions" line.

## Intents kept, and why

- **`FocusThread` from `thread.focus`** (and from the thread-starting verbs, unchanged): the
  layout op moves the focus, but only the window can put the keyboard in the thread's prompt
  (`stores/intents.ts focusThread` → `select(…, { focusPrompt: true })`). The bridge sees the tab
  already focused and only asks for the prompt.
- **`FocusTerminal` from `ui.focus.terminal`**: the keyboard into the terminal once its tab draws
  (`shell/terminalActions.ts followFocusTerminal`, shell gaps A, gap 4).
- **`ShowView` for window state** the layout does not hold: the sheets (`usage`, `settings`,
  `settings.<page>`, `themes*`, `help`), the window actions (`back`, `forward`, `thread.previous`,
  `thread.next`, `thread-info`, `pane.fullscreen`, the finds, `composer.history`, `file.find`,
  `search.open`, `project.add`, `thread.move`, the dictation ones, `agent.up`) and the plugin
  surfaces' `panel.<kind>` (`stores/pluginPanel.ts`), which open their tab from the window.
- **`ShowView.params`** stays for those names; **`ShowView.thread_id`** is reserved in the proto
  (field 2): nothing sets or reads it.

## A thread's file request

`view.open.file --edit` writes the request into the tab's params (`commands_view_items.go
fileAskParams`): `edit=1`, `asker` (the thread that asked, the caller's thread from the CLI),
`askId` (12 random hex digits, a new one per call: two requests are two), `note` when given, and
`focus=1` with `--focus`. Before, the daemon sent `thread` and the window turned the `ShowView`
into `asker` and a window-made `askId`. The window only reads them now
(`surfaces/fileTarget.ts fileOfTab`), and Save and tell answers `asker`, as before.

What only the window knows stays in the window, in `stores/fileRequestArrivals.ts`, started with
the shell. It watches the layout for a File tab whose `askId` is new (one the window had not seen;
a request already there when the window first reads the layout is not new, so a reload moves
nothing):

- with `focus=1` the editor takes the keyboard at the end of the line once it is on screen
  (`focusEditorLine`, as before);
- without it, when the request landed as the active tab of the pane whose editor the user is
  typing in, that editor's tab is made active again. The daemon already keeps a thread's new tab
  behind the focused pane's active tab (KeepFocus); this covers the editor sitting in a pane the
  layout does not have focused (shell gaps C, gap 22).

`focus` joined `ASK_PARAMS`, so it goes with the request when it ends. `fileEdit.ts
editorTabInTheWay` went (its only caller was the intent); `typingIn` replaces it.

The open's `behind` (proto `OpenSurfaceOp.behind_tab_id`, the seam's `openTab` option) stays:
nothing in the window passes it now, but it is a layout op field with its own cases. Removing it is
listed below.

## The diff pick moved to the daemon

A `view.open.diff` that frames nothing (no side, note, title, hide or narrowed list) on a
checkout whose tab the user has open used to send that tab's own params, and the window then picked
the file there. The daemon now does the pick in the same `open_surface`
(`commands_view_diff_pick.go intoUsersDiff`): the user's tab keeps its filter and folds, takes the
call's `own`, and gets the file picked in the sides it compares (out of a commit the user was in,
back to the sides the commit was opened from). When those sides differ from the call's, the daemon
asks `CompareWorktree` whether they list the file; when they do not, the file opens in a tab of the
asker's own (`thread=<asker>`), as a call naming those sides would. The window used the tab's
thread there; the daemon uses the asker, which is the same thread unless a thread opens another's
diff. The mock does the same pick (`mock/panelItemVerbs.ts intoUsersDiff`), treating a file the
checkout changed as listed, and now titles the item tabs as the daemon's `itemTab` does (a file's
name or a page's title, `#n`): the window's half used to retitle them.

## A plain view.projects shows the index

`view.projects` without `--project` or `--workspace` (the palette's Show Projects, a pane's "+")
now opens its tab on the index, leaving a project's page an open tab showed. PR 7 had it keep the
page in the layout, but the window then turned the `projects` ShowView into a selection of the
index, so the user always saw the index; with the ShowView gone the daemon sends empty params,
which replace the tab's (`commands_view_projects.go`), and the user sees what they saw before
(e2e `projects.spec.ts` "the + menu focuses the space's one tab", on the index).

## Settings

`appearance.panel_keep_open` is gone from the schema. A settings file that still sets it reads
silently: it is in `retiredKeys` (no "unknown setting" issue) and the next save leaves it out
(`TestDecodeRetiredKeys`). The Appearance group's description no longer names the side panel.

## Keybindings

A `[keybindings]` override naming one of the five removed verbs is reported as `unknown command
"…"` and dropped; the rest of the file applies, nothing is fatal
(`internal/daemon/settings_keybindings_test.go TestStaleKeybindingOverrides`, now with all five,
and `cmd+alt+\` bound to another command to show a retired chord is free).
`TestRetiredChords` also checks that none of the five is registered.

## Text a model reads

- `ThreadPrompt`: "prefer panel verbs" is "prefer view.open" (1,638 to 1,636 bytes, budget 1,641).
- The guide: 10,915 to 10,712 bytes (budget 11,000), from the five verbs leaving the index. The
  `view` topic: 16,483 to 13,811 bytes. `thread` 24,400 to 24,358, `action` 4,896 to 4,864 (the
  bottom panel wording in `action.add`).
- Descriptions: the item verbs' lead and `--focus` lose "the classic window"; `view.inline
  --panel` and its messages say "a tab beside the thread"; `view.pullrequests` and
  `view.projects` say "its tab in the current space"; `action.add`, `skill.setup`,
  `thread.mcp-reconnect`, `plugin.env`, `plugin.terminals`, `plugin.surface`, `plugin.act`,
  `file.find`, `file.search` and a plugin's `show` verb no longer name a side or bottom panel;
  `view.back` no longer explains the classic window.
- Capabilities: the `panel` group's lead and summary, the `pages` group ("prefer a view.open
  verb"), the inline line, and the `rendering` group's code, paths and file tab lines.
- Skills: `code-foundry` (the window is "a sidebar and panes of tabs"), `code-foundry-help`'s
  description, `code-foundry-pages` ("its own tab").

Left for PR 23, on purpose: the welcome tutorial's wording ("open … in the side panel", "the panel
on the right", in `stores/welcome.ts`, the help skill and `code-foundry-pages/reference/welcome.*`),
which is measured and changes with a run; the plugin skill's references (`ui-layout.md`,
`primitives.md`, `nodes.md`, `owned.md`), whose widths assume the 420 px side panel and need the
shell's real pane widths, not a word swap; code comments.

## Version window (plan 2.12)

An old window (before PR 20) with this daemon no longer shows a model's item verbs: it drew them
from the `ShowView` this daemon no longer sends, and it does not read the layout. It does not show
`view.pullrequests` or `view.projects` from the CLI either, and its panel and bottom panel keys
reach unknown commands. No fallback was added: a window restarts with the daemon on an update, and
`SHELL_SINCE` already sends a new window to an old daemon's update dialog.

A new window with an older daemon (before this PR, after PR 20) still gets that daemon's `ShowView`s
for the item verbs; it ignores them (`views.ts` knows no `panel.*` item names, `pullrequests` or
`projects` any more) and draws the tab from the layout, as before. A file request from such a daemon
has `thread` instead of `asker` and no `askId`: its tab opens editing without the band until the
daemon restarts.

## Verification

- `make check` and `make gui-e2e` green (`bridge.spec.ts:287` below).
- The first full run also failed four specs whose item tabs were titled "File": the window's half
  used to retitle them, and the mock now titles them as the daemon does. A fifth showed the plain
  `view.projects` change above.
- Go: `TestRetiredPanelVerbs` (the five are unknown, from the CLI, a thread and the app),
  `TestItemVerbThreadScope` (view.open.mcp and its alias: the tab of the right thread, focus only
  for the user or with --focus, no intent), `TestViewOpenPlacesALinkedTab` (all six verbs under both
  names, no intent), `TestViewOpenFocus` (no FocusThread), `TestViewOpenDiffPicksInTheUsersTab`
  (the same sides, other sides that list the file, sides that do not, out of a commit, no file),
  `TestPanelFileEditThreads` (asker, a fresh askId per request, focus), `TestPageVerbs` (sheets
  send a ShowView, the two pages a tab and nothing else), `TestViewProjectsPage`,
  `TestDecodeRetiredKeys`, `TestStaleKeybindingOverrides`, `TestRetiredChords`; the capabilities,
  inline, gallery, page and diff tables read the opened tab's params instead of the ShowView's.
- vitest: `stores/fileRequestArrivals.test.ts` (focus=1 puts the caret in; a request in front of the
  editor in use goes back behind it, a repeat too; --focus and a plain open are left alone; another
  pane is left alone; a request already there at load moves nothing; two of these fail with the
  re-activation removed), `stores/fileRequest.test.ts` (a request as the daemon writes it: the tab
  reads asker and askId, Save and tell answers the asker, every request param goes after),
  `mock/panelItemVerbs.test.ts` (both names, no intent, the request params, `intoUsersDiff`),
  `stores/views.test.ts` and `stores/intents.test.ts` (the old names are no view),
  `mock/keymap.test.ts`, `SidebarRow.test.tsx` (the linked pull request tag opens the tab directly).
- e2e: `thread-panel-items` (new and old names from a thread), `mcp-panel` (the CLI's view.open.mcp),
  `prs` (the CLI's view.pullrequests; a stale ShowView is ignored), `page-verbs-panel`, and the
  file request spec unchanged.

### bridge.spec.ts:287 ("a page's own other file keeps the bridge")

It failed in this branch's first two full e2e runs; a full run of origin/shell (4e84aea86) passed
it. The test clicks a link in the inline card's page, then waits for `data-ready="1"` and reads
`location.pathname`. The page's bridge turns that link into `location.assign(…#cf=<nonce>)`
(`internal/bridge/bridge.js`), a navigation WebKit starts after the click returns. The old
document already has `data-ready="1"`, so the wait passes on it, and the next `evaluate` runs on
the old document ("bridge.html") or mid-navigation ("Execution context was destroyed"). The trace
shows it: the click returned at 34409 ms, the wait passed at 34414, the request for
`bridge-next.html` started at 34418. Nothing in the window is on this path (no intent, no
`ShowView`, no layout op): the navigation happens inside the frame.

The race is older than this branch. The old test alone, 80 runs each: this branch failed 7,
origin/shell failed 4, a difference within noise at these counts. Fixed in the test: it holds the card's
`Frame` (the same object across its navigations), waits for the frame's URL to be the new
document (the navigation committed), then for that document's `data-ready`; both navigations in
the test do. 60 of 60 alone after the fix.

### End to end with the built binary and the window

`make build`, then `make drive DAEMON=dev` (scratch home `/tmp/cf-drive.*`, the window in headless
WebKit), a scratch git repository under the home directory with `a.go` changed and `b.go` new and
GitHub's code-foundry as its origin, two Haiku threads created with no prompt. Both folders were
removed and the drive stopped afterwards. `<repo>` is the scratch repository.

```
$ code-foundry thread open s-40fc7df9b518
opened thread s-40fc7df9b518 as tab t-35nhvvka in pane p-wmnsyrz2 of space sp-ebyigzhm
[exit 0]
$ code-foundry thread open s-b2ef04c06519
opened thread s-b2ef04c06519 as tab t-5seaxkuj in pane p-wmnsyrz2 of space sp-ebyigzhm
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view open diff
opened tab t-pl7mtrzl in pane p-3cttt25h for thread s-40fc7df9b518 (in a new pane right of the thread); windows=1
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view open file <repo>/a.go --line 2
opened tab t-5sdz5lxb in pane p-3cttt25h for thread s-40fc7df9b518 (beside the thread's other tabs); windows=1
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view open pr 700
opened tab t-zh57kwll in pane p-3cttt25h for thread s-40fc7df9b518 (beside the thread's other tabs); windows=1
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view panel diff --path <repo>/b.go
thread s-40fc7df9b518's tab t-pl7mtrzl is already open in pane p-3cttt25h (nothing new opened); windows=1
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view panel file <repo>/notes.md
opened tab t-hvre5ikk in pane p-3cttt25h for thread s-40fc7df9b518 (beside the thread's other tabs); windows=1
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view panel pr 701
opened tab t-e2hhcuc2 in pane p-3cttt25h for thread s-40fc7df9b518 (beside the thread's other tabs); windows=1
[exit 0]
# as thread s-40fc7df9b518 (CODE_FOUNDRY_THREAD set)
$ code-foundry view panel pr 700
thread s-40fc7df9b518's tab t-zh57kwll is already open in pane p-3cttt25h (nothing new opened); windows=1
[exit 0]
$ code-foundry layout show
rev 10, laid out in 996x732
space sp-ebyigzhm "Main" (current) (default: threads with no space live here)
  row s-v3sf6ucn [0.51 0.49]
    pane p-wmnsyrz2 (focused)
        t-35nhvvka thread s-40fc7df9b518 "Asker"
      * t-5seaxkuj thread s-b2ef04c06519 "Other thread"
    pane p-3cttt25h
        t-pl7mtrzl diff of s-40fc7df9b518 "Asker"
        t-5sdz5lxb file of s-40fc7df9b518 "Asker" "a.go"
      * t-zh57kwll pullrequest of s-40fc7df9b518 "Asker" "#700"
        t-hvre5ikk file of s-40fc7df9b518 "Asker" "notes.md"
        t-e2hhcuc2 pullrequest of s-40fc7df9b518 "Asker" "#701"
[exit 0]
# the user clicked a.go's tab, Edit, and is typing in its editor (pane p-3cttt25h has the focus)
# as thread s-40fc7df9b518
$ code-foundry view open file <repo>/.env --edit --line 2 --note Put the key on line 2
opened tab t-i3v7o5hv in pane p-3cttt25h for thread s-40fc7df9b518 (beside the thread's other tabs); windows=1; the user is asked to edit it: end your turn, a message says when it is saved; then continue without reading its values
[exit 0]
# the layout (layout show --json): t-i3v7o5hv in p-3cttt25h with params edit=1 asker=s-40fc7df9b518
# askId=e0ae9247d1e5 note="Put the key on line 2" line=2; p-3cttt25h's active tab still a.go (t-5sdz5lxb),
# the keyboard still in a.go's editor (it kept taking keys); the band on .env: Thread "Asker" asked you to edit this file
# the user saved .env with Save and tell; thread s-40fc7df9b518 got: "I saved .env. Continue without reading its values." (thread read #1)
# as thread s-40fc7df9b518, --focus (the user asked to be taken there)
$ code-foundry view panel file <repo>/c.env --edit --line 1 --focus
opened tab t-oytptxqi in pane p-3cttt25h for thread s-40fc7df9b518 (beside the thread's other tabs); it has the user's focus; windows=1; the user is asked to edit it: end your turn, a message says when it is saved; then continue without reading its values
[exit 0]
# the window: c.env is the focused tab and the keyboard is in its editor; typed abc, cmd+S: c.env is TOKEN=abc
$ code-foundry view panel toggle
code-foundry: unknown command "view panel toggle" (run `code-foundry commands` to list commands)
[exit 2]
$ code-foundry view.bottom.toggle
code-foundry: unknown command "view.bottom.toggle" (run `code-foundry commands` to list commands)
[exit 2]
$ code-foundry view panel split
code-foundry: unknown command "view panel split" (run `code-foundry commands` to list commands)
[exit 2]
# the scratch settings.toml given [appearance] panel_keep_open = true and [keybindings] "view.panel.toggle" = "cmd+shift+e", "view.bottom.toggle" = "cmd+j", picked up live:
$ code-foundry settings get | head -1
warning: 2 values are ignored in <home>/settings.toml (kept in the file until fixed; see the "# Ignored:" lines): keybindings.view.bottom.toggle, keybindings.view.panel.toggle
$ code-foundry daemon status
daemon pid 83314, version dev, up 2m53s, home <home>
```

The window drew every tab from the layout alone (no intent reached it for any of them), the user's
focus stayed on "Other thread" for the thread's calls, and the Diff tab the thread opened with
`view panel diff --path b.go` was the user's checkout tab with `b.go` picked (`own=1 path=b.go`).

## For later PRs

- **PR 23**: the welcome tutorial's wording (with a run), the plugin skill's layout references, the
  ~95 comments that still say side or bottom panel, and the capabilities group still named `panel`.
- **The `behind` option** of `open_surface` and the seam's `openTab`: no caller since this PR. Keep
  it if a user-side open should ever wait behind an editor, else remove it with its op cases.
- **The aliases**: `view.panel.<item>` go one stable release after the shell ships
  (`openAlias`, `withAliases`, the mock's `alias`), with a `refactor(command)!`.
- **`--focus` and the keyboard**: an item verb's `--focus` moves the layout's focus; only a file
  request's moves the keyboard (its editor). If a focused pull request or diff should take the
  keyboard too, the window can follow a layout focus change it did not ask for.
