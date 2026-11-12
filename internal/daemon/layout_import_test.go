package daemon

import (
	"log/slog"
	"testing"
	"time"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// The first-load import with the glue running: classic shells' automatic tabs leave the
// space, a thread's first shell becomes its quick terminal, and no terminal ends.
func TestLegacyImportEndsNothing(t *testing.T) {
	archived := th("th-b")
	archived.ArchivedAt = time.Unix(1, 0)
	var a1, a2, proj, free string
	e := newGlueEnv(t, []thread.Thread{th("th-a"), archived}, func(e *glueEnv) {
		a1, a2, free = e.shell("th-a"), e.shell("th-a"), e.shell("")
		tm, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Cwd: glueWT, Labels: termlabel.Shell("", "pj", glueWT)})
		if err != nil {
			t.Fatal(err)
		}
		proj = tm.ID
	})
	// What terminal.new gave the classic window's shells: tabs nobody saw.
	e.termTab("th-a", a1)
	e.termTab("th-a", a2)
	e.termTab("", proj)
	e.termTab("", free)
	imp := legacyImport{log: slog.New(slog.DiscardHandler), layout: e.layout, terminals: e.terms, threads: func() *thread.Snapshot {
		return &thread.Snapshot{Threads: []thread.Thread{th("th-a"), archived}}
	}}
	panel := `{"version":6,"state":{"byKey":{"thread:th-a":{"open":true,"groups":[{"tabs":[{"id":"mcp","kind":"mcp","title":"MCP","params":{}}],"activeTabId":"mcp"}]}}}}`
	bottom := `{"version":1,"state":{"byKey":{"thread:th-a":{"open":true,"height":240}}}}`
	c, err := imp.ImportLegacy(e.ctx, panel, bottom, "win")
	if err != nil {
		t.Fatal(err)
	}
	if !c.Imported || c.Result.Quick["th-a"] != a1 || len(c.Result.Removed) != 2 {
		t.Fatalf("import %+v", c)
	}
	st := e.state()
	if st.Spaces[0].Root != nil {
		t.Errorf("the space is not empty")
	}
	ts := st.Threads["th-a"]
	if ts == nil || len(ts.Remembered.Tabs) != 2 || ts.Remembered.Tabs[1].Tab.Params[core.TerminalParam] != a2 || ts.Quick == nil || !ts.Quick.Open {
		t.Fatalf("th-a %+v", ts)
	}
	if got, _ := e.terms.Get(e.ctx, a1); !termlabel.IsQuick(got.Labels) || got.Labels[termlabel.Worktree] != glueWT {
		t.Errorf("a1 labels %v", got.Labels)
	}
	if got, _ := e.terms.Get(e.ctx, a2); termlabel.IsQuick(got.Labels) {
		t.Errorf("a2 labels %v", got.Labels)
	}

	// The glue handles commits in order: once a tab closed after the import has ended its
	// shell, the import's commit was handled too.
	sentinel := e.shell("")
	e.apply(&core.CloseTab{Tab: e.termTab("", sentinel)})
	e.eventually("the sentinel shell ends", func() bool { return e.gone(sentinel) })
	for _, id := range []string{a1, a2, proj, free} {
		if !e.running(id) {
			t.Errorf("terminal %s is not running after the import", id)
		}
	}

	// A second call is a no-op.
	again, err := imp.ImportLegacy(e.ctx, panel, bottom, "win")
	if err != nil || again.Imported || again.Rev != e.layout.Snapshot().Rev {
		t.Errorf("second import %+v, %v", again, err)
	}

	// Opening the thread brings the set back; its terminal is the same one.
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	found := false
	for _, p := range core.Panes(e.state().Spaces[0].Root) {
		for _, tb := range p.Tabs {
			found = found || (tb.Kind == "terminal" && tb.Thread == "th-a" && tb.Params[core.TerminalParam] == a2)
		}
	}
	if !found || !e.running(a2) {
		t.Errorf("a2 has no tab after the thread opened, or is not running")
	}
}
