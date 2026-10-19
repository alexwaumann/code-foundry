package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The demo's Runs tab: a master-detail of the Layout tab's runs (layoutRuns) whose
// detail, for the chosen run, has its facts and a tabs node of its own (Overview with a
// note form, Log with a pane holding the run's log). It makes no thread or terminal.

// runsState is the Runs tab's state: the chosen run ("" for none), the detail's tab and
// the notes saved per run (by row key).
type runsState struct {
	selected string
	tab      string // a runs tab key; "" is the overview
	notes    map[string]string
}

const (
	runsTabOverview = "runs-tab-overview"
	runsTabLog      = "runs-tab-log"
)

func runKey(n int) string { return fmt.Sprintf("runs-run-%d", n) }

// runOf is the run a row key names.
func runOf(key string) (layoutRun, bool) {
	i := slices.IndexFunc(layoutRuns, func(r layoutRun) bool { return runKey(r.n) == key })
	if i < 0 {
		return layoutRun{}, false
	}
	return layoutRuns[i], true
}

// runTook is how long run n took (the running one: so far).
func runTook(n int) time.Duration { return time.Duration(60+37*n) * time.Second }

func runsNodes(s runsState) []ui.Node {
	intro := ui.NewText("runs-intro", ui.Plain("The runs beside the chosen run's detail where there is room (a 280 px list, 12 px, at least 320 px of detail); in the side panel, the list, then the run alone under a back button."))
	rows := make([]ui.Row, 0, len(layoutRuns))
	for _, r := range layoutRuns {
		rows = append(rows, ui.Row{Key: runKey(r.n), Glyph: ui.StatusGlyph(r.glyph), Title: fmt.Sprintf("Build #%d", r.n),
			Line2: ui.Spans(ui.T(r.branch).AsMono()), Trailing: ui.Spans(ui.For(runTook(r.n)))})
	}
	var detail []ui.Node
	if r, ok := runOf(s.selected); ok {
		detail = runDetail(r, s)
	}
	md := ui.NewMasterDetail("runs-md", ui.List{Rows: rows}, s.selected, detail...)
	md.MasterDetail.EmptyDetail = &ui.Empty{Glyph: ui.IconGlyph("list", ui.ToneMuted), Title: "No run chosen",
		Body: ui.Plain("Choose a run to see its overview and its log.")}
	return []ui.Node{intro, md}
}

// runDetail is the chosen run's detail: its facts, then its own tabs.
func runDetail(r layoutRun, s runsState) []ui.Node {
	state := map[ui.Status]*ui.Pill{ui.StatusRunning: ui.NewPill("running", ui.ToneNeutral), ui.StatusFailed: ui.NewPill("failed", ui.ToneError), ui.StatusOK: ui.NewPill("passed", ui.ToneOK)}
	facts := ui.NewPairs("runs-facts",
		ui.NewPair("runs-f-branch", "Branch", ui.Spans(ui.T(r.branch).AsMono())),
		ui.Pair{Key: "runs-f-status", Label: "Status", Pill: state[r.glyph]},
		ui.NewPair("runs-f-took", "Took", ui.Spans(ui.For(runTook(r.n)))),
	)
	tab := s.tab
	if tab != runsTabLog {
		tab = runsTabOverview
	}
	tabs := ui.NewTabs(tab, ui.NewTab(runsTabOverview, "Overview"), ui.NewTab(runsTabLog, "Log"))
	if r.glyph == ui.StatusFailed {
		tabs.Items[1].Badge = ui.NewPill("1 error", ui.ToneError)
	}
	var children []ui.Node
	if tab == runsTabLog {
		children = []ui.Node{ui.NewPane("runs-log-pane", ui.HeightPx(240), ui.Node{Key: "runs-log", Log: &ui.Log{Title: fmt.Sprintf("build %d", r.n), Lines: runLog(r)}})}
	} else {
		summary := fmt.Sprintf("**Build #%d** on `%s`: %d steps. A **tabs** node gives the detail its own tabs; the note below keeps its draft per run and per tab.", r.n, r.branch, len(runLog(r)))
		submit := ui.EventButton("runs-note-save", "Save note", "runs-note")
		note := ui.NewForm("runs-note-form", &submit, ui.TextField("runs-note", "note", "Note").WithPlaceholder("Add a note to this run").WithValue(s.notes[runKey(r.n)]))
		children = []ui.Node{ui.NewMarkdown("runs-summary", summary), note}
	}
	return []ui.Node{facts, ui.NewTabsNode("runs-tabs", tabs, children...)}
}

// runLog is a run's log lines: a failed run's last step is an error.
func runLog(r layoutRun) []ui.LogLine {
	lines := make([]ui.LogLine, 0, 12)
	for i := 1; i <= 12; i++ {
		lines = append(lines, ui.LogLine{Text: fmt.Sprintf("build %d  step %02d  ok", r.n, i)})
	}
	switch r.glyph {
	case ui.StatusFailed:
		lines[11] = ui.LogLine{Text: fmt.Sprintf("build %d  step 12  FAIL: 1 test failed", r.n), Tone: ui.ToneError}
	case ui.StatusRunning:
		lines = append(lines[:8], ui.LogLine{Text: fmt.Sprintf("build %d  step 09  running…", r.n), Tone: ui.ToneMuted})
	}
	return lines
}

// selectRun chooses the run a select act names (the master-detail's row key).
func (s *runsState) selectRun(key string) error {
	if _, ok := runOf(key); !ok {
		return fmt.Errorf("no run %q", key)
	}
	s.selected = key
	return nil
}

// saveNote keeps the chosen run's note.
func (s *runsState) saveNote(values map[string]any) error {
	if s.selected == "" {
		return fmt.Errorf("no run chosen")
	}
	note, _ := values["note"].(string)
	if s.notes == nil {
		s.notes = map[string]string{}
	}
	s.notes[s.selected] = strings.TrimSpace(note)
	return nil
}
