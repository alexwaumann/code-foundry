package thread

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
	"github.com/alexwaumann/code-foundry/internal/store/page"
	"github.com/alexwaumann/code-foundry/internal/store/page/pagetest"
)

func TestWrittenPage(t *testing.T) {
	done := func(name, input string) *ToolCall {
		return &ToolCall{Name: name, InputJSON: input, Status: ToolDone}
	}
	failed := done("Write", `{"file_path":"/h/a.html"}`)
	failed.IsError, failed.Status = true, ToolError
	running := done("Write", `{"file_path":"/h/a.html"}`)
	running.Status = ToolRunning
	for _, tt := range []struct {
		name string
		call *ToolCall
		want string
	}{
		{"Write", done("Write", `{"file_path":"/h/a.html","content":"x"}`), "/h/a.html"},
		{"Edit", done("Edit", `{"file_path":"/h/b/../a.HTM","old_string":"a","new_string":"b"}`), "/h/a.HTM"},
		{"MultiEdit", done("MultiEdit", `{"file_path":"/h/a.html","edits":[]}`), "/h/a.html"},
		{"not html", done("Write", `{"file_path":"/h/a.md"}`), ""},
		{"relative", done("Write", `{"file_path":"a.html"}`), ""},
		{"Read", done("Read", `{"file_path":"/h/a.html"}`), ""},
		{"Bash", done("Bash", `{"command":"echo > /h/a.html"}`), ""},
		{"failed", failed, ""},
		{"still running", running, ""},
		{"junk input", done("Write", `{`), ""},
		{"no call", nil, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := writtenPage(tt.call); got != tt.want {
				t.Fatalf("writtenPage = %q, want %q", got, tt.want)
			}
		})
	}
}

// The projector tells of the HTML file a call wrote once its result says it succeeded, a
// subagent's too; a failed call and any other file are not told.
func TestProjectorTellsWrittenPages(t *testing.T) {
	log := newThreadLog("s", bus.New(), time.Now, nil)
	p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
	var got []string
	p.wrotePage = func(path string) { got = append(got, path) }
	call := func(id, name, parent, input string) {
		p.event(claudestream.Parse([]byte(`{"type":"assistant","message":{"id":"m-` + id + `","role":"assistant","content":[{"type":"tool_use","id":"` + id +
			`","name":"` + name + `","input":` + input + `}]},"parent_tool_use_id":` + parent + `}`)))
	}
	result := func(id, parent string, isError bool) {
		e := "false"
		if isError {
			e = "true"
		}
		p.event(claudestream.Parse([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id +
			`","content":"ok","is_error":` + e + `}]},"parent_tool_use_id":` + parent + `}`)))
	}
	call("t1", "Write", "null", `{"file_path":"/h/page.html","content":"x"}`)
	call("t2", "Edit", "null", `{"file_path":"/h/broken.html","old_string":"a","new_string":"b"}`)
	call("t3", "Write", "null", `{"file_path":"/h/notes.md","content":"x"}`)
	call("t4", "Edit", `"agent-1"`, `{"file_path":"/h/sub.htm","old_string":"a","new_string":"b"}`)
	if len(got) != 0 {
		t.Fatalf("told before any result: %v", got)
	}
	result("t1", "null", false)
	result("t2", "null", true)
	result("t3", "null", false)
	result("t4", `"agent-1"`, false)
	if want := []string{"/h/page.html", "/h/sub.htm"}; !slices.Equal(got, want) {
		t.Fatalf("told %v, want %v", got, want)
	}
}

// ShowHTML records the thread as the page's owner, a reused card too; a refused page is
// not recorded.
func TestShowHTMLRecordsThePage(t *testing.T) {
	e := newEnv(t)
	rec := &pagetest.Recorder{}
	e.m.SetPageRecorder(rec)
	if err := os.MkdirAll(e.home, 0o755); err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(e.home, "hello.html")
	if err := os.WriteFile(page, []byte("<p>hello</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := e.connected(CreateOptions{NoProject: true})
	if _, err := e.m.ShowHTML(e.ctx(), s.ID, page, "Hello", ShowHTMLOptions{}); err != nil {
		t.Fatal(err)
	}
	if res, err := e.m.ShowHTML(e.ctx(), s.ID, page, "", ShowHTMLOptions{}); err != nil || !res.Reused {
		t.Fatalf("again: %+v, %v; want the card reused", res, err)
	}
	if _, err := e.m.ShowHTML(e.ctx(), s.ID, filepath.Join(e.home, "nope.html"), "", ShowHTMLOptions{}); err == nil {
		t.Fatal("a missing page was shown")
	}
	want := []pagetest.Record{{Thread: s.ID, Path: page, How: pageShown}, {Thread: s.ID, Path: page, How: pageShown}}
	if got := rec.Records(); !slices.Equal(got, want) {
		t.Fatalf("records %+v, want %+v", got, want)
	}
}

// Removing a thread leaves its pages no one's: the page store's records go with the
// thread's row, so a page is never the bridge of a thread that is gone.
func TestRemoveLeavesItsPagesOwnerless(t *testing.T) {
	e := newEnv(t)
	if err := os.MkdirAll(e.home, 0o755); err != nil {
		t.Fatal(err)
	}
	pages, err := page.New(e.ctx(), page.Options{DB: e.m.opts.DB, Home: e.home})
	if err != nil {
		t.Fatal(err)
	}
	e.m.SetPageRecorder(pages)
	p := filepath.Join(e.home, "kept.html")
	if err := os.WriteFile(p, []byte("<p>kept</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := e.connected(CreateOptions{NoProject: true})
	other := e.connected(CreateOptions{NoProject: true})
	if _, err := e.m.ShowHTML(e.ctx(), s.ID, p, "", ShowHTMLOptions{}); err != nil {
		t.Fatal(err)
	}
	if a, err := pages.Access(e.ctx(), p); err != nil || a.Owner != s.ID {
		t.Fatalf("shown: %+v, %v", a, err)
	}
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if a, err := pages.Access(e.ctx(), p); err != nil || a.Owner != "" || a.Allowed() {
		t.Fatalf("after the removal: %+v, %v; want no owner", a, err)
	}
	// Shown again by another thread: that one's.
	if _, err := e.m.ShowHTML(e.ctx(), other.ID, p, "", ShowHTMLOptions{}); err != nil {
		t.Fatal(err)
	}
	if a, err := pages.Access(e.ctx(), p); err != nil || a.Owner != other.ID {
		t.Fatalf("shown by another: %+v, %v", a, err)
	}
}
