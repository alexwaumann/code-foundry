package main

import (
	"cmp"
	"fmt"
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The Runs tab's tables, under its master-detail (docs/notes/plugin-table.md): a table of
// the last 30 builds (charts.go's demoBuilds) whose #, Branch and Duration headers sort it,
// with a status glyph and a pill, a row menu, a Rerun button on the failed builds (folded
// into the ⋯ at panel width), and columns that drop as the panel narrows; under it a dense
// table of one build's tests in groups (Passed starts collapsed).

// buildsState is the Builds table's order.
type buildsState struct {
	sort ui.TableSort
}

func newBuilds() buildsState {
	return buildsState{sort: ui.TableSort{Column: "b-num", Dir: ui.SortDesc}}
}

// act sorts the table (a sort act on one of its headers).
func (s *buildsState) act(act pluginsdk.SurfaceAct) error {
	switch act.Key {
	case "b-num", "b-branch", "b-dur":
	default:
		return fmt.Errorf("the builds table does not sort by %q", act.Key)
	}
	s.sort = ui.TableSort{Column: act.Key, Dir: ui.SortAsc}
	if act.Descending() {
		s.sort.Dir = ui.SortDesc
	}
	return nil
}

// buildWords are a status's pill and its tone.
var buildWords = map[ui.Status]struct {
	word string
	tone ui.Tone
}{
	ui.StatusOK:      {"passed", ui.ToneOK},
	ui.StatusFailed:  {"failed", ui.ToneError},
	ui.StatusOff:     {"aborted", ui.ToneMuted},
	ui.StatusRunning: {"running", ui.ToneNeutral},
}

func buildsNodes(s buildsState) []ui.Node {
	builds := demoBuilds()
	slices.SortStableFunc(builds, func(a, b demoBuild) int {
		var c int
		switch s.sort.Column {
		case "b-branch":
			c = cmp.Compare(a.branch, b.branch)
		case "b-dur":
			c = cmp.Compare(a.secs, b.secs)
		}
		if c == 0 {
			c = cmp.Compare(a.n, b.n)
		}
		if s.sort.Dir == ui.SortDesc {
			c = -c
		}
		return c
	})
	cols := []ui.TableColumn{
		ui.TableCol("b-num", "#").WithWidth(72).WithPriority(9).AsSortable(ui.SortDesc),
		ui.TableCol("b-status", "Status").WithWidth(72).WithPriority(3),
		ui.TableCol("b-branch", "Branch").WithWeight(2, 84).WithStyle(ui.CellMono).WithPriority(6).AsSortable(ui.SortAsc),
		ui.TableCol("b-cause", "Cause").WithWeight(3, 140).WithPriority(1),
		ui.TableCol("b-by", "Started by").WithWidth(88).WithStyle(ui.CellMuted).WithPriority(2),
		ui.TableCol("b-dur", "Duration").WithWidth(80).AlignEnd().WithStyle(ui.CellMono).WithPriority(7).AsSortable(ui.SortDesc),
		ui.TableCol("b-age", "Age").WithWidth(40).AlignEnd().WithStyle(ui.CellCaption).WithPriority(5),
	}
	rows := make([]ui.TableRow, len(builds))
	for i, b := range builds {
		n := fmt.Sprint(b.n)
		w := buildWords[b.status]
		cause, by := ui.Plain("push · 1 commit"), []string{"timer", "kim", "sam"}[b.n%3]
		switch b.status {
		case ui.StatusFailed:
			cause = ui.Spans(ui.T("integration · 3 failed").WithTone(ui.ToneError))
		case ui.StatusOff:
			cause = ui.Plain("aborted by " + by)
		}
		dur := ui.Spans(ui.For(time.Duration(b.secs) * time.Second))
		if b.status == ui.StatusOff {
			dur = ui.Plain("—")
		}
		age := b.ago
		if age != "now" {
			age = age[:len(age)-len(" ago")]
		}
		r := ui.NewTableRow("b-"+n, map[string]ui.Cell{
			"b-num":    ui.StatusCell(b.status, "#"+n),
			"b-status": ui.PillCell(w.word, w.tone),
			"b-branch": ui.TextCell(b.branch),
			"b-cause":  ui.InlineCell(cause),
			"b-by":     ui.TextCell(by),
			"b-dur":    ui.InlineCell(dur),
			"b-age":    ui.TextCell(age),
		}).WithAction(ui.EventAction("open-build", n)).WithMenu(buildMenu(n, b.status))
		if b.status == ui.StatusFailed {
			r = r.WithButtons(ui.EventButton("b-"+n+"-rerun", "Rerun", "rerun-run").WithData(n).WithIcon("rotate-ccw"))
		}
		rows[i] = r
	}
	table := ui.NewTable("builds", cols, rows...)
	total := 1288
	table.Table.Title, table.Table.Count, table.Table.EmptyText = "Builds", &total, "No builds yet"
	sort := s.sort
	table.Table.Sort = &sort
	return []ui.Node{table, testsTable()}
}

// buildMenu is a build's ⋯ and right-click menu; a running build's can abort it.
func buildMenu(n string, st ui.Status) *ui.Menu {
	url := "https://github.com/alexwaumann/code-foundry/actions"
	items := []ui.MenuItem{
		ui.EventItem("b-"+n+"-rebuild", "Rebuild", "rerun-run", n),
		ui.EventItem("b-"+n+"-console", "Open console", "open-log", n),
		ui.Separator(),
		ui.URLItem("b-"+n+"-open", "Open in CI", url),
		ui.CopyItem("b-"+n+"-copy", "Copy link", url),
	}
	if st == ui.StatusRunning {
		items = append(items, ui.Separator(), ui.EventItem("b-"+n+"-abort", "Abort", "abort-build", n).AsDanger())
	}
	return ui.NewMenu(items...)
}

// testsTable is build #1285's tests in groups: Failed, Flaky, and Passed (its count is all
// 142; it starts collapsed).
func testsTable() ui.Node {
	cols := []ui.TableColumn{
		ui.TableCol("t-name", "Test").WithWeight(3, 120).WithStyle(ui.CellMono).WithPriority(9),
		ui.TableCol("t-pkg", "Package").WithWeight(2, 96).WithStyle(ui.CellMuted).WithPriority(1),
		ui.TableCol("t-time", "Time").WithWidth(56).AlignEnd().WithStyle(ui.CellMono).WithPriority(5),
	}
	row := func(name, pkg string, ms int64, st ui.Status) ui.TableRow {
		key := "t-" + name
		cell := ui.TextCell(name)
		if st != ui.StatusNone {
			cell = ui.StatusCell(st, name)
		}
		return ui.NewTableRow(key, map[string]ui.Cell{"t-name": cell, "t-pkg": ui.TextCell(pkg), "t-time": ui.InlineCell(ui.Spans(ui.For(time.Duration(ms) * time.Millisecond)))})
	}
	passed := []ui.TableRow{}
	for i, name := range []string{"TestAuthLogin", "TestAuthRefresh", "TestProjectAdd", "TestProjectRename", "TestThreadSend", "TestThreadWait", "TestTerminalAttach", "TestPluginAct"} {
		passed = append(passed, row(name, []string{"api/auth", "store/project", "store/thread", "store/plugin"}[i/2], int64(300+i*170), ui.StatusNone))
	}
	t := ui.NewGroupedTable("tests", cols,
		ui.NewTableGroup("tests-failed", "Failed",
			row("TestCleanupKeepsDirty", "store/project", 2400, ui.StatusFailed),
			row("TestWorktreeRemoveRace", "store/project", 5100, ui.StatusFailed)),
		ui.NewTableGroup("tests-flaky", "Flaky",
			row("TestWatchReconnects", "api/stream", 8200, ui.StatusAttention)),
		ui.NewTableGroup("tests-passed", "Passed", passed...).WithCount(142).AsCollapsed(),
	)
	t.Table.Title, t.Table.Dense = "Tests in #1285", true
	return t
}
