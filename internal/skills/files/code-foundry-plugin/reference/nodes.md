# Display nodes

{{cf.provenance}}

Nodes that show things. Go examples; JSON keys are the lowerCamel field names. Value types (tone, status, inline, pill, glyph, button, action): `primitives.md`. Forms: `forms.md`. Layout: `ui-layout.md`.

## text

```go
ui.NewText("summary", ui.Spans(ui.T("3 of 5 jobs passed"), ui.T(" · 2 failed").WithTone(ui.ToneError)))
ui.Node{Key: "code", Text: &ui.Text{Content: ui.Plain("WDJB-MJHT"), Size: ui.TextLg, Copyable: true}}
```

`size`: `""` (13 px), `sm` (12 px, muted), `lg` (18 px mono, for a code to type
elsewhere). `copyable` adds a copy button. Up to 4 KB.

## markdown

```go
ui.NewMarkdown("help", "Rerun **failed** jobs only. See [the docs](https://docs.github.com/actions).")
```

GitHub-flavoured, up to 16 KB, for explanations; raw HTML shows as text; links open in
the browser.

## pairs

```go
ui.NewPairs("facts",
	ui.Pair{Key: "branch", Label: "Branch", Value: ui.Spans(ui.T("cf/fix-login").AsMono()), Copyable: true},
	ui.Pair{Key: "status", Label: "Status", Pill: ui.NewPill("passing", ui.ToneOK)},
	ui.NewPair("took", "Took", ui.Spans(ui.For(95*time.Second))))
```

Facts about one thing: a label (40 characters) and a value or a pill.

## list

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
`dense` draws 24 px single-line rows: `line2` is **not shown** and labelled buttons fold
into the row's ⋯ (icon-only buttons and `trailing` stay), so leave it off when line 2
carries something the user needs. `emptyText` shows when there are no rows. A row's
`menu` is below.

## menus

```go
row.Menu = ui.NewMenu(
	ui.EventItem("CF-407-start", "Start a thread on this", "start", "CF-407"), // act.Key, act.Data
	ui.Separator(),
	ui.Submenu("CF-407-move", "Move to", ui.PickGroup("status", "CF-407-review", // the checked key
		ui.EventItem("CF-407-todo", "To do", "move", "todo"),
		ui.EventItem("CF-407-review", "In review", "move", "review"))...),
	ui.URLItem("CF-407-open", "Open in Jira", url), ui.CopyItem("CF-407-copy", "Copy key", "CF-407"),
	ui.Separator(),
	ui.CommandItem("CF-407-del", "Delete", "plugin.jira.delete", map[string]string{"key": "CF-407"}).AsDanger())
header.Menu = ui.NewMenu(ui.EventItem("rebuild-all", "Rebuild all", "rebuild-all", ""))
ui.Button{Key: "rebuild", Label: "Rebuild", Style: ui.ButtonOutline}.WithMenu(ui.NewMenu(...)) // "Rebuild ▾"
```

A menu holds the less frequent actions; keep the one or two a user does most as buttons.
It goes on a list row (`Row.Menu`, a master-detail's too: a ⋯ "More options" on hover and
focus, and the same menu on a right-click or Shift+F10), the header (`Header.Menu`, a ⋯
after its 2 icon actions) or a button in an actions bar, section, notice, empty state or
terminal (`Button.Menu`, a chevron after its label; set `action` or `menu`, not both). Not
on a header's, row's or form's buttons: give the header or row a menu. Items are text
only (no icons, no shortcuts) and each is one of an action, a one-level submenu or a
separator (never first, last or doubled). `AsDisabled()` dims an item; `AsDanger()` draws
it red. `PickGroup` makes adjacent items one-pick (a check at the `checked` one, at most
one): the pick is a click like any item's, and the plugin answers with the check moved.
Picking runs the item's action as a button's (a `click` act with the item's key and data;
commands confirm, URLs and copies stay in the host). 24 entries per menu or submenu,
labels 60 characters; items count as elements and share the view's keys
(`plugintest.Host.PickItem` picks one in a test). **The fold:** a row narrower than its
buttons need beside about 200 px of title (three buttons in a 420 px pane, not two)
shows them in its ⋯ instead, first, then a separator, then its menu; a wider pane or full
screen shows the buttons. A row with buttons and no menu gets a ⋯ only while folded.
`h.HasCapability("view.menu")`: an older host drops menus.

