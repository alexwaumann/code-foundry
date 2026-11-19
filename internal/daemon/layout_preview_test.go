package daemon

import (
	"slices"
	"testing"
	"time"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Preview tabs in the glue (docs/notes/preview-tabs-1-daemon.md): what the thread store says
// of a thread keeps its preview tab, and a snoozed thread's set comes back when it wakes.

// previewTab is thread's tab in e's layout and whether it is a preview; "" when it is not open.
func previewTab(e *glueEnv, thread string) (string, bool) {
	_, _, tb := e.state().FindTab(threadTabIDOf(e.state(), thread))
	if tb == nil {
		return "", false
	}
	return tb.ID, tb.Preview
}

func threadTabIDOf(st *core.State, thread string) string {
	for _, sp := range st.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "thread" && tb.Thread == thread {
					return tb.ID
				}
			}
		}
	}
	return ""
}

// A preview stays one through updates that only read or report (a status change), and is kept
// when its thread is unarchived, woken (a sent message does both), renamed or pinned.
func TestLayoutGlueKeepsAPreview(t *testing.T) {
	archived := th("th-a")
	archived.ArchivedAt = time.Unix(100, 0)
	snoozed := snoozedTh("th-a")
	tests := []struct {
		name   string
		before thread.Thread
		change func(x thread.Thread) thread.Thread
		keeps  bool
	}{
		{"a status change", archived, func(x thread.Thread) thread.Thread { x.Status = thread.StatusIdle; x.StatusReason = "x"; return x }, false},
		{"unarchived", archived, func(x thread.Thread) thread.Thread { x.ArchivedAt = time.Time{}; return x }, true},
		{"woken", snoozed, func(x thread.Thread) thread.Thread { x.SnoozedUntil = time.Time{}; return x }, true},
		{"saved for later, woken", func() thread.Thread { x := th("th-a"); x.SavedAt = time.Unix(100, 0); return x }(),
			func(x thread.Thread) thread.Thread { x.SavedAt = time.Time{}; return x }, true},
		{"renamed", archived, func(x thread.Thread) thread.Thread { x.Name = "New name"; return x }, true},
		{"pinned", snoozed, func(x thread.Thread) thread.Thread { x.Pinned = true; return x }, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newGlueEnv(t, []thread.Thread{tt.before}, nil)
			e.eventually("the start sync", func() bool {
				ts := e.state().Threads["th-a"]
				return tt.before.Snoozed() == (ts != nil && ts.Snoozed)
			})
			e.apply(&core.OpenThread{Thread: "th-a", Archived: !tt.before.ArchivedAt.IsZero(), Preview: true, Focus: true})
			if _, preview := previewTab(e, "th-a"); !preview {
				t.Fatal("not opened as a preview")
			}
			e.publish(thread.Updated{Thread: tt.change(tt.before)})
			if tt.keeps {
				e.eventually("the preview kept", func() bool { id, p := previewTab(e, "th-a"); return id != "" && !p })
				return
			}
			settle()
			if _, preview := previewTab(e, "th-a"); !preview {
				t.Error("an update that keeps nothing kept the preview")
			}
		})
	}
}

// A snoozed thread's tab opens with its conversation only; when the thread wakes with its tab
// open, its set comes back beside it over the terminals that ran on meanwhile, and the place
// the snooze remembered for its tab is forgotten (it is open).
func TestLayoutGlueWakeRestoresTheSet(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	x, y := openWithSet(e)
	e.publish(thread.Updated{Thread: snoozedTh("th-a")})
	e.eventually("the thread's tabs close", func() bool { return !threadOpen(e.state(), "th-a") })
	settle()
	c := e.apply(&core.OpenThread{Thread: "th-a", Snoozed: true, Preview: true, Focus: true})
	if n := len(c.Result.Back) + len(c.Result.Placed); n != 0 || c.Result.Rule == "" {
		t.Fatalf("opened while snoozed: %+v, want only its tab", c.Result)
	}
	if ts := e.state().Threads["th-a"]; ts == nil || ts.Remembered == nil || len(ts.Remembered.Tabs) != 3 || ts.SnoozedTab != nil {
		t.Fatalf("the set did not stay put away, or the snooze's place stayed: %+v", ts)
	}

	e.publish(thread.Updated{Thread: th("th-a")})
	e.eventually("the set back over its terminals", func() bool {
		st := e.state()
		if ts := st.Threads["th-a"]; ts != nil && ts.Remembered != nil {
			return false
		}
		var got []string
		for _, p := range core.Panes(st.Space(st.CurrentSpace).Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "terminal" {
					got = append(got, tb.Params[core.TerminalParam])
				}
			}
		}
		return len(got) == 2 && slices.Contains(got, x) && slices.Contains(got, y)
	})
	if !e.running(x) || !e.running(y) {
		t.Error("a terminal ended")
	}
	if id, preview := previewTab(e, "th-a"); id == "" || preview {
		t.Errorf("tab %q preview %v after the wake, want it open and kept", id, preview)
	}
}

// At start the glue tells the layout what it missed: a thread that woke while the daemon was
// down is woken, and a snoozed thread the layout has no mark for (an older build snoozed it)
// is marked.
func TestLayoutGlueSyncsSnoozedAtStart(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-woke"), snoozedTh("th-old")}, func(e *glueEnv) {
		e.apply(&core.SetSnoozed{Thread: "th-woke", Snoozed: true})
	})
	e.eventually("the marks follow the thread store", func() bool {
		st := e.state()
		woke, old := st.Threads["th-woke"], st.Threads["th-old"]
		return (woke == nil || !woke.Snoozed) && old != nil && old.Snoozed
	})
}
