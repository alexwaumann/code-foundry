# Views: the surface view model

{{cf.provenance}}

A surface shows a **view** the plugin sends with `h.UpdateView(instance, view)`: a header,
optional tabs, and a list of nodes. The host validates it, keeps it, and draws it with its
own components; there is no HTML, CSS or script. Types and builders are in
`github.com/alexwaumann/code-foundry/pluginsdk/ui`; `ui.View.Validate()` runs the same
checks as the host (UpdateView calls it before sending).

```go
import "github.com/alexwaumann/code-foundry/pluginsdk/ui"

v := ui.View{
	Header: &ui.Header{Title: "Build #42", Pill: ui.NewPill("failed", ui.ToneError)},
	Nodes: []ui.Node{
		ui.NewChips("stages", ui.NewChip("build", "Build", ui.StatusOK), ui.NewChip("test", "Test", ui.StatusFailed)),
		ui.NewActions("bar", ui.CommandButton("rerun", "Rerun failed", "plugin.ci.rerun", nil).WithStyle(ui.ButtonAttention)),
	},
}
err := h.UpdateView(open.Instance, v)
```

## Design rules

- A surface is a tab as wide as its pane: 480 px at the narrowest (beside a thread too, in
  a 1440 px window), the whole window's panes in full screen (`ui-layout.md`): short
  labels (pills of one or two words). Rows, pairs and chips wrap or truncate, table
  columns drop, and layout nodes degrade to one column (`ui-layout.md`). Titles get one line and
  the header sub-line two, then are cut for good: guidance is a `text` node.
- **No filled buttons.** The one thing that needs the user next is `attention` (amber
  outline); everything else is the default `muted`, `outline` for a little weight, or
  `link`. The `primary` style does not exist; the host refuses it.
- Colour means status: `attention` (amber) needs the user, `error` (red) failed, `ok`
  (emerald) only in pills, glyphs, stat figures and bars. Choose a status or tone, never a colour.
- Give a stop button the `destructive` style, also when its command needs no confirm.
- **Flags**: until-seen for one-off events; sticky for conditions the plugin clears, with a
  visible way out, never re-raised after a user's clear (`host-api.md`).
- **Tooltips.** The host draws an icon-only button's label, a link's URL, text it cut and a
  status in words. `hint` adds one, only for what is not on screen (why a button is
  disabled, an exact value): never a repeat of the label, and nothing the user must read to
  act goes in one.
- Let the host tick times (`ui.At`, `ui.For` spans) rather than re-sending views each second;
  stream output into a log node with `h.AppendLog`; mark last-known data `stale` when the
  backend is down.

## The JSON