**Interactive rows** (a to-do list; capability `view.list.rows`):

```go
ui.NewList("todo", ui.NewRow("t1", "Write the notes").AsEditable(), ui.NewRow("t2", "Ship it").AsChecked(true)).
	AsCheckable().AsReorderable().WithAddRow("Add a task", false) // true: the input under the rows
```

`checkable` puts a checkbox in every row's glyph slot (rows have no `glyph`; `checked`
ticks one, its title struck through); `reorderable` shows a grip on hover or focus, to
drag a row or move it with alt+↑/↓; `add` is a one-line input (Enter sends, empty sends
nothing, cleared once you take it, kept when you refuse); an `editable` row's title is
renamed in place (double-click it or F2; Enter too on a row without an `action`, which
Enter runs otherwise; Enter or leaving commits, Escape cancels, an empty or unchanged
title sends nothing). Each sends an act (`primitives.md`, "Acts") that the host shows at
once and undoes if you return an error: answer with the view that has the change. Not on
a `masterDetail`'s list. At 420 px nothing is hidden: grip and checkbox take 36 px.

## chips

```go
ui.NewChips("stages",
	ui.Chip{Key: "build", Label: "Build", Status: ui.StatusOK, Meta: ui.Spans(ui.For(31 * time.Second))},
	ui.Chip{Key: "test", Label: "Test", Status: ui.StatusRunning, Selected: true, Action: ui.EventAction("stage", "test")},
	ui.NewChip("deploy", "Deploy", ui.StatusPending))
```

Stages or steps in a wrapping strip; labels up to 32 characters (keep them short: at
280 px a line holds one or two chips). A cut label shows whole on hover unless `hint` is set.

## log

```go
ui.Node{Key: "out", Log: &ui.Log{Title: "test (ubuntu)", Rows: 12, Wrap: true, Text: tail}}
ui.Node{Key: "lint", Log: &ui.Log{Lines: []ui.LogLine{{Text: "checking 42 files"}, {Text: "warning: unused x", Tone: ui.ToneAttention}}}}
h.AppendLog(instance, "out", "ok   pkg/c\n")
h.AppendLogLines(instance, "lint", pluginsdk.AppendLine{Text: "error: x", Tone: "error"})
ui.NewANSILog("console", consoleText) // Log{Text, ANSI: true}: the text's own colours
```

A monospace tail that follows new output (`noFollow` stops that), `rows` 4..40 (default
16), `wrap` long lines, `truncated` to say the head was cut. `text` or `lines` (each with
a tone), not both. Up to 64 KB per render (escapes count) and 4 log nodes per view; stream
more with the append calls.

`ansi: true` (capability `view.log.ansi`) reads the text's SGR escapes: the 16 colours,
their bright and background forms, bold, dim, italic, underline and reset, drawn in the
theme's terminal palette (they follow light, dark and user themes); 256-colour and
truecolor become the nearest of the 16. Every other escape (cursor moves, erases, titles,
links) is dropped, a carriage return inside a line keeps what follows it (a progress line
redrawn), and a style carries to the next line as in a terminal. A colour beats the line's
tone where it is set; Copy copies the text without escapes. Without `ansi`, or on an older
host, escapes show raw: send `ui.StripANSI(s)` there.

## actions

```go
ui.Node{Key: "bar", Actions: &ui.Actions{Align: ui.AlignEnd, Buttons: []ui.Button{
	ui.CommandButton("send", "Send failure to Claude", "plugin.ci.send-failure", nil).WithStyle(ui.ButtonAttention).WithIcon("send"),
	ui.URLButton("open", "Open on GitHub", runURL).WithIcon("external-link"),
}}}
// or: ui.NewActions("bar", buttons...)
```

A wrapping row of up to 6 buttons. Buttons are never free nodes: they live in a header,
row, section, notice, empty state, actions bar or form.

## progress

