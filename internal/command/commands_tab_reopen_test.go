package command_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// closedIDs are the first tab of each entry of a space's reopen history, newest first.
func closedIDs(st *core.State, space string) []string {
	var out []string
	for _, e := range st.Space(space).Closed {
		out = append(out, e.Tabs[0].ID)
	}
	return out
}

// Only a close the user makes goes in the reopen history: the app's and the CLI's outside a
// thread, by tab, pane or thread; a thread's own call closes without recording.
func TestCloseRecordsForTheUserOnly(t *testing.T) {
	tests := []struct {
		name string
		uctx command.Context
		verb string
		args map[string]string
		want []string
	}{
		{"the app's cmd+w", fromApp, "tab.close", map[string]string{"tab": "t-prs"}, []string{"t-prs"}},
		{"the CLI's tab.close", fromCLI, "tab.close", map[string]string{"tab": "t-prs"}, []string{"t-prs"}},
		{"a thread's tab.close", fromThread, "tab.close", map[string]string{"tab": "t-prs"}, nil},
		{"a thread's tab by its tab", fromApp, "tab.close", map[string]string{"tab": "t-a"}, []string{"t-a"}},
		{"thread.close", fromCLI, "thread.close", map[string]string{"id": "s-aaaa00000001"}, []string{"t-a"}},
		{"a thread's thread.close", fromThread, "thread.close", map[string]string{"id": "s-aaaa00000001"}, nil},
		{"the app's cmd+shift+w", fromApp, "pane.close", map[string]string{"pane": "p-left"}, []string{"t-a"}},
		{"a thread's pane.close", fromThread, "pane.close", map[string]string{"pane": "p-left"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			f.must(t, tt.uctx, tt.verb, tt.args)
			if got := closedIDs(f.state(), "sp-main"); !slices.Equal(got, tt.want) {
				t.Errorf("history %v, want %v", got, tt.want)
			}
		})
	}
}

// tab.reopen brings back the newest entry, skipping what the daemon finds gone: a thread
// archived or removed (its tab and its linked tabs), a file no longer on disk.
func TestReopenSkipsWhatIsGone(t *testing.T) {
	dir := t.TempDir()
	kept := filepath.Join(dir, "kept.go")
	if err := os.WriteFile(kept, []byte("package x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := newLayoutFixture(t)
	f.thread.Current = &v1.Thread{Id: "s-aaaa00000001"}
	f.thread.Others = []*v1.Thread{{Id: "s-arch00000001", ArchivedAt: timestamppb.Now()}}
	st := f.state()
	main := st.Space("sp-main")
	// Newest first: an archived thread's diff, a removed thread's tab, a file gone, a file kept,
	// then a relative path read from its base.
	main.Closed = []*core.Closed{
		{Pane: "p-right", Tabs: []*core.Tab{{ID: "t-ad", Kind: "diff", Thread: "s-arch00000001", Params: map[string]string{"project": "pj-1", "worktree": "/w"}}}},
		{Pane: "p-left", Tabs: []*core.Tab{{ID: "t-rm", Kind: "thread", Thread: "s-gone00000001"}}},
		{Pane: "p-right", Tabs: []*core.Tab{{ID: "t-gone", Kind: "file", Params: map[string]string{"path": filepath.Join(dir, "gone.go")}}}},
		{Pane: "p-right", Tabs: []*core.Tab{{ID: "t-kept", Kind: "file", Params: map[string]string{"path": kept}}}},
		{Pane: "p-right", Tabs: []*core.Tab{{ID: "t-rel", Kind: "file", Params: map[string]string{"path": "kept.go", "base": dir}}}},
	}
	f.store.Put(st)

	res := f.must(t, fromCLI, "tab.reopen", nil)
	if res.Message != "reopened tab t-kept in pane p-right" {
		t.Errorf("message %q", res.Message)
	}
	if got := closedIDs(f.state(), "sp-main"); !slices.Equal(got, []string{"t-rel"}) {
		t.Errorf("history %v, want [t-rel]", got)
	}
	if f.focus() != "sp-main/p-right/t-kept" {
		t.Errorf("focus %s", f.focus())
	}
	f.must(t, fromCLI, "tab.reopen", nil)
	if paneOfTab(f.state(), "t-rel") != "p-right" {
		t.Error("a relative path read from its base did not reopen")
	}
	// Nothing left: the CLI says so, the app says nothing.
	if res := f.must(t, fromCLI, "tab.reopen", nil); res.Message != `nothing to reopen in space sp-main "Main"` {
		t.Errorf("message %q", res.Message)
	}
	if res := f.must(t, fromApp, "tab.reopen", nil); res.Message != "" || res.JSON != nil {
		t.Errorf("app result %+v", res)
	}
}

// Closed and reopened through the verbs: the tab comes back where it was, with the focus,
// and the JSON is the layout result the app follows the keyboard with.
func TestReopenRoundTrip(t *testing.T) {
	f := newLayoutFixture(t)
	f.must(t, fromApp, "tab.close", map[string]string{"tab": "t-prs"})
	res := f.must(t, fromApp, "tab.reopen", nil)
	b, _ := json.Marshal(res.JSON)
	var lr command.LayoutResult
	if err := json.Unmarshal(b, &lr); err != nil || lr.Tab != "t-prs" || lr.Pane != "p-left" || !lr.Changed {
		t.Errorf("result %s (%v)", b, err)
	}
	if f.focus() != "sp-main/p-left/t-prs" {
		t.Errorf("focus %s", f.focus())
	}
	// From inside a thread the space must be named, and the user's focus stays.
	if _, err := f.run(t, fromThread, "tab.reopen", nil); err == nil {
		t.Error("a thread's tab.reopen without --space ran")
	}
	f.must(t, fromApp, "tab.close", map[string]string{"tab": "t-prs"})
	f.must(t, fromApp, "tab.focus", map[string]string{"tab": "t-diff"})
	f.must(t, fromThread, "tab.reopen", map[string]string{"space": "sp-main"})
	if f.focus() != "sp-main/p-right/t-diff" || paneOfTab(f.state(), "t-prs") != "p-left" {
		t.Errorf("focus %s, t-prs in %q", f.focus(), paneOfTab(f.state(), "t-prs"))
	}
}
