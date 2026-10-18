# Views: the surface view model

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

## The JSON

Field names are lowerCamel; enums are short lower-case strings. A node is an object with
a `key` and exactly one kind field. Every key (nodes, rows, chips, pairs, buttons,
fields, options, tabs) is unique in the view and matches `[A-Za-z0-9._:-]{1,64}`; keys are
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
- Acts name a view version: the elements of the last 4 versions still act, so a click on
  a view that was just replaced still arrives (with its old `version`).
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
| tone | `""` (neutral), `"muted"`, `"attention"`, `"error"`, `"ok"` | `ui.ToneNeutral`, `ToneMuted`, `ToneAttention`, `ToneError`, `ToneOK` | amber = needs the user, red = failed; `ok` (emerald) only in pills and status glyphs, elsewhere neutral |
| status | `"ok"`, `"failed"`, `"attention"`, `"running"` (spinner), `"pending"` (queued), `"skipped"`, `"off"` (aborted, disabled) | `ui.StatusOK`, … | rows, chips, glyphs; the host picks the dot or icon |
| inline | `"plain text"` or `{"spans": [...]}` | `ui.Plain("…")`, `ui.Spans(...)` | text that may mix tones, links, times |
| span | `{"text", "tone", "mono", "strong", "url"}`, `{"time": {"at", "style"}}` or `{"duration": {"ms"}}` | `ui.T("x").WithTone(ui.ToneError).AsMono().AsStrong().Link(url)`, `ui.At(t, ui.TimeElapsed)`, `ui.For(d)` | one of text, time, duration; `url` http(s) only, opened by the host |
| time | `{"at": "2026-10-18T09:00:00Z", "style": "relative"}` | `ui.At(t, ui.TimeRelative)` | `relative` ("12s ago", "in 3 days"; default), `elapsed` ("4m 12s", counting up), `countdown` ("9:41", then "expired"); the host ticks it |
| duration | `{"ms": 100000}` | `ui.For(100*time.Second)` | a fixed length, formatted like `elapsed` ("1m 40s") |
| pill | `{"label": "failed", "tone": "error"}` | `ui.NewPill("failed", ui.ToneError)` | one or two words |
| glyph | `{"status": "running"}` or `{"icon": "package", "tone": "muted"}` | `ui.StatusGlyph(s)`, `ui.IconGlyph(name, tone)` | a status or a lucide icon, not both |
| action | exactly one of `{"event": "rerun", "data": "job-7"}`, `{"command": {"name", "args"}}`, `{"openUrl": "https://…"}`, `{"copy": "text"}` | `ui.EventAction(event, data)`, `ui.CommandAction(name, args)`, `ui.URLAction(url)`, `ui.CopyAction(text)` | below |
| button | `{"key", "label", "icon", "style", "action", "disabled", "busy", "iconOnly"}` | `ui.EventButton(key, label, event)`, `ui.CommandButton(key, label, command, args)`, `ui.URLButton`, `ui.CopyButton`, then `.WithStyle(…)`, `.WithIcon("refresh-cw")`, `.AsIconOnly()`, `.WithData(id)` (an event's data) | `label` always (the tooltip of an icon-only button); styles `muted` (default), `outline`, `attention`, `destructive`, `link`; `busy` shows a spinner for work that outlives the click |

**Actions.** An `event` reaches the plugin as a `surface/act` (`act.Action` is the event
name, `act.Data` its data, at most 1 KB). A `command` runs a command with the panel's
context through the host, with its confirm dialog: the plugin's own
(`plugin.<name>.<command>`) or a host command its `permissions.commands` allow (the view
is refused otherwise); its `context: thread` (and project, worktree) args default from
the panel's context, so `args` can leave them out (at most 16 args, 4 KiB together, 2 KiB
per value: pass ids, not text), and it runs with the viewer's panel,
which matters for shared instances (`reference/manifest.md`, "One instance, many
viewers"). `openUrl` and `copy` are done by the host and never reach the plugin, and
neither does a command button: `plugin act --key <button>` presses one as the GUI does
(the command runs with the panel's context; `--yes` for one that asks first).

## Header and tabs

```json
{"header": {"icon": "workflow", "title": "Checks of octo/app#12", "tabTitle": "Checks",
            "pill": {"label": "2 failing", "tone": "error"},
            "subline": {"spans": [{"text": "updated "}, {"time": {"at": "2026-10-18T09:00:00Z"}}]}, "sublineIcon": "clock",
            "trailing": "main",
            "actions": [{"key": "refresh", "label": "Refresh", "icon": "refresh-cw", "iconOnly": true, "action": {"event": "refresh"}}]},
 "tabs": {"items": [{"key": "tab-runs", "label": "Runs"}, {"key": "tab-log", "label": "Log", "badge": {"label": "live", "tone": "attention"}}],
          "active": "tab-runs"},
 "nodes": []}
```

```go
h := &ui.Header{Icon: "workflow", Title: "Checks of octo/app#12", TabTitle: "Checks",
	Pill: ui.NewPill("2 failing", ui.ToneError), Trailing: ui.Plain("main"),
	Subline: ui.Spans(ui.T("updated "), ui.At(fetched, ui.TimeRelative)), SublineIcon: "clock",
	Actions: []ui.Button{ui.EventButton("refresh", "Refresh", "refresh").WithIcon("refresh-cw").AsIconOnly()}}
tabs := ui.NewTabs("tab-runs", ui.NewTab("tab-runs", "Runs"), ui.Tab{Key: "tab-log", Label: "Log", Badge: ui.NewPill("live", ui.ToneAttention)})
v := ui.View{Header: h, Tabs: tabs, Nodes: runsNodes} // NewTabs returns *ui.Tabs
```

The header stays pinned above the scrolling body. Empty `icon` and `title` use the
manifest's; `tabTitle` (40 characters) renames the panel tab; up to 2 header buttons, drawn
icon-only (give them an icon) at the end of the sub-line. The title is one line; the
sub-line (with `sublineIcon`, a neutral icon from the list, before it) wraps to two lines
(about 50 characters each at 400 px, 30 at 280 px) and is cut after that, never revealed:
a sentence of guidance goes in a `text` node. **Tabs** switch views inside one surface: the host draws the strip, sends a
`tab` act (`act.Kind == "tab"`, `act.Key` the tab's key) when the user switches, and
keeps form drafts per tab. The plugin answers with the view of the new active tab:
`nodes` are always the active tab's. Tab keys share the view's one key namespace: a tab
`runs` and a list `runs` collide (`nodes[1].key: "runs" is already used by
tabs.items[0]`), so prefix tabs `tab-…`. Past the tab limit, group: collapsible sections inside a
tab, or a second surface for a second subject.

## Nodes

### text

```json
{"key": "summary", "text": {"content": {"spans": [{"text": "3 of 5 jobs passed"}, {"text": " · 2 failed", "tone": "error"}]}}}
{"key": "code", "text": {"content": "WDJB-MJHT", "size": "lg", "copyable": true}}
```

```go
ui.NewText("summary", ui.Spans(ui.T("3 of 5 jobs passed"), ui.T(" · 2 failed").WithTone(ui.ToneError)))
ui.Node{Key: "code", Text: &ui.Text{Content: ui.Plain("WDJB-MJHT"), Size: ui.TextLg, Copyable: true}}
```

`size`: `""` (13 px), `sm` (12 px, muted), `lg` (18 px mono, for a code to type
elsewhere). `copyable` adds a copy button. Up to 4 KB.

### markdown

```json
{"key": "help", "markdown": {"source": "Rerun **failed** jobs only. See [the docs](https://docs.github.com/actions)."}}
```

```go
ui.NewMarkdown("help", "Rerun **failed** jobs only. See [the docs](https://docs.github.com/actions).")
```

GitHub-flavoured, up to 16 KB, for explanations; raw HTML shows as text; links open in
the browser.

### pairs

```json
{"key": "facts", "pairs": {"items": [
  {"key": "branch", "label": "Branch", "value": {"spans": [{"text": "cf/fix-login", "mono": true}]}, "copyable": true},
  {"key": "status", "label": "Status", "pill": {"label": "passing", "tone": "ok"}},
  {"key": "took", "label": "Took", "value": {"spans": [{"duration": {"ms": 95000}}]}}]}}
```

```go
ui.NewPairs("facts",
	ui.Pair{Key: "branch", Label: "Branch", Value: ui.Spans(ui.T("cf/fix-login").AsMono()), Copyable: true},
	ui.Pair{Key: "status", Label: "Status", Pill: ui.NewPill("passing", ui.ToneOK)},
	ui.NewPair("took", "Took", ui.Spans(ui.For(95*time.Second))))
```

Facts about one thing: a label (40 characters) and a value or a pill.

### list

```json
{"key": "run-list", "list": {"emptyText": "No runs yet", "rows": [
  {"key": "run-7", "glyph": {"status": "running"}, "title": "CI", "titleMeta": "push",
   "line2": {"spans": [{"text": "started "}, {"time": {"at": "2026-10-18T09:00:00Z", "style": "elapsed"}}]},
   "trailing": {"spans": [{"duration": {"ms": 42000}}]},
   "action": {"event": "open-run", "data": "7"},
   "actions": [{"key": "run-7-cancel", "label": "Cancel", "icon": "square", "iconOnly": true, "style": "destructive", "action": {"command": {"name": "plugin.ci.cancel", "args": {"run": "7"}}}}]},
  {"key": "run-6", "glyph": {"status": "failed"}, "title": "CI", "pill": {"label": "failed", "tone": "error"}, "selected": true,
   "actions": [{"key": "run-6-hide", "label": "Hide", "action": {"event": "hide", "data": "6"}}]}]}}
```

```go
ui.Node{Key: "run-list", List: &ui.List{EmptyText: "No runs yet", Rows: []ui.Row{
	{Key: "run-7", Glyph: ui.StatusGlyph(ui.StatusRunning), Title: "CI", TitleMeta: ui.Plain("push"),
		Line2:    ui.Spans(ui.T("started "), ui.At(started, ui.TimeElapsed)),
		Trailing: ui.Spans(ui.For(42 * time.Second)),
		Action:   ui.EventAction("open-run", "7"),
		Actions: []ui.Button{ui.CommandButton("run-7-cancel", "Cancel", "plugin.ci.cancel", map[string]string{"run": "7"}).
			WithIcon("square").AsIconOnly().WithStyle(ui.ButtonDestructive)}},
	{Key: "run-6", Glyph: ui.StatusGlyph(ui.StatusFailed), Title: "CI", Pill: ui.NewPill("failed", ui.ToneError), Selected: true,
		Actions: []ui.Button{ui.EventButton("run-6-hide", "Hide", "hide").WithData("6")}}, // act.Data == "6"
}}}
```

A row: glyph, title (required), `titleMeta`, pill, `line2`, `trailing`, up to 3 buttons,
an `action` for the whole row, `selected`. Icon-only buttons sit at the end of the first
line beside `trailing`; labelled ones go on a line of their own under the row (a cancel
or open is icon-only, a "Send to Claude" labelled). `glyphStyle`: `dot` (default) or `icon`;
`dense` draws 24 px single-line rows: `line2` and labelled buttons are **not shown**
(icon-only buttons and `trailing` are), so leave it off when line 2 carries something
the user needs. `emptyText` shows when there are no rows.

### chips

```json
{"key": "stages", "chips": {"chips": [
  {"key": "build", "label": "Build", "status": "ok", "meta": {"spans": [{"duration": {"ms": 31000}}]}},
  {"key": "test", "label": "Test", "status": "running", "selected": true, "action": {"event": "stage", "data": "test"}},
  {"key": "deploy", "label": "Deploy", "status": "pending"}]}}
```

```go
ui.NewChips("stages",
	ui.Chip{Key: "build", Label: "Build", Status: ui.StatusOK, Meta: ui.Spans(ui.For(31 * time.Second))},
	ui.Chip{Key: "test", Label: "Test", Status: ui.StatusRunning, Selected: true, Action: ui.EventAction("stage", "test")},
	ui.NewChip("deploy", "Deploy", ui.StatusPending))
```

Stages or steps in a wrapping strip; labels up to 32 characters (keep them short: at
280 px a line holds one or two chips).

### log

```json
{"key": "out", "log": {"title": "test (ubuntu)", "rows": 12, "wrap": true, "text": "ok   pkg/a\nFAIL pkg/b\n"}}
{"key": "lint", "log": {"lines": [{"text": "checking 42 files"}, {"text": "warning: unused x", "tone": "attention"}, {"text": "error: missing return", "tone": "error"}]}}
```

```go
ui.Node{Key: "out", Log: &ui.Log{Title: "test (ubuntu)", Rows: 12, Wrap: true, Text: tail}}
ui.Node{Key: "lint", Log: &ui.Log{Lines: []ui.LogLine{{Text: "checking 42 files"}, {Text: "warning: unused x", Tone: ui.ToneAttention}}}}
h.AppendLog(instance, "out", "ok   pkg/c\n")
h.AppendLogLines(instance, "lint", pluginsdk.AppendLine{Text: "error: x", Tone: "error"})
```

A monospace tail that follows new output (`noFollow` stops that), `rows` 4..40 (default
16), `wrap` long lines, `truncated` to say the head was cut. `text` or `lines` (each with
a tone), not both; ANSI colour codes are not interpreted (strip them). Up to 64 KB per
render and 4 log nodes per view; stream more with the append calls.

### actions

```json
{"key": "bar", "actions": {"align": "end", "buttons": [
  {"key": "send", "label": "Send failure to Claude", "style": "attention", "icon": "send", "action": {"command": {"name": "plugin.ci.send-failure"}}},
  {"key": "open", "label": "Open on GitHub", "icon": "external-link", "action": {"openUrl": "https://github.com/octo/app/actions/runs/7"}}]}}
```

```go
ui.Node{Key: "bar", Actions: &ui.Actions{Align: ui.AlignEnd, Buttons: []ui.Button{
	ui.CommandButton("send", "Send failure to Claude", "plugin.ci.send-failure", nil).WithStyle(ui.ButtonAttention).WithIcon("send"),
	ui.URLButton("open", "Open on GitHub", runURL).WithIcon("external-link"),
}}}
// or: ui.NewActions("bar", buttons...)
```

A wrapping row of up to 6 buttons. Buttons are never free nodes: they live in a header,
row, section, notice, empty state, actions bar or form.

### progress

```json
{"key": "upload", "progress": {"value": 0.62, "label": "Uploading artifacts", "meta": "62 of 100 MB"}}
{"key": "wait", "progress": {"label": "Waiting for a runner"}}
```

```go
ui.Node{Key: "upload", Progress: &ui.Progress{Value: ui.Fraction(0.62), Label: "Uploading artifacts", Meta: ui.Plain("62 of 100 MB")}}
ui.NewProgress("wait", "Waiting for a runner", nil) // nil value: indeterminate
```

`tone: "error"` when it failed.

### notice

```json
{"key": "auth", "notice": {"tone": "attention", "icon": "key-round", "title": "Sign in needed",
  "body": "The CI server wants a token.", "detail": "HTTP 401 from https://ci.acme.com/api",
  "actions": [{"key": "auth-go", "label": "Add a token", "style": "attention", "action": {"event": "goto-settings"}}]}}
```

```go
ui.Node{Key: "auth", Notice: &ui.Notice{Tone: ui.ToneAttention, Icon: "key-round", Title: "Sign in needed",
	Body: ui.Plain("The CI server wants a token."), Detail: "HTTP 401 from https://ci.acme.com/api",
	Actions: []ui.Button{ui.EventButton("auth-go", "Add a token", "goto-settings").WithStyle(ui.ButtonAttention)}}}
// or: ui.NewNotice("auth", ui.ToneAttention, "Sign in needed", ui.Plain("…"))
```

A state the user should know about: tone neutral, `attention` or `error`; `detail` is
monospace (2 KB, an error's text); up to 3 buttons.

### empty

```json
{"key": "none", "empty": {"glyph": {"icon": "package", "tone": "muted"}, "title": "No runs", "body": "Push a commit to start one.",
  "actions": [{"key": "refresh", "label": "Refresh", "action": {"event": "refresh"}}]}}
```

```go
ui.Node{Key: "none", Empty: &ui.Empty{Glyph: ui.IconGlyph("package", ui.ToneMuted), Title: "No runs",
	Body: ui.Plain("Push a commit to start one."), Actions: []ui.Button{ui.EventButton("refresh", "Refresh", "refresh")}}}
// or: ui.NewEmpty("none", "No runs", ui.Plain("…"))
```

The whole body when there is nothing yet; up to 2 buttons.

### section

```json
{"key": "older", "section": {"title": "Earlier runs", "meta": "last 24 h", "pill": {"label": "3"},
  "collapsible": true, "collapsed": true, "card": false, "stale": false,
  "actions": [{"key": "older-clear", "label": "Clear", "icon": "trash-2", "iconOnly": true, "action": {"event": "clear"}}],
  "children": [{"key": "older-list", "list": {"rows": []}}]}}
{"key": "deploy", "section": {"title": "Deploy", "card": true, "tone": "error", "children": [...]}}
```

```go
ui.Node{Key: "older", Section: &ui.Section{Title: "Earlier runs", Meta: ui.Plain("last 24 h"), Pill: ui.NewPill("3", ui.ToneNeutral),
	Collapsible: true, Collapsed: true, Children: []ui.Node{olderList},
	Actions: []ui.Button{ui.EventButton("older-clear", "Clear", "clear").WithIcon("trash-2").AsIconOnly()}}}
ui.Node{Key: "deploy", Section: &ui.Section{Title: "Deploy", Card: true, Tone: ui.ToneError, Children: deployNodes}}
// or: ui.NewSection("older", "Earlier runs", children...)
```

Groups nodes under a title (60 characters, one line: with meta, pill and buttons beside
it, it is cut early, so keep it to a few words): `card` draws a box, `tone` `attention`
or `error` colours the title (and a card's border), `collapsible` + `collapsed` (initial;
the user's toggle wins), `stale` dims last-known data while the backend is unreachable.
Up to 2 buttons sit at the end of the title row, after the pill. Sections nest two deep:
section > section > node.

### form

```json
{"key": "settings", "form": {
  "fields": [
    {"key": "f-url", "name": "url", "label": "Server", "required": true,
     "input": {"placeholder": "https://ci.acme.com", "pattern": "^https://", "patternMessage": "An https URL", "mono": true}},
    {"key": "f-token", "name": "token", "label": "API token", "description": "Kept in your Keychain.",
     "input": {"kind": "secret", "store": "token", "hasValue": true}},
    {"key": "f-project", "name": "project", "label": "Project", "select": {"optionsSource": "projects", "placeholder": "Pick a project"}},
    {"key": "f-env", "name": "env", "label": "Environment", "select": {"style": "list", "value": ["dev"], "options": [
      {"key": "o-dev", "value": "dev", "label": "Development"},
      {"key": "o-prod", "value": "prod", "label": "Production", "description": "Real users."}]}},
    {"key": "f-notify", "fieldset": {"label": "Notify me", "hint": "Pick any.", "fields": [
      {"key": "f-fail", "name": "notifyFail", "label": "When a run fails", "toggle": {"value": true}},
      {"key": "f-done", "name": "notifyDone", "label": "When a run finishes", "toggle": {"value": false}}]}}
  ],
  "submit": {"key": "save", "label": "Save", "style": "attention", "action": {"event": "save"}},
  "secondary": [{"key": "reset", "label": "Reset", "action": {"event": "reset"}}],
  "error": "", "busy": false, "resetToken": "3"}}
```

```go
url := ui.TextField("f-url", "url", "Server").WithPlaceholder("https://ci.acme.com").AsRequired().
	WithPattern("^https://", "An https URL").WithHint("Your CI server") // also WithValue, WithChange
url.Input.Mono = true
token := ui.SecretField("f-token", "token", "API token", "").WithStore("token") // the host keeps it under "token"
token.Input.HasValue = tokenIsSet
project := ui.Field{Key: "f-project", Name: "project", Label: "Project", Select: &ui.Select{OptionsSource: ui.OptionsProjects}}
env := ui.SelectField("f-env", "env", "Environment", ui.Opt("o-dev", "dev", "Development"), ui.Opt("o-prod", "prod", "Production"))
env.Select.Style, env.Select.Value = ui.SelectList, []string{"dev"}
notify := ui.NewFieldset("f-notify", "Notify me",
	ui.ToggleField("f-fail", "notifyFail", "When a run fails", true),
	ui.ToggleField("f-done", "notifyDone", "When a run finishes", false))
save := ui.EventButton("save", "Save", "save").WithStyle(ui.ButtonAttention)
form := ui.NewForm("settings", &save, url, token, project, env, notify)
form.Form.Secondary = []ui.Button{ui.EventButton("reset", "Reset", "reset")}
form.Form.ResetToken = strconv.Itoa(savedCount)
```

The one way values travel to the plugin. A field has a `key`, a `name` (its key in the
submitted values, or the command arg it fills), a label, a `description`, an `error` (the
plugin's validation message), `required`, `disabled`, and exactly one control:

- `input`: one-line text; `kind: "secret"` masks it. `value` (never for a secret),
  `placeholder`, `maxLength`, `pattern` (a regular expression) with `patternMessage`,
  `mono`. `required`, `maxLength` and `pattern` are checked by the GUI as the user types;
  `plugin act --values` and other clients skip them, so the plugin validates every value
  again (and answers with a field `error` or an error).
- `select`: `options` (up to 200, each `key`, `value`, `label`, `description` in list
  style, `disabled`), `value` (a list: one value unless `multiple`), `multiple`, `style`
  `dropdown` (default; with `multiple`, a menu of checkboxes) or `list` (radio or
  checkbox rows with descriptions), `placeholder`. `optionsSource: "projects"` or `"threads"` makes the host fill the
  options (values are ids) and keep them current; `options` must then be empty.
- `toggle`: a switch, `value` true or false.
- `fieldset`: a label, `hint` and `error` over a group of fields (a checkbox group, a
  pair of related inputs). Fieldsets do not nest.

A field with `change: {"event": "…"}` sends a `change` act when the user commits an edit
(a text field on leaving it, a select or toggle on each pick; never per keystroke):
`act.Field` its name, `act.Value` the new value, for dependent fields; never for a
secret. The **submit** button sends a `submit` act with every field's value in
`act.Values` by name: strings, booleans for toggles, string lists for multiple selects.
It may run a command instead (the fields fill its args by name) unless the form has a
secret field. `secondary` buttons act like any button. `error` shows under the form.
From submit until Act returns, the host disables the form and spins the submit itself;
for work that outlives the act, render the form with `busy` (every field and button
disabled) and the submit button with `busy` (its spinner), and drop both when it ends.

**Drafts.** The host keeps what the user typed (per instance and tab) across new views,
so re-rendering does not wipe a half-filled form. A submit the plugin takes drops the
form's drafts (the fields show the next view's values); a refused one keeps them: Act
returned an error (toasted), or the view after it has a field `error` or the form's
`error`. So answer bad values with field errors and the user's text stays under them.
Change `resetToken` to drop the drafts and show the view's values (a reset). The plugin
cannot read drafts: to follow what the user enters before submit, give the field a
`change` event.

**Secrets.** A secret input never carries a value. With `store: "<key>"` (letters, digits,
`.`, `_`, `-`, at most 64; permission `secrets`) the host writes the submitted value into the plugin's Keychain namespace
(before the plugin sees the submit, even if the plugin then refuses the other fields) and
`act.Values[name]` is `{"key": "<key>", "stored": true}`: `sk, ok := act.Stored(name)`.
The plugin reads the value with `h.Secrets().Get(ctx, key)` when it needs it. A secret left
empty on submit is left out (the stored one stays). Set `hasValue` to show "Saved · type
to replace". Without `store` the value reaches the plugin in the submit only.

### thread and terminal

```json
{"key": "helper", "thread": {"threadId": "s-1f2e3d4c5b6a", "placeholder": "Ask about this run", "height": "fill"}}
{"key": "shell", "terminal": {"terminalId": "t-1f2e3d4c5b6a", "title": "test run", "height": 320,
  "actions": [{"key": "rerun", "label": "Rerun", "action": {"event": "rerun"}}]}}
```

```go
ui.Node{Key: "helper", Thread: &ui.Thread{ThreadID: id, Placeholder: "Ask about this run", Height: ui.HeightFill}}
ui.Node{Key: "shell", Terminal: &ui.Terminal{TerminalID: id, Title: "test run", Height: ui.HeightPx(320),
	Actions: []ui.Button{ui.EventButton("rerun", "Rerun", "rerun")}}}
```

The plugin's own Claude thread (`h.CreateThread`, permission `threads`) drawn inline with
the host's thread view and composer (`readOnly: true` leaves the composer out), or its own
terminal (`h.CreateTerminal`, permission `terminals`) with the host's terminal view, an
"Open in bottom panel" button and up to 2 buttons of yours. `height` is `"auto"` (the
default: about 420 px for a thread, `rows` text rows (4..60, default 16) for a terminal),
`"fill"` (the rest of the panel, at least 240 px) or pixels (120..1600). A view naming
another owner's thread or terminal is refused; one that is gone (removed, closed) shows a
muted empty state; an archived thread still renders, composer included, with no archived
cue (`SendThread` unarchives it), so drop its node when you archive it. Each of these nodes is a
live stream from the GUI to the daemon: the GUI attaches one only while it is on screen
and at most two per view, so show one (two at most) at a time and switch with tabs or
chips rather than stacking them. Check `h.HasCapability("view.node.thread")` (`view.node.terminal`)
before relying on them; `reference/host-api.md` has the calls that make them.

## Acts

`Surface.Act(ctx, act)` gets `pluginsdk.SurfaceAct`:

| Kind | When | Fields |
|---|---|---|
| `click` | a button, row or chip with an event | `Action` (event name), `Key` (element key), `Data` |
| `submit` | a form's submit with an event | `Action`, `Key`, `Data`, `Values` (the form's fields by name) |
| `change` | a field with a change event was edited | `Action`, `Key`, `Field`, `Value`, `Values` |
| `tab` | the user switched tabs | `Action` is `"tab"`, `Key` the new tab's key (`Value` too, as `any`: use `Key`) |

`act.Context` is what the panel the user acted in shows (`ThreadID`, `ProjectID`, …): a
shared instance (scope `pr`, `project`, `global`) learns from it which thread a click came
from (capability `act.context`; empty from an older host). What the panel lacks is empty:
beside a page with no thread (Projects, Usage) `ThreadID` is "", so a thread action
there checks for it and answers with an error ("open a thread first"). `Version` is the view version
acted on. The host takes the kind, event, data and form
from its own copy of that version, so a client cannot forge them; the plugin still
validates `Values`. Return an error to refuse (its message is shown to the user); render
the result. `code-foundry plugin act <name> <surface> <event> [--key k] [--values '{"name":"Ada"}']`
does the same from the CLI.
