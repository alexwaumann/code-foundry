package command_test

import (
	"context"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// other is a thread other than self, whose tab the user is on in the where tests.
const other = "s-bbbbbbbbbbb2"

// whereFixture is every command over richThread (named self) with layout st, a window open,
// and the first-load import run (imported) or not.
func whereFixture(t *testing.T, st *core.State, imported bool) (*command.Registry, *layouttest.Fake) {
	t.Helper()
	th := richThread()
	th.Id = self
	th.CheckoutPaths = []*v1.ThreadCheckoutPath{{ProjectId: "r1", Path: "/wt"}}
	store := layouttest.New(nil)
	store.Put(st)
	if imported {
		store.MarkImported()
	}
	reg, _ := panelRegistryWith(t, &commandtest.Thread{Current: th}, panelDeps{
		windows: 1,
		files:   &commandtest.Files{Files: []string{"/wt/a.go"}},
		layout:  store,
	})
	return reg, store
}

// oneSpace is space sp-main with pane p-main holding tabs, the first active and focused.
func oneSpace(tabs ...*core.Tab) *core.State {
	return &core.State{
		V: core.Version, CurrentSpace: "sp-main", DefaultSpace: "sp-main",
		Spaces: []*core.Space{{ID: "sp-main", Name: "Main", Focus: "p-main", MRU: []string{tabs[0].ID},
			Root: &core.Node{T: core.NodePane, ID: "p-main", Active: tabs[0].ID, Tabs: tabs}}},
	}
}

func threadTab(id, thread string) *core.Tab {
	return &core.Tab{ID: id, Kind: "thread", Thread: thread, Key: "thread:" + thread}
}

func fileTab(id, thread string) *core.Tab {
	return &core.Tab{ID: id, Kind: "file", Thread: thread, Key: "file:/wt/a.go", Params: map[string]string{"path": "/wt/a.go"}}
}

// An item verb from a thread whose own tab is open in no space: the tab goes to the focused
// pane of the thread's space (as the user's Open ▸ does), and the message says so instead of
// "beside the thread". Before any window has loaded the layout, the first load takes it into
// the thread's remembered set: the message says that, and the import does it.
func TestViewOpenForAThreadWhoseTabIsNotOpen(t *testing.T) {
	inOther := oneSpace(threadTab("t-o", other))
	inOther.Spaces = append(inOther.Spaces, &core.Space{ID: "sp-two", Name: "Two"})
	inOther.Threads = map[string]*core.ThreadState{self: {Space: "sp-two"}}
	tests := []struct {
		name     string
		st       *core.State
		imported bool
		want     string
		json     command.PanelResult
	}{
		{
			name: "the user on another thread's tab", st: oneSpace(threadTab("t-o", other)), imported: true,
			want: "thread " + self + "'s tab is not open, so tab t-n1 opened in pane p-main, the focused pane of its space, behind the tab shown there; windows=1",
			json: command.PanelResult{Windows: 1, Thread: self, TabThread: self, Tab: "t-n1", Pane: "p-main", Space: "sp-main", Rule: "focused", ThreadNotOpen: true, Behind: true},
		},
		{
			name: "the thread lives in a space the user is not in", st: inOther, imported: true,
			want: "thread " + self + "'s tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space (sp-two, not the space the user is in); windows=1",
			json: command.PanelResult{Windows: 1, Thread: self, TabThread: self, Tab: "t-n1", Pane: "p-n1", Space: "sp-two", Rule: "focused", ThreadNotOpen: true, OtherSpace: true},
		},
		{
			name: "no window has loaded the layout: it joins the thread's set", st: core.NewState("sp-main", "Main"),
			want: "thread " + self + "'s tab is not open, and no app window has loaded the layout yet: tab t-n1 joins the thread's set of tabs when one does, " +
				"and shows beside the thread when the thread is opened; windows=1",
			json: command.PanelResult{Windows: 1, Thread: self, TabThread: self, Tab: "t-n1", Pane: "p-n1", Space: "sp-main", Rule: "focused", ThreadNotOpen: true, JoinsSet: true},
		},
		{
			name: "no window has loaded the layout, but a thread's tab arranges the space: it stays", st: oneSpace(threadTab("t-o", other)),
			want: "thread " + self + "'s tab is not open, so tab t-n1 opened in pane p-main, the focused pane of its space, behind the tab shown there; windows=1",
			json: command.PanelResult{Windows: 1, Thread: self, TabThread: self, Tab: "t-n1", Pane: "p-main", Space: "sp-main", Rule: "focused", ThreadNotOpen: true, Behind: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, store := whereFixture(t, tt.st, tt.imported)
			res, err := reg.Invoke(context.Background(), selfCLI, "view.open.file", map[string]string{"path": "/wt/a.go"})
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message = %q\nwant      %q", res.Message, tt.want)
			}
			if got := res.JSON.(command.PanelResult); got != tt.json {
				t.Errorf("JSON = %+v\nwant   %+v", got, tt.json)
			}
			if !tt.json.JoinsSet {
				return
			}
			// What the message promised: the first load takes it into the thread's set.
			if _, err := store.ImportLegacy(context.Background(), core.LegacyInput{Threads: []core.LegacyThread{{ID: self}}}, layoutstore.ApplyOptions{}); err != nil {
				t.Fatal(err)
			}
			st := store.Snapshot().State
			if _, _, tb := st.FindTab("t-n1"); tb != nil {
				t.Errorf("tab t-n1 still open after the import")
			}
			if ts := st.Threads[self]; ts == nil || ts.Remembered == nil || len(ts.Remembered.Tabs) != 1 || ts.Remembered.Tabs[0].Tab.Kind != "file" {
				t.Errorf("thread %s remembers %+v, want the file tab", self, ts)
			}
		})
	}
}

// "Already open" names the thread whose tab it is: a file is one per path, so the open tab may
// be another thread's, or of no thread.
func TestViewOpenAlreadyOpenNamesItsThread(t *testing.T) {
	tests := []struct {
		name  string
		owner string
		want  string
	}{
		{name: "another thread's", owner: other, want: "thread " + other + "'s tab t-f is already open in pane p-main (nothing new opened); windows=1"},
		{name: "the asker's", owner: self, want: "thread " + self + "'s tab t-f is already open in pane p-main (nothing new opened); windows=1"},
		{name: "of no thread", owner: "", want: "tab t-f (of no thread) is already open in pane p-main (nothing new opened); windows=1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, _ := whereFixture(t, oneSpace(threadTab("t-a", self), fileTab("t-f", tt.owner)), true)
			res, err := reg.Invoke(context.Background(), selfCLI, "view.open.file", map[string]string{"path": "/wt/a.go"})
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message = %q\nwant      %q", res.Message, tt.want)
			}
			if out := res.JSON.(command.PanelResult); !out.Existing || out.TabThread != tt.owner || out.Thread != self || out.ThreadNotOpen {
				t.Errorf("JSON = %+v, want existing, tab_thread %q", out, tt.owner)
			}
		})
	}
}
