package ui_test

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Regressions from the layout fuzzing pass (2026-10-19, docs/notes/plugins-layout-fixes-sdk.md).

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

// A node past MaxDepth is refused once and its insides are not walked: a 978 KB view of
// 3300 nested tabs nodes (8 tabs each) allocated 3.2 GB in Validate when every level
// built and kept its full path. Now it costs about what the view's own encoding does.
func TestDeepViewCostIsBounded(t *testing.T) {
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
	start := time.Now()
	msgs := problems(v.Validate())
	took := time.Since(start)
	runtime.ReadMemStats(&after)
	mb := (after.TotalAlloc - before.TotalAlloc) >> 20
	t.Logf("Validate of a %d KB view: %d MB allocated in %s", len(raw)>>10, mb, took)
	if mb > 32 {
		t.Errorf("Validate of a %d KB view allocated %d MB", len(raw)>>10, mb)
	}
	if took > 2*time.Second {
		t.Errorf("Validate of a %d KB view took %s", len(raw)>>10, took)
	}
	// One problem, at the first node past the limit, naming the containers around it.
	want := "nodes[0].tabs.children[0].tabs.children[0].tabs.children[0].tabs.children[0].tabs.children[0]: inside 5 containers (tabs > tabs > tabs > tabs > tabs), at most 4"
	if len(msgs) != 2 || msgs[0] != want || !strings.HasPrefix(msgs[1], "view: ") || !strings.HasSuffix(msgs[1], " bytes encoded (logs excluded), at most 262144") {
		t.Errorf("problems %q, want [%q, the encoded size]", msgs, want)
	}
	// A deep view with a string that is not UTF-8 at the bottom: the UTF-8 walk names it
	// without building a path at every level on the way.
	leaf := &v.Nodes[0]
	for leaf.Tabs != nil {
		leaf = &leaf.Tabs.Children[0]
	}
	leaf.Text.Content.Text = "\xff"
	runtime.GC()
	runtime.ReadMemStats(&before)
	msgs = problems(v.Validate())
	runtime.ReadMemStats(&after)
	mb = (after.TotalAlloc - before.TotalAlloc) >> 20
	t.Logf("with a bad string: %d MB allocated", mb)
	if mb > 64 {
		t.Errorf("Validate of a deep view with a bad string allocated %d MB", mb)
	}
	if len(msgs) != 3 || !strings.HasPrefix(msgs[0], "…") || !strings.HasSuffix(msgs[0], ".tabs.children[0].text.content.text: not valid UTF-8") || len(msgs[0]) > 600 {
		t.Errorf("problems %.300q", msgs)
	}
}

// A fieldset field's change action could never fire (the host does not index it: a
// fieldset is not a control): it is refused.
func TestFieldsetChangeRefused(t *testing.T) {
	fs := ui.NewFieldset("fs", "Set", ui.TextField("q", "q", "Q"))
	fs.Change = ui.EventAction("changed", "")
	if err := (ui.View{Nodes: []ui.Node{ui.NewForm("f", nil, fs)}}).Validate(); err == nil {
		t.Error("a fieldset's change action is accepted")
	}
}

// The view-wide problems (elements, log nodes, encoded size) are named past
// MaxProblems: a view over MaxElements with 401 bad titles says it is over.
func TestViewWideProblemsNamed(t *testing.T) {
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
// detail while nothing is selected is never drawn (its elements would still act from
// the CLI): both are refused.
func TestMasterDetailIgnoredStateRefused(t *testing.T) {
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
