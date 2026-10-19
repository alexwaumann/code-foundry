package ui_test

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Known issues found by the layout fuzzing pass (/tmp/cf-layout-fuzz/sdk.md). They fail
// today; set CF_KNOWN_ISSUES=1 to run them (the fix agent turns each into a plain test).
func knownIssue(t *testing.T) {
	t.Helper()
	if os.Getenv("CF_KNOWN_ISSUES") == "" {
		t.Skip("known issue (sdk.md); CF_KNOWN_ISSUES=1 runs it")
	}
}

// deepTabs is a view of levels nested tabs nodes with tabs tabs each, under 1 MiB (the
// daemon's raw view cap) and inside encoding/json's nesting limit.
func deepTabs(levels, tabs int) []byte {
	var b strings.Builder
	b.WriteString(`{"nodes":[`)
	for i := range levels {
		fmt.Fprintf(&b, `{"key":"k%d","tabs":{"active":"a%d-0","items":[`, i, i)
		for j := range tabs {
			if j > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, `{"key":"a%d-%d","label":"A"}`, i, j)
		}
		b.WriteString(`],"children":[`)
	}
	b.WriteString(`{"key":"leaf","text":{"content":"x"}}`)
	for range levels {
		b.WriteString(`]}}`)
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

// Validate stores every key's path; past MaxDepth it keeps descending, so a deep view's
// paths cost O(depth²): a 978 KB view of 3300 nested tabs nodes allocates gigabytes (1.7
// GB in use at the peak in the daemon's validateView). A refused subtree should cost
// little.
func TestKnownDeepViewCostIsBounded(t *testing.T) {
	knownIssue(t)
	raw := deepTabs(3300, 8)
	if len(raw) > 1<<20 {
		t.Fatalf("%d bytes", len(raw))
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if v.Validate() == nil {
		t.Fatal("accepted")
	}
	runtime.ReadMemStats(&after)
	if mb := (after.TotalAlloc - before.TotalAlloc) >> 20; mb > 64 {
		t.Errorf("Validate of a %d KB view allocated %d MB", len(raw)>>10, mb)
	}
}

// A fieldset field may have a change action: Validate accepts it, the host never indexes
// it (a fieldset is not a control), so it can never fire.
func TestKnownFieldsetChangeAccepted(t *testing.T) {
	knownIssue(t)
	fs := ui.NewFieldset("fs", "Set", ui.TextField("q", "q", "Q"))
	fs.Change = ui.EventAction("changed", "")
	if err := (ui.View{Nodes: []ui.Node{ui.NewForm("f", nil, fs)}}).Validate(); err == nil {
		t.Error("a fieldset's change action is accepted")
	}
}

// With MaxProblems problems or more, the view-wide ones (elements, log nodes, encoded
// size) are added last and only counted: a view over MaxElements with 50 bad labels
// never says it is over.
func TestKnownViewWideProblemsHidden(t *testing.T) {
	knownIssue(t)
	rows := make([]ui.Row, ui.MaxElements+1)
	for i := range rows {
		rows[i] = ui.NewRow(fmt.Sprintf("r%d", i), "")
	}
	msgs := problems((ui.View{Nodes: []ui.Node{ui.NewList("l", rows...)}}).Validate())
	if !strings.Contains(strings.Join(msgs, "\n"), "elements, at most") {
		t.Errorf("the elements problem is not named: %d messages, last %q", len(msgs), msgs[len(msgs)-1])
	}
}

// A master-detail row's own selected is ignored (the node's selected decides), and a
// detail while nothing is selected is never drawn: both validate silently.
func TestKnownMasterDetailIgnoredState(t *testing.T) {
	knownIssue(t)
	row := ui.NewRow("r1", "Run")
	row.Selected = true
	for name, md := range map[string]ui.Node{
		"row selected":            ui.NewMasterDetail("md", ui.List{Rows: []ui.Row{row}}, ""),
		"detail with no selected": ui.NewMasterDetail("md", ui.List{Rows: []ui.Row{ui.NewRow("r1", "Run")}}, "", ui.NewText("t", ui.Plain("hidden"))),
	} {
		if err := (ui.View{Nodes: []ui.Node{md}}).Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
