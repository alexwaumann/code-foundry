package daemon

import (
	"os"
	"testing"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// A terminal's tab closed by the user ends its shell; reopened (docs/notes/shell-model.md,
// "Reopening closed tabs") it gets a fresh one where the old one started: the thread's
// checkout, linked to the thread, or the home directory for a free terminal. The tab keeps
// its manual name.
func TestLayoutGlueReopenedTerminalsStartFresh(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, thread, cwd string
	}{
		{"a thread's terminal", "th-a", glueWT},
		{"a free terminal", "", home},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
			e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
			old := e.shell(tt.thread)
			tab := e.termTab(tt.thread, old)
			e.apply(&core.RenameTab{Tab: tab, Name: "Server"})
			e.apply(&core.CloseTab{Tab: tab, Record: true})
			e.eventually("the closed tab's shell ends", func() bool { return e.gone(old) })

			c := e.apply(&core.ReopenClosed{})
			if c.Result.Tab == "" || len(c.Result.Fresh) != 1 {
				t.Fatalf("reopen result %+v", c.Result)
			}
			var fresh string
			e.eventually("a fresh shell under the reopened tab", func() bool {
				_, _, tb := e.state().FindTab(c.Result.Tab)
				if tb == nil {
					return false
				}
				fresh = tb.Params[core.TerminalParam]
				return fresh != old && e.running(fresh)
			})
			nt, _ := e.terms.Get(e.ctx, fresh)
			if nt.Cwd != tt.cwd || nt.Labels[termlabel.Thread] != tt.thread || (tt.thread == "" && !termlabel.IsFree(nt.Labels)) {
				t.Errorf("fresh shell in %s with labels %v, want in %s, thread %q", nt.Cwd, nt.Labels, tt.cwd, tt.thread)
			}
			_, _, tb := e.state().FindTab(c.Result.Tab)
			if tb.Thread != tt.thread || tb.Name != "Server" || tb.Params[core.RanParam] != "" {
				t.Errorf("reopened tab %+v", tb)
			}
		})
	}
}
