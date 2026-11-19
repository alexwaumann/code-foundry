package command_test

import (
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// layout.threads-open-as.preview says what switching would close and move, and changes
// nothing (docs/notes/threads-open-as-1-rules.md).
func TestThreadsOpenAsPreview(t *testing.T) {
	tests := []struct {
		to   string
		want command.ThreadsOpenAsPreview
		msg  string
	}{
		{"panes", command.ThreadsOpenAsPreview{To: "panes", Conformed: core.Conformed{Moved: 1, Spaces: 1}}, "would move 1 tab out of thread panes, in 1 space"},
		{"single", command.ThreadsOpenAsPreview{To: "single", Conformed: core.Conformed{Moved: 1, Spaces: 1}}, "would move 1 tab"},
		{"tabs", command.ThreadsOpenAsPreview{To: "tabs"}, "changes nothing"},
	}
	for _, tt := range tests {
		t.Run(tt.to, func(t *testing.T) {
			f := newLayoutFixture(t)
			before := f.store.Snapshot().Rev
			res := f.must(t, fromCLI, "layout.threads-open-as.preview", map[string]string{"to": tt.to})
			if got, ok := res.JSON.(command.ThreadsOpenAsPreview); !ok || got != tt.want {
				t.Errorf("json %+v, want %+v", res.JSON, tt.want)
			}
			if !strings.Contains(res.Message, tt.msg) {
				t.Errorf("message %q, want %q in it", res.Message, tt.msg)
			}
			if f.store.Snapshot().Rev != before {
				t.Error("the preview changed the layout")
			}
		})
	}
	f := newLayoutFixture(t)
	if _, err := f.run(t, fromCLI, "layout.threads-open-as.preview", map[string]string{"to": "grid"}); err == nil {
		t.Error("--to grid was accepted")
	}
}

// thread.open under the three settings: tabs adds a tab, panes replaces the thread shown or
// opens beside with --beside or from a parent with --from, single replaces always and refuses
// --beside with an error that names the setting and what to do.
func TestThreadOpenThreadsOpenAs(t *testing.T) {
	const lead, child, other = "s-aaaa00000001", "s-chld00000001", "s-othr00000001"
	tests := []struct {
		name   string
		mode   core.Mode
		args   map[string]string
		panes  int // panes holding a thread after
		tabs   int // thread tabs after
		msg    string
		refuse string
	}{
		{"tabs: a tab beside the other", core.ModeTabs, map[string]string{"id": other}, 1, 2, "opened thread", ""},
		{"panes: replaces the thread shown", core.ModePanes, map[string]string{"id": other}, 1, 1, "thread " + lead + "'s tab closed", ""},
		{"panes: --beside the lead", core.ModePanes, map[string]string{"id": other, "beside": lead}, 2, 2, "opened thread", ""},
		{"panes: --from the child's lead opens beside it", core.ModePanes, map[string]string{"id": child, "from": lead}, 2, 2, "opened thread", ""},
		{"panes: --from a thread that did not create it replaces", core.ModePanes, map[string]string{"id": other, "from": child}, 1, 1, "tab closed", ""},
		{"single: replaces", core.ModeSingle, map[string]string{"id": child, "from": lead}, 1, 1, "tab closed", ""},
		{"single: --beside refused", core.ModeSingle, map[string]string{"id": other, "beside": lead}, 0, 0, "", "threads open as single"},
		{"--beside with --pane refused", core.ModePanes, map[string]string{"id": other, "beside": lead, "pane": "p-left"}, 0, 0, "", "--beside is a place of its own"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t).wide(t)
			f.store.Mode = tt.mode
			f.thread.Others = []*v1.Thread{{Id: child, CreatedBy: lead}, {Id: other}}
			res, err := f.run(t, fromCLI, "thread.open", tt.args)
			if tt.refuse != "" {
				if err == nil || !strings.Contains(err.Error(), tt.refuse) {
					t.Fatalf("err %v, want %q in it", err, tt.refuse)
				}
				if tt.mode == core.ModeSingle && connect.CodeOf(err) != connect.CodeFailedPrecondition {
					t.Errorf("code %v, want failed_precondition", connect.CodeOf(err))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res.Message, tt.msg) {
				t.Errorf("message %q, want %q in it", res.Message, tt.msg)
			}
			panes, tabs := 0, 0
			for _, p := range core.Panes(f.state().Space("sp-main").Root) {
				n := 0
				for _, tb := range p.Tabs {
					if tb.Kind == "thread" {
						n++
					}
				}
				if n > 0 {
					panes++
				}
				tabs += n
				if tt.mode.Panes() && n > 0 && len(p.Tabs) != 1 {
					t.Errorf("thread pane %s holds %d tabs", p.ID, len(p.Tabs))
				}
			}
			if panes != tt.panes || tabs != tt.tabs {
				t.Errorf("%d thread tabs in %d panes, want %d in %d", tabs, panes, tt.tabs, tt.panes)
			}
		})
	}
}

// composer.new --beside (a thread pane's "+", New thread beside): a composer in a new pane on
// the right of the thread's pane, which keeps its thread; refused under single as
// thread.open --beside is, and with --pane.
func TestComposerNewBeside(t *testing.T) {
	const lead = "s-aaaa00000001"
	tests := []struct {
		name   string
		mode   core.Mode
		args   map[string]string
		refuse string
	}{
		{"panes: beside the thread's pane", core.ModePanes, map[string]string{"beside": lead}, ""},
		{"tabs: beside too", core.ModeTabs, map[string]string{"beside": lead}, ""},
		{"single: refused", core.ModeSingle, map[string]string{"beside": lead}, "threads open as single"},
		{"with --pane: refused", core.ModePanes, map[string]string{"beside": lead, "pane": "p-left"}, "--beside is a place of its own"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t).wide(t)
			f.store.Mode = tt.mode
			before := core.PaneIDs(f.state().Space("sp-main").Root)
			res, err := f.run(t, fromApp, "composer.new", tt.args)
			if tt.refuse != "" {
				if err == nil || !strings.Contains(err.Error(), tt.refuse) {
					t.Fatalf("err %v, want %q in it", err, tt.refuse)
				}
				if tt.mode == core.ModeSingle && connect.CodeOf(err) != connect.CodeFailedPrecondition {
					t.Errorf("code %v, want failed_precondition", connect.CodeOf(err))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			r := res.JSON.(command.LayoutResult)
			sp := f.state().Space("sp-main")
			if slices.Contains(before, r.Pane) {
				t.Errorf("the composer opened in pane %s, which was there before; want a new pane", r.Pane)
			}
			if sp.Focus != r.Pane {
				t.Errorf("focus %s, want the composer's pane %s", sp.Focus, r.Pane)
			}
			threadOpen := false
			for _, p := range core.Panes(sp.Root) {
				for _, tb := range p.Tabs {
					threadOpen = threadOpen || (tb.Kind == "thread" && tb.Thread == lead)
				}
			}
			if !threadOpen {
				t.Errorf("thread %s's tab closed; New thread beside keeps it", lead)
			}
		})
	}
}