What `plugin surface` prints and the host receives. Field names are the Go fields in lowerCamel, so the other references show Go only; enums are short lower-case strings. A node is an object with
a `key` and exactly one kind field. Every key (nodes, rows, chips, pairs, buttons,
fields, options, tabs) is unique in the view and matches `[A-Za-z0-9._:-]{1,64}`, not
starting `cf-` (the host's own, like its invalid-view notice); keys are
how the host keeps state (a collapsed section, a form draft) across views and how acts
name elements, so keep them stable between renders. One namespace for every kind: a
chip `deploy` and a button `deploy` collide, so prefix by role (`stage-deploy`,
`btn-deploy`).

```json
{
  "header": {"title": "Build #42", "pill": {"label": "failed", "tone": "error"}},
  "nodes": [
    {"key": "stages", "chips": {"chips": [{"key": "build", "label": "Build", "status": "ok"}, {"key": "test", "label": "Test", "status": "failed"}]}},
    {"key": "bar", "actions": {"buttons": [{"key": "rerun", "label": "Rerun failed", "style": "attention", "action": {"command": {"name": "plugin.ci.rerun"}}}]}}
  ]
}
```

## Updating: replace, append, versions

- **A command or event that changes what a view shows** has no `Surface` to hand: keep the
  open instances in a map on a plugin-wide struct (guarded by a mutex), add one in the
  `SurfaceFactory`, drop it in `Close`, and find it by `req.Context.ThreadID` (or the
  event's id) to render again. `plugin()` then becomes a method of that struct.
- `UpdateView` replaces the instance's whole view. It is a request: it returns the host's
  refusal (-32602, "view rejected: …" naming each problem) and calls from one goroutine
  arrive in order. A refused view leaves the previous one up; the plugin's log and
  `plugin list` show why. Fix it rather than retrying.
- The host numbers views (versions), drops a view identical to the last, and sends a
  burst to the GUI as a few frames (at most one per 100 ms per viewer). Above 50 views a
  second for 10 s it throttles the instance to one a second. Render on change, not on a
  timer; use time spans for clocks.
- `h.AppendLog(instance, key, text)` / `h.AppendLogLines(instance, key, lines...)`
  extends one log node of the current view without re-sending it (up to 64 KB per
  append). The host keeps the last 2,000 lines or 256 KB per log node. A later view that
  sets that node's `text` or `lines` replaces the buffer; one that leaves both empty keeps
  it; a view without the node drops it. So while output streams, render the log node with
  empty `text` and send each new chunk once with AppendLog; set `text` only to start
  over or when the view comes back after the node was gone.
- **A new run** that has printed nothing yet cannot clear the old output with empty
  `text` (that keeps it): give each run its own node key (`log-run-7`; the old node's
  buffer goes with it), or seed the new run's text with a first line (`$ go test ./...`).
- **Order**: append the last output *before* the view that ends the run ("passing"), so
  a viewer never sees the verdict above a log that is still filling.
- Acts name a view version: a version's elements still act for 3 s after a newer view
  replaced it (at most 64 versions), so a click on a view that was just replaced still
  arrives (with its old `version`). An act on an older one is refused ("the view changed
  before this action reached it; try again").
- After `Surface.Close(reason)` the instance is gone: `UpdateView` to it fails with
  -32004. Stop the instance's goroutines in `Close`; persist what should survive it.

## Limits

{{cf.limits}}

Strings longer than their cap, unknown enum values, a node with two kinds, a duplicate or
malformed key, a non-http(s) URL, a secret input with a value, two fields of one name in
a form, invalid UTF-8 anywhere, or too many buttons in a place are refused, with a path to
the problem (`nodes[2].list.rows[0].title: required`; the first 50 problems are named).

## Value types

| Type | JSON | Go | Rules |
|---|---|---|---|
| tone | `""` (neutral), `"muted"`, `"attention"`, `"error"`, `"ok"` | `ui.ToneNeutral`, `ToneMuted`, `ToneAttention`, `ToneError`, `ToneOK` | amber = needs the user, red = failed; `ok` (emerald) only in pills, status glyphs, stat figures and bars, elsewhere neutral |
| status | `"ok"`, `"failed"`, `"attention"`, `"running"` (spinner), `"pending"` (queued), `"skipped"`, `"off"` (aborted, disabled) | `ui.StatusOK`, … | rows, chips, glyphs; the host picks the dot or icon |
| inline | `"plain text"` or `{"spans": [...]}` | `ui.Plain("…")`, `ui.Spans(...)` | text that may mix tones, links, times |
| span | `{"text", "tone", "mono", "strong", "url", "hint"}`, `{"time": {"at", "style"}}` or `{"duration": {"ms"}}` | `ui.T("x").WithTone(ui.ToneError).AsMono().AsStrong().Link(url).WithHint("…")`, `ui.At(t, ui.TimeElapsed)`, `ui.For(d)` | one of text, time, duration; `url` http(s) only, opened by the host |
| time | `{"at": "2026-10-18T09:00:00Z", "style": "relative"}` | `ui.At(t, ui.TimeRelative)` | `relative` ("12s ago", "in 3 days"; default), `elapsed` ("4m 12s", counting up), `countdown` ("9:41", then "expired"); the host ticks it |
| duration | `{"ms": 100000}` | `ui.For(100*time.Second)` | a fixed length, formatted like `elapsed` ("1m 40s") |
| pill | `{"label": "failed", "tone": "error", "hint"}` | `ui.NewPill("failed", ui.ToneError)` | one or two words |
| glyph | `{"status": "running"}` or `{"icon": "package", "tone": "muted"}`, either with `"hint"` | `ui.StatusGlyph(s)`, `ui.IconGlyph(name, tone)` | a status or a lucide icon, not both |
| action | exactly one of `{"event": "rerun", "data": "job-7"}`, `{"command": {"name", "args"}}`, `{"openUrl": "https://…"}`, `{"copy": "text"}` | `ui.EventAction(event, data)`, `ui.CommandAction(name, args)`, `ui.URLAction(url)`, `ui.CopyAction(text)` | below |
| button | `{"key", "label", "icon", "style", "action", "disabled", "busy", "iconOnly", "hint"}` | `ui.EventButton(key, label, event)`, `ui.CommandButton(key, label, command, args)`, `ui.URLButton(key, label, url)`, `ui.CopyButton(key, label, text)`, then `.WithStyle(…)`, `.WithIcon("refresh-cw")`, `.AsIconOnly()`, `.WithData(id)` (an event's data), `.WithHint("Tests are still running")` | `label` always (the tooltip of an icon-only button); styles `muted` (default), `outline`, `attention`, `destructive`, `link`; `busy` shows a spinner for work that outlives the click; `hint` also shows on a disabled button, and under an icon-only button's label |

`hint` is at most 200 characters, and chips take one too. An older host ignores it: check
`h.HasCapability("view.hint")` only if the view reads wrongly without it.

**Actions.** An `event` reaches the plugin as a `surface/act` (`act.Action` is the event
name, `act.Data` its data, at most 1 KB). A `command` runs a command with the tab's
context through the host, with its confirm dialog: the plugin's own
(`plugin.<name>.<command>`) or a host command its `permissions.commands` allow (the view
is refused otherwise); its `context: thread` (and project, worktree) args default from
the tab's context, so `args` can leave them out (at most 16 args, 4 KiB together, 2 KiB
per value: pass ids, not text), and it runs with the viewer's tab,
which matters for shared instances (`reference/manifest.md`, "One instance, many
viewers"). `openUrl` and `copy` are done by the host and never reach the plugin, and
neither does a command button: `plugin act --key <button>` presses one as the GUI does
(the command runs with the tab's context; `--yes` for one that asks first).

## Header and tabs

```go
h := &ui.Header{Icon: "workflow", Title: "Checks of octo/app#12", TabTitle: "Checks",
	Pill: ui.NewPill("2 failing", ui.ToneError), Trailing: ui.Plain("main"),
	Subline: ui.Spans(ui.T("updated "), ui.At(fetched, ui.TimeRelative)), SublineIcon: "clock",
	Actions: []ui.Button{ui.EventButton("refresh", "Refresh", "refresh").WithIcon("refresh-cw").AsIconOnly()}}
tabs := ui.NewTabs("tab-runs", ui.NewTab("tab-runs", "Runs"), ui.Tab{Key: "tab-log", Label: "Log", Badge: ui.NewPill("live", ui.ToneAttention)})
v := ui.View{Header: h, Tabs: tabs, Nodes: runsNodes} // NewTabs returns *ui.Tabs
```

The header stays pinned above the scrolling body. Empty `icon` and `title` use the
manifest's; `tabTitle` (40 characters) renames the tab; up to 2 header buttons, drawn
icon-only (give them an icon) at the end of the sub-line, then the header's `menu` as a ⋯
(`nodes.md`, menus). The title is one line; the
sub-line (with `sublineIcon`, a neutral icon from the list, before it) wraps to two lines
(about 50 characters each at 420 px, 30 at 300 px) and is cut after that, never revealed:
a sentence of guidance goes in a `text` node. **Tabs** switch views inside one surface: the host draws the strip, sends a
`tab` act (`act.Kind == "tab"`, `act.Key` the tab's key) when the user switches, and
keeps form drafts per tab. The plugin answers with the view of the new active tab:
`nodes` are always the active tab's. Tab keys share the view's one key namespace: a tab
`runs` and a list `runs` collide (`nodes[1].key: "runs" is already used by
tabs.items[0]`), so prefix tabs `tab-…`. Past the tab limit, group: collapsible sections inside a
tab, or a second surface for a second subject. A view may add a pinned **`toolbar`** (under the
tabs: a search field, filter chips) and **`footer`** (at the bottom: a count, an actions
bar), up to 6 text, chips, actions, progress, form, divider, spacer or group nodes each,
the active tab's like `nodes`: `reference/ui-layout.md`.

## Which node

| Show | Node | In |
|---|---|---|
| A sentence, a value to copy | `text` | `nodes.md` |
| Explanatory copy | `markdown` | `nodes.md` |
| Facts about one thing | `pairs` | `nodes.md` |
| A list of things | `list` | `nodes.md` |
| Rows of the same few facts, compared down columns; sortable, grouped | `table` | `nodes.md` |
| A row's or the view's less frequent actions | a menu (`menu` on a row, the header, a button) | `nodes.md` |
| Stages or steps | `chips` | `nodes.md` |
| Streaming output | `log` | `nodes.md` |
| A bar of buttons | `actions` | `nodes.md` |
| One operation's progress | `progress` | `nodes.md` |
| The few figures checked first (pass rate, median), as cards; a filter card | `stats` | `nodes.md` |
| Results over time (build times, sizes), as a small bar chart | `bars` | `nodes.md` |
| A state the user should know about | `notice` | `nodes.md` |
| Nothing yet | `empty` | `nodes.md` |
| A titled group, a card, a collapsible | `section` | `nodes.md` |
| Input | `form` | `forms.md` |
| The plugin's own thread or terminal | `thread`, `terminal` | `owned.md` |
| Layout | `columns`, `pane`, `grid`, `divider`, `spacer`, `group`, `container`, `masterDetail`, `tabs` | `ui-layout.md` |

A node sits inside at most 4 containers: `section` and the layout containers (`ui-layout.md`).

## Acts

`Surface.Act(ctx, act)` gets `pluginsdk.SurfaceAct`:

| Kind | When | Fields |
|---|---|---|
| `click` | a button, row, chip, stat card, bar or menu item with an event | `Action` (event name), `Key` (element key), `Data` |
| `submit` | a form's submit with an event | `Action`, `Key`, `Data`, `Values` (the form's fields by name) |
| `change` | a field with a change event was edited | `Action`, `Key`, `Field`, `Value`, `Values` |
| `search` | the user typed into a picker (`forms.md`) | `Action` (the search's event), `Key` (the search's key), `Field`, `act.Query()` the query, `Values` |
| `tab` | the user switched tabs | `Action` is `"tab"`, `Key` the new tab's key (`Value` too, as `any`: use `Key`), `Node` the `tabs` node's key ("" for the view's tabs); no `Values` |
| `select` | a `masterDetail` row without an action was chosen | `Action` is `"select"`, `Key` the row's key (`Value` too: use `Key`), `Node` the master-detail's key; no `Values` |
| `check` | a `checkable` list's checkbox was toggled | `Key` the row's, `act.Checked()` the new state, `Node` the list's |
| `move` | a `reorderable` list's row was dragged | `Key` the row's, `act.After()` the row now right above it ("" = first; in a filtered list place it after that row), `Node` the list's |
| `add` | a list's `add` input was entered | `Key` and `Node` the list's, `act.Text()` the trimmed one-line text (200 characters) |
| `edit` | an `editable` row was renamed | `Key` the row's, `act.Text()` the new title, `Node` the list's |
| `sort` | a table's sortable header was clicked | `Key` the column's, `act.Descending()` the direction asked for, `Node` the table's |

For the last seven, `Action` is the kind. **Dispatch on `Kind`** first: a button's or row's event may itself be named `tab` or
`select` (it arrives as `kind: click, action: select`), so `switch act.Action` alone
mistakes it for a master-detail choice. `switch act.Kind { case pluginsdk.ActSelect: …;
case pluginsdk.ActTab: …; case pluginsdk.ActClick: switch act.Action { … } }`.

`act.Context` is what the tab the user acted in belongs to (`ThreadID`, `ProjectID`, …; a
tab linked to a thread acts for it, an unlinked one for the window's focused tab): a
shared instance (scope `pr`, `project`, `global`) learns from it which thread a click came
from (capability `act.context`; empty from an older host). What the tab lacks is empty:
an unlinked tab while a page has the focus (Pull Requests, Projects) has `ThreadID` "", so a thread action
there checks for it and answers with an error ("open a thread first"). `Version` is the view version
acted on. The host takes the kind, event, data and form
from its own copy of that version, so a client cannot forge them; the plugin still
validates `Values`. Return an error to refuse (its message is shown to the user); render
the result. `code-foundry plugin act <name> <surface> <event> [--key k] [--values '{"name":"Ada"}']`
does the same from the CLI.
