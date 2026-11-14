package daemon

import (
	"testing"
	"time"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Glue rules from the review of the shell (docs/notes/shell-review-fixes-daemon.md).

// Removing a space and moving its threads keeps their terminals: a closed thread's remembered
// running terminal and an open thread's linked terminal tab both keep running, and come back
// (the same processes) when the threads open in their new space. Only the space's unlinked
// terminal ends. Archiving the threads first (space.remove --archive) ends theirs too.
func TestLayoutGlueRemoveSpaceKeepsThreadTerminals(t *testing.T) {
	for _, archive := range []bool{false, true} {
		name := "move"
		if archive {
			name = "archive"
		}
		t.Run(name, func(t *testing.T) {
			e := newGlueEnv(t, []thread.Thread{th("th1"), th("th2")}, nil)
			main := e.state().CurrentSpace
			work := e.apply(&core.NewSpace{Name: "Work", Switch: true}).Result.Space
			for _, id := range []string{"th1", "th2"} {
				e.apply(&core.MoveThreadToSpace{Thread: id, Space: work})
			}
			// th1: closed, with a remembered running terminal. th2: open with a linked terminal.
			e.apply(&core.OpenThread{Thread: "th1", Focus: true})
			t1 := e.shell("th1")
			e.termTab("th1", t1)
			e.apply(&core.CloseThread{Thread: "th1"})
			e.apply(&core.OpenThread{Thread: "th2", Focus: true})
			t2 := e.shell("th2")
			e.termTab("th2", t2)
			free := e.shell("")
			e.termTab("", free)

			if archive {
				for _, id := range []string{"th1", "th2"} {
					e.goings(e.ctx, id, thread.ShellsArchived)
				}
			}
			e.apply(&core.RemoveSpace{Space: work, To: main})
			e.eventually("the unlinked shell ends", func() bool { return e.gone(free) })
			if archive {
				e.eventually("the archived threads' terminals end", func() bool { return e.gone(t1) && e.gone(t2) })
				return
			}
			settle()
			if !e.running(t1) || !e.running(t2) {
				t.Fatalf("t1 running %v, t2 running %v: removing the space ended a thread's terminal", e.running(t1), e.running(t2))
			}
			for id, term := range map[string]string{"th1": t1, "th2": t2} {
				if e.state().SpaceOf(id) != main {
					t.Fatalf("%s lives in %s, want %s", id, e.state().SpaceOf(id), main)
				}
				c := e.apply(&core.OpenThread{Thread: id, Focus: true})
				if n := len(c.Result.Back) + len(c.Result.Placed); n != 1 {
					t.Fatalf("%s: %d tabs came back, want its terminal", id, n)
				}
				tab := append(c.Result.Back, c.Result.Placed...)[0]
				if _, _, tb := e.state().FindTab(tab); tb == nil || tb.Params[core.TerminalParam] != term {
					t.Errorf("%s came back with %+v, want terminal %s", id, tb, term)
				}
			}
			settle()
			if !e.running(t1) || !e.running(t2) {
				t.Error("opening the threads again ended a terminal")
			}
		})
	}
}

// An archived thread opened from a space lives there; unarchiving it later from another space
// leaves it where its tab is.
func TestLayoutGlueUnarchivedOpenThreadStays(t *testing.T) {
	a := th("th-a")
	a.ArchivedAt = time.Unix(100, 0)
	e := newGlueEnv(t, []thread.Thread{a}, nil)
	main := e.state().CurrentSpace
	work := e.apply(&core.NewSpace{Name: "Work", Switch: true}).Result.Space
	if got := e.apply(&core.OpenThread{Thread: "th-a", Archived: true, Focus: true}).Result.Space; got != work {
		t.Fatalf("the archived thread opened in %s, want the current space %s", got, work)
	}
	e.apply(&core.SwitchSpace{Space: main})
	a.ArchivedAt = time.Time{}
	e.publish(thread.Updated{Thread: a})
	settle()
	if got := e.state().SpaceOf("th-a"); got != work {
		t.Errorf("unarchived, th-a moved to %s; its tab is open in %s", got, work)
	}
}

// When the bus drops the glue's layout and thread events (its buffers are full), the glue
// catches up from the snapshots: the terminals of tabs closed in the commits it missed end,
// and the threads it missed join a space.
func TestLayoutGlueCatchesUpAfterDroppedEvents(t *testing.T) {
	entered, gate := make(chan struct{}), make(chan struct{})
	e := newGlueEnvWith(t, []thread.Thread{th("th-a")}, nil, func(o *layoutGlueOptions) {
		o.Buffer = 2
		o.Shell = func() []string {
			select {
			case entered <- struct{}{}:
				<-gate
			default:
			}
			return []string{"zsh"}
		}
	})
	main := e.state().CurrentSpace
	other := e.apply(&core.NewSpace{Name: "Other"}).Result.Space
	// th-a snoozed with a terminal, so opening it makes the glue start a fresh shell, which
	// holds the glue in Shell while the rest happens.
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	x := e.shell("th-a")
	e.termTab("th-a", x)
	e.goings(e.ctx, "th-a", thread.ShellsSnoozed)
	if err := terminal.KillAndRemove(e.ctx, e.terms, x); err != nil {
		t.Fatal(err)
	}
	var free, tabs []string
	for range 4 {
		id := e.shell("")
		free = append(free, id)
		tabs = append(tabs, e.termTab("", id))
	}
	settle()
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the glue never started the fresh shell")
	}
	for _, tab := range tabs {
		e.apply(&core.CloseTab{Tab: tab})
	}
	e.apply(&core.SwitchSpace{Space: other})
	var fresh []string
	for _, id := range []string{"th-n1", "th-n2", "th-n3", "th-n4"} {
		fresh = append(fresh, id)
		e.publish(thread.Updated{Thread: th(id)})
	}
	close(gate)
	e.eventually("every closed tab's shell ends", func() bool {
		for _, id := range free {
			if !e.gone(id) {
				return false
			}
		}
		return true
	})
	e.eventually("every new thread joins the current space", func() bool {
		for _, id := range fresh {
			if e.state().SpaceOf(id) != other {
				return false
			}
		}
		return true
	})
	if e.state().SpaceOf("th-a") != main {
		t.Errorf("th-a moved to %s", e.state().SpaceOf("th-a"))
	}
}
