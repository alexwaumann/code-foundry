package main

import (
	"fmt"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// layoutNodes is the demo's Layout tab: the layout nodes. Two columns (a pane with a log
// and a list beside markdown and facts) that stack in the side panel; a grid of cards (one
// column in the panel, more as it widens) under a labelled divider; inline groups; a card
// whose pane holds a flex spacer that keeps its bar at the bottom; a fixed spacer; and a
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
	groups := layoutGroups()
	return []ui.Node{intro, main, ui.NewDivider("layout-grid-rule", "Grid"), layoutGrid(),
		ui.NewDivider("layout-group-rule", "Inline groups"), groups[0], groups[1],
		ui.NewDivider("layout-rule", ""), layoutPushed(), ui.NewSpacer("layout-gap", 24), detail}
}

// layoutGrid is a grid of five cards, 200 px a column at least; the deploy card spans two.
func layoutGrid() ui.Node {
	card := func(key, title string, children ...ui.Node) ui.GridItem {
		s := ui.NewSection(key+"-card", title, children...)
		s.Section.Card = true
		return ui.NewGridItem(key, s)
	}
	half, most := 0.5, 0.82
	g := ui.NewGrid("layout-grid",
		card("layout-cell-build", "Build", ui.NewPairs("layout-build-facts",
			ui.NewPair("layout-build-branch", "Branch", ui.Plain("main")),
			ui.NewPair("layout-build-time", "Took", ui.Plain("4m 12s")))),
		card("layout-cell-tests", "Tests", ui.NewChips("layout-tests-chips",
			ui.NewChip("layout-tests-unit", "Unit", ui.StatusOK), ui.NewChip("layout-tests-e2e", "e2e", ui.StatusRunning))),
		card("layout-cell-cover", "Coverage", ui.NewProgress("layout-cover", "Lines", &most)),
		card("layout-cell-deploy", "Deploy", ui.NewText("layout-deploy-text", ui.Plain("Rolling out to 2 of 4 regions. A span-2 card takes two columns where there are two.")),
			ui.NewProgress("layout-deploy", "Regions", &half)).WithSpan(2),
		card("layout-cell-notes", "Notes", ui.NewText("layout-notes", ui.Plain("Columns: as many 200 px ones as fit, at most 6."))),
	)
	g.Grid.MinWidth = 200
	return g
}

// layoutGroups are two inline groups: a summary with its buttons at the far end, and
// chips beside a progress bar that takes the rest of the line.
func layoutGroups() [2]ui.Node {
	third := 0.34
	return [2]ui.Node{
		ui.NewGroup("layout-line", ui.AlignBetween,
			ui.NewText("layout-line-text", ui.Spans(ui.T("3 of 4").AsStrong(), ui.T(" checks passed"))),
			ui.NewActions("layout-line-bar", ui.EventButton("layout-line-rerun", "Re-run", "click"), ui.URLButton("layout-line-docs", "Docs", "https://github.com/alexwaumann/code-foundry"))),
		ui.NewGroup("layout-steps", ui.AlignStart,
			ui.NewChips("layout-steps-chips", ui.NewChip("layout-step-lint", "Lint", ui.StatusOK), ui.NewChip("layout-step-test", "Test", ui.StatusRunning)),
			ui.NewProgress("layout-steps-progress", "", &third),
			ui.NewText("layout-steps-left", ui.Spans(ui.T("about 2 min left").WithTone(ui.ToneMuted)))),
	}
}

// layoutPushed is a card whose 180 px pane keeps its bar at the bottom: a flex spacer
// takes the height the text leaves.
func layoutPushed() ui.Node {
	pane := ui.NewPane("layout-push-pane", ui.HeightPx(180),
		ui.NewText("layout-push-text", ui.Plain("A flex spacer in a pane with a height pushes what follows it to the pane's bottom.")),
		ui.NewFlexSpacer("layout-push-spacer"),
		ui.NewGroup("layout-push-bar", ui.AlignEnd, ui.NewActions("layout-push-actions", ui.EventButton("layout-push-go", "Click", "click"))),
	)
	s := ui.NewSection("layout-push", "Pinned to the bottom", pane)
	s.Section.Card = true
	return s
}
