package main

import (
	"fmt"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// layoutNodes is the demo's Layout tab: the layout containers. Two columns (a pane with a
// log and a list beside markdown and facts) that stack in the side panel, and a
// collapse-first pair whose second column (the assistant thread in a fill pane) shows only
// where the columns fit side by side.
func layoutNodes(threadID string, err error) []ui.Node {
	intro := ui.NewText("layout-intro", ui.Plain("Columns sit side by side where they fit (240 px a column) and stack in order where they do not, as in the side panel."))
	lines := make([]ui.LogLine, 0, 24)
	for i := 1; i <= 24; i++ {
		ln := ui.LogLine{Text: fmt.Sprintf("step %02d  ok", i)}
		switch i {
		case 9:
			ln = ui.LogLine{Text: "step 09  retrying flaky test", Tone: ui.ToneAttention}
		case 17:
			ln = ui.LogLine{Text: "step 17  cache miss", Tone: ui.ToneMuted}
		}
		lines = append(lines, ln)
	}
	runs := ui.Node{Key: "layout-runs", List: &ui.List{Dense: true, Rows: []ui.Row{
		{Key: "layout-run-3", Glyph: ui.StatusGlyph(ui.StatusRunning), Title: "Build #3", Trailing: ui.Plain("main")},
		{Key: "layout-run-2", Glyph: ui.StatusGlyph(ui.StatusFailed), Title: "Build #2", Trailing: ui.Plain("cf/fix")},
		{Key: "layout-run-1", Glyph: ui.StatusGlyph(ui.StatusOK), Title: "Build #1", Trailing: ui.Plain("main")},
	}}}
	main := ui.NewColumns("layout-cols",
		ui.NewColumn("layout-left",
			ui.NewPane("layout-pane", ui.HeightPx(320),
				ui.Node{Key: "layout-log", Log: &ui.Log{Title: "build 3", Lines: lines}},
				runs,
			),
		).WithWeight(2),
		ui.NewColumn("layout-right",
			ui.NewMarkdown("layout-md", "**Columns** take a weight (1 to 6) or a fixed width. A **pane** is a box with its own height and scroll: the log and the runs beside this scroll inside theirs."),
			ui.NewPairs("layout-facts",
				ui.NewPair("layout-f-cols", "Columns", ui.Plain("2 to 4")),
				ui.NewPair("layout-f-min", "Side by side", ui.Plain("240 px a column")),
				ui.NewPair("layout-f-gap", "Gap", ui.Plain("12 px")),
			),
		),
	)
	summary := ui.NewText("layout-summary", ui.Spans(ui.T("The assistant's thread is the second column here: "),
		ui.T("collapse: first").AsMono(), ui.T(" drops it where the columns stack.")))
	var chat ui.Node
	if err != nil {
		chat = ui.NewNotice("layout-chat-error", ui.ToneError, "No assistant", ui.Plain(err.Error()))
	} else {
		chat = ui.Node{Key: "layout-chat-pane", Pane: &ui.Pane{Height: ui.HeightFill, MinHeight: 320, NoScroll: true, Children: []ui.Node{
			{Key: "layout-thread", Thread: &ui.Thread{ThreadID: threadID, Placeholder: "Message the assistant…", Height: ui.HeightFill}},
		}}}
	}
	detail := ui.NewColumns("layout-detail", ui.NewColumn("layout-detail-summary", summary), ui.NewColumn("layout-detail-chat", chat).WithWeight(2))
	detail.Columns.Collapse = ui.CollapseFirst
	return []ui.Node{intro, main, detail}
}