```go
ui.Node{Key: "upload", Progress: &ui.Progress{Value: ui.Fraction(0.62), Label: "Uploading artifacts", Meta: ui.Plain("62 of 100 MB")}}
ui.NewProgress("wait", "Waiting for a runner", nil) // nil value: indeterminate
```

`tone: "error"` when it failed.

## notice

```go
ui.Node{Key: "auth", Notice: &ui.Notice{Tone: ui.ToneAttention, Icon: "key-round", Title: "Sign in needed",
	Body: ui.Plain("The CI server wants a token."), Detail: "HTTP 401 from https://ci.acme.com/api",
	Actions: []ui.Button{ui.EventButton("auth-go", "Add a token", "goto-settings").WithStyle(ui.ButtonAttention)}}}
// or: ui.NewNotice("auth", ui.ToneAttention, "Sign in needed", ui.Plain("…"))
```

A state the user should know about: tone neutral, `attention` or `error`; `detail` is
monospace (2 KB, an error's text); up to 3 buttons.

## empty

```go
ui.Node{Key: "none", Empty: &ui.Empty{Glyph: ui.IconGlyph("package", ui.ToneMuted), Title: "No runs",
	Body: ui.Plain("Push a commit to start one."), Actions: []ui.Button{ui.EventButton("refresh", "Refresh", "refresh")}}}
// or: ui.NewEmpty("none", "No runs", ui.Plain("…"))
```

The whole body when there is nothing yet; up to 2 buttons.

## section

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
Up to 2 buttons sit at the end of the title row, after the pill. A node sits inside at
most 4 containers (`primitives.md`, "Which node").


## stats

```go
failing := ui.NewStat("failing", "Failing", "2").WithTone(ui.ToneError).
	WithSubtitle(ui.Plain("integration · e2e")).WithAction(ui.EventAction("filter", "failed"))
if onlyFailed {
	failing = failing.AsPressed() // the filter is on: the card shows pressed, the others dim
}
ui.NewStats("figures",
	ui.NewStat("pass", "Pass rate", "86%").WithTone(ui.ToneOK).WithSubtitle(ui.Plain("last 30 builds")),
	ui.NewStat("median", "Median time", "4m 12s").WithSubtitle(ui.Spans(ui.T("p90 "), ui.For(361*time.Second))),
	failing)
```

A row of 1 to 6 figure cards, the app's Pull Requests counts: a label (40 characters),
the figure (`value`, a string you format: `"86%"`, `"4m 12s"`, `"1,288"`; 24 characters,
one line) and a one-line `subtitle`. `tone` colours the figure: `ok` emerald, `attention`
amber, `error` red, `muted`. A card with an `action` is a toggle (a filter): set `pressed`
when its filter is on and render again. In a narrow pane the cards wrap onto balanced
rows rather than shrink below 100 px (three fit in 360 px; four go two by two) and the
figure drops to a smaller type size so it never wraps; wide, one row of large figures. Use
stats for the few numbers someone checks first; for many facts about one thing, `pairs`.

## bars

```go
bars := make([]ui.Bar, len(builds))
for i, b := range builds {
	bars[i] = ui.NewBar("build-"+b.ID, "#"+b.ID+" · "+b.Took, b.Seconds).WithStatus(b.Status).
		WithMeta(ui.Spans(ui.T(b.Branch+" · "), ui.At(b.Started, ui.TimeRelative))).
		WithAction(ui.EventAction("open-build", b.ID))
}
chart := ui.NewBars("times", "Build time", bars...)
chart.Bars.Subtitle = ui.Plain("last 30 builds")
chart.Bars.Reference = &ui.BarsReference{Value: median, Label: "median 4m 12s"}
chart.Bars.StartLabel, chart.Bars.EndLabel = "#1259", "#1288"
```

A small bar chart in a card: up to 120 bars, oldest first, each a finite `value` ≥ 0
(any unit: only the ratios show; the top is the highest bar or the reference). Colour a
bar by `status` (`ok` emerald, `failed` red, `attention` amber, `running` a hollow blue
bar, `pending`/`skipped`/`off` muted) or by `series` 1..5 (the app's chart palette), not
both. `title` (required) and `meta` are the tooltip the host draws on hover or arrow keys;
`action` acts on a click or Enter. The reference line's label shows in the card's top
right; `startLabel`/`endLabel` under the first and last bar. Bars share the width (120 in
a 400 px pane are a few px each, a bar is at most 40 px wide). For one operation's
progress use `progress`; for a run of results over time, bars.

Check `h.HasCapability("view.node.stats")` / `"view.node.bars"` before sending them: an
older host refuses the view. Neither goes in a toolbar, footer or group.

## table

```go
cols := []ui.TableColumn{
	ui.TableCol("b-num", "#").WithWidth(72).WithPriority(9).AsSortable(ui.SortDesc),
	ui.TableCol("b-branch", "Branch").WithWeight(2, 84).WithStyle(ui.CellMono).WithPriority(6).AsSortable(ui.SortAsc),
	ui.TableCol("b-cause", "Cause").WithWeight(3, 140).WithPriority(1),
	ui.TableCol("b-dur", "Duration").WithWidth(80).AlignEnd().WithStyle(ui.CellMono).WithPriority(7),
}
rows := []ui.TableRow{ui.NewTableRow("b-1288", map[string]ui.Cell{ // cells by column key
	"b-num":    ui.StatusCell(ui.StatusRunning, "#1288"),
	"b-branch": ui.TextCell("main"),
	"b-dur":    ui.InlineCell(ui.Spans(ui.For(130 * time.Second))),
}).WithAction(ui.EventAction("open-build", "1288")).WithMenu(buildMenu("1288"))}
t := ui.NewTable("builds", cols, rows...)
t.Table.Title, t.Table.Count = "Builds", &total // "Builds (1288)"
t.Table.Sort = &ui.TableSort{Column: "b-num", Dir: ui.SortDesc}
```

Rows of short facts compared down columns, drawn like the app's Pull Requests tables: 1 to
10 columns, 300 rows. Column keys share the view's keys (prefix them) and name each row's
`cells`; a cell is an Inline (spans, times, durations, links) with an optional `Glyph`
before it and `Pill` after it (`PillCell` alone). A column is `WithWidth(px)` (16..480) or
`WithWeight(w, minPx)` (the free width, never under minPx, 80 by default); `AlignEnd` for
numbers; `Style` `CellMuted`, `CellMono`, `CellCaption`; `label` may be "" (an icon column).
**Narrow** (a pane beside a thread usually is), columns drop instead of squeezing: the
lowest `priority` first, among equals the rightmost; the highest never drops. Rank the
column that names the row highest and give the narrowest pane (480 px) 4 or 5 columns that
fit (about 450 px).
Rows take a row `action`, `menu` (⋯ and right-click, as a list row's), `selected` and up to 3
buttons, which fold into the ⋯ before any column drops. A cut cell shows whole in its
tooltip. **Sorting is yours**: a `Sortable` header's click sends a `sort` act (`Key` the
column, `Node` the table, `act.Descending()`); send the rows in that order with `Sort` set,
and the host draws the arrow. `NewGroupedTable(key, cols, ui.NewTableGroup("g-done", "Done",
rows...).WithCount(14).AsCollapsed())` puts rows under collapsible labels (the user's toggle
wins; send a collapsed group's rows too). `Dense` draws 24 px rows; `EmptyText` shows
without rows. A list reads as sentences (a title over a second line); a table when every
row has the same few facts. Check `h.HasCapability("view.node.table")`; not in a toolbar,
footer or group.

**A meter cell** is a share or a rate in a row (a suite's pass rate, a branch's share of
the builds): a thin bar the column's width with a short label after it,
`ui.MeterCell(0.86, "86%").WithMeterTone(ui.ToneAttention)`. Not for running work (that
is the `progress` node). The value is a fraction, 0 to 1 (out of range, NaN or infinite is
refused, never clamped); 0 draws the empty track. You format the label ("86%", "3 of 8",
"–"; at most 16 characters, one line): the host never formats a number. The tone colours
the fill as stats and bars do (`ok` emerald, `attention` amber, `error` red, `muted`),
neutral by default. A meter is the cell's whole content: no value, glyph or pill beside
it. In a narrow column the label goes into a tooltip and the bar stays. Check
`h.HasCapability("view.table.meter")` and send `ui.TextCell(label)` without it: an older
host drops the meter and shows an empty cell.
