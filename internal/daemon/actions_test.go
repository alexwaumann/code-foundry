package daemon

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// recordingRuns records the cleanup's calls; KillRuns reports which of runs it matched.
type recordingRuns struct {
	runs []action.Run

	mu              sync.Mutex
	projectsRemoved []string
	killed          []string
}

func (r *recordingRuns) ProjectRemoved(_ context.Context, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.projectsRemoved = append(r.projectsRemoved, id)
}

func (r *recordingRuns) KillRuns(match func(action.Run) bool) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, run := range r.runs {
		if match(run) {
			r.killed = append(r.killed, run.ID)
			n++
		}
	}
	return n
}

func (r *recordingRuns) state() ([]string, []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.projectsRemoved), slices.Clone(r.killed)
}

func TestActionCleanup(t *testing.T) {
	runs := []action.Run{
		{ID: "r1", ProjectID: "web", ThreadID: "s1", Worktree: "/wt/feat"},
		{ID: "r2", ProjectID: "web", Worktree: "/wt/main"},
		{ID: "r3", ProjectID: "api", ThreadID: "s2", Worktree: "/wt/api"},
	}
	tests := []struct {
		name         string
		event        any
		gone         []string // worktree directories that no longer exist
		wantProjects []string
		wantKilled   []string
	}{
		{name: "an unregistered project forgets its actions and runs", event: project.ProjectRemoved{ID: "web"}, wantProjects: []string{"web"}},
		{name: "a removed thread's background runs are killed", event: thread.Removed{ID: "s1"}, wantKilled: []string{"r1"}},
		{name: "another thread's runs stay", event: thread.Removed{ID: "s9"}},
		{name: "a removed worktree's runs are killed", event: project.WorktreeRemoved{ProjectID: "web", Path: "/wt/main"}, gone: []string{"/wt/main"},
			wantKilled: []string{"r2"}},
		{name: "a worktree still on disk (a failed refresh) keeps its runs", event: project.WorktreeRemoved{ProjectID: "web", Path: "/wt/main"}},
		{name: "an archived thread's background runs are killed",
			event: thread.Updated{Thread: thread.Thread{ID: "s2", ArchivedAt: time.Unix(1, 0)}}, wantKilled: []string{"r3"}},
		{name: "a saved thread's background runs are killed",
			event: thread.Updated{Thread: thread.Thread{ID: "s1", SavedAt: time.Unix(1, 0)}}, wantKilled: []string{"r1"}},
		{name: "a snoozed thread's background runs are killed",
			event: thread.Updated{Thread: thread.Thread{ID: "s1", SnoozedUntil: time.Unix(1, 0)}}, wantKilled: []string{"r1"}},
		{name: "other thread updates are ignored", event: thread.Updated{Thread: thread.Thread{ID: "s1"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			rec := &recordingRuns{runs: runs}
			stop := startActionCleanupWith(t.Context(), discard, rec, b, func(p string) bool { return slices.Contains(tt.gone, p) })
			defer stop()
			switch e := tt.event.(type) {
			case project.Event:
				bus.Publish(b, e)
			case thread.Event:
				bus.Publish(b, e)
			}
			if want := len(tt.wantProjects) + len(tt.wantKilled); want > 0 {
				deadline := time.Now().Add(5 * time.Second)
				for projects, killed := rec.state(); len(projects)+len(killed) < want && time.Now().Before(deadline); projects, killed = rec.state() {
					time.Sleep(5 * time.Millisecond)
				}
			} else {
				time.Sleep(80 * time.Millisecond) // a call that should not happen has had its chance
			}
			projects, killed := rec.state()
			if !slices.Equal(projects, tt.wantProjects) || !slices.Equal(killed, tt.wantKilled) {
				t.Errorf("ProjectRemoved %q, killed %q; want %q, %q", projects, killed, tt.wantProjects, tt.wantKilled)
			}
		})
	}
}

// A snoozed thread another thread's message started works on, snoozed: its updates while
// it works must not kill the runs it starts. Only the snooze itself kills (and a snooze
// after an unsnooze again). The last event, another thread's removal, orders the check:
// the events go through one goroutine in order.
func TestActionCleanupKillsOnlyAtTheSnooze(t *testing.T) {
	runs := []action.Run{{ID: "r1", ThreadID: "s1"}, {ID: "r3", ThreadID: "s2"}}
	b := bus.New()
	rec := &recordingRuns{runs: runs}
	stop := startActionCleanupWith(t.Context(), discard, rec, b, func(string) bool { return false })
	defer stop()
	until := time.Unix(1, 0)
	for _, e := range []thread.Event{
		thread.Updated{Thread: thread.Thread{ID: "s1", SnoozedUntil: until}},                                      // snoozed: kill
		thread.Updated{Thread: thread.Thread{ID: "s1", SnoozedUntil: until, Status: thread.StatusBusy}},           // working, snoozed: keep
		thread.Updated{Thread: thread.Thread{ID: "s1", SnoozedUntil: until, Status: thread.StatusNeedsAttention}}, // asks: keep
		thread.Updated{Thread: thread.Thread{ID: "s1"}},                                                           // the user's message: keep
		thread.Updated{Thread: thread.Thread{ID: "s1", SavedAt: until}},                                           // saved for later: kill
		thread.Removed{ID: "s2"}, // kill r3: the end
	} {
		bus.Publish(b, e)
	}
	want := []string{"r1", "r1", "r3"}
	deadline := time.Now().Add(5 * time.Second)
	for _, killed := rec.state(); !slices.Contains(killed, "r3") && time.Now().Before(deadline); _, killed = rec.state() {
		time.Sleep(5 * time.Millisecond)
	}
	if _, killed := rec.state(); !slices.Equal(killed, want) {
		t.Errorf("killed %q, want %q", killed, want)
	}
}
