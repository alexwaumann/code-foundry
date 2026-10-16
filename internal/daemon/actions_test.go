package daemon

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// recordingRuns records the cleanup's calls; KillRuns reports which of runs it matched.
type recordingRuns struct {
	runs []action.Run

	mu           sync.Mutex
	reposRemoved []string
	killed       []string
}

func (r *recordingRuns) RepoRemoved(_ context.Context, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reposRemoved = append(r.reposRemoved, id)
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
	return slices.Clone(r.reposRemoved), slices.Clone(r.killed)
}

func TestActionCleanup(t *testing.T) {
	runs := []action.Run{
		{ID: "r1", RepoID: "web", SessionID: "s1", Worktree: "/wt/feat"},
		{ID: "r2", RepoID: "web", Worktree: "/wt/main"},
		{ID: "r3", RepoID: "api", SessionID: "s2", Worktree: "/wt/api"},
	}
	tests := []struct {
		name       string
		event      any
		gone       []string // worktree directories that no longer exist
		wantRepos  []string
		wantKilled []string
	}{
		{name: "an unregistered project forgets its actions and runs", event: repo.RepoRemoved{ID: "web"}, wantRepos: []string{"web"}},
		{name: "a removed thread's background runs are killed", event: thread.Removed{ID: "s1"}, wantKilled: []string{"r1"}},
		{name: "another thread's runs stay", event: thread.Removed{ID: "s9"}},
		{name: "a removed worktree's runs are killed", event: repo.WorktreeRemoved{RepoID: "web", Path: "/wt/main"}, gone: []string{"/wt/main"},
			wantKilled: []string{"r2"}},
		{name: "a worktree still on disk (a failed refresh) keeps its runs", event: repo.WorktreeRemoved{RepoID: "web", Path: "/wt/main"}},
		{name: "an archived thread's background runs are killed",
			event: thread.Updated{Session: thread.Session{ID: "s2", ArchivedAt: time.Unix(1, 0)}}, wantKilled: []string{"r3"}},
		{name: "a snoozed thread's background runs are killed",
			event: thread.Updated{Session: thread.Session{ID: "s1", SnoozedUntil: time.Unix(1, 0)}}, wantKilled: []string{"r1"}},
		{name: "other session updates are ignored", event: thread.Updated{Session: thread.Session{ID: "s1"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			rec := &recordingRuns{runs: runs}
			stop := startActionCleanupWith(t.Context(), discard, rec, b, func(p string) bool { return slices.Contains(tt.gone, p) })
			defer stop()
			switch e := tt.event.(type) {
			case repo.Event:
				bus.Publish(b, e)
			case thread.Event:
				bus.Publish(b, e)
			}
			if want := len(tt.wantRepos) + len(tt.wantKilled); want > 0 {
				deadline := time.Now().Add(5 * time.Second)
				for repos, killed := rec.state(); len(repos)+len(killed) < want && time.Now().Before(deadline); repos, killed = rec.state() {
					time.Sleep(5 * time.Millisecond)
				}
			} else {
				time.Sleep(80 * time.Millisecond) // a call that should not happen has had its chance
			}
			repos, killed := rec.state()
			if !slices.Equal(repos, tt.wantRepos) || !slices.Equal(killed, tt.wantKilled) {
				t.Errorf("RepoRemoved %q, killed %q; want %q, %q", repos, killed, tt.wantRepos, tt.wantKilled)
			}
		})
	}
}
