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
`dense` draws 24 px single-line rows: `line2` and labelled buttons are **not shown**
(icon-only buttons and `trailing` are), so leave it off when line 2 carries something
the user needs. `emptyText` shows when there are no rows.

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
when its filter is on and render again. In the side panel the cards wrap onto balanced
rows rather than shrink below 100 px (three fit; four go two by two) and the figure drops
to a smaller type size so it never wraps; on a wide page one row of large figures. Use
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
the side panel are a few px each, a bar is at most 40 px wide). For one operation's
progress use `progress`; for a run of results over time, bars.

Check `h.HasCapability("view.node.stats")` / `"view.node.bars"` before sending them: an
older host refuses the view. Neither goes in a toolbar, footer or group.
