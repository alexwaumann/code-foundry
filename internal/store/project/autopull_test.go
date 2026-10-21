package project

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCanFastForward(t *testing.T) {
	behind := Status{Upstream: "origin/main", Behind: 2}
	tests := []struct {
		name   string
		change func(*Status)
		want   bool
	}{
		{name: "behind only", change: func(*Status) {}, want: true},
		{name: "untracked files allowed", change: func(s *Status) { s.Untracked, s.Dirty = 3, true }, want: true},
		{name: "no upstream", change: func(s *Status) { s.Upstream = "" }},
		{name: "not behind", change: func(s *Status) { s.Behind = 0 }},
		{name: "ahead too (diverged)", change: func(s *Status) { s.Ahead = 1 }},
		{name: "staged (a staged new file counts)", change: func(s *Status) { s.Staged, s.Dirty = 1, true }},
		{name: "modified", change: func(s *Status) { s.Modified, s.Dirty = 1, true }},
		{name: "conflicted", change: func(s *Status) { s.Conflicted, s.Dirty = 1, true }},
		{name: "operation in progress", change: func(s *Status) { s.Operation = OpRebase }},
		{name: "last refresh failed", change: func(s *Status) { s.Error = "git status: exit 128" }},
		{name: "base counts do not matter", change: func(s *Status) { s.BaseRef, s.BaseAhead, s.BaseBehind = "origin/main", 4, 5 }, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := behind
			tt.change(&st)
			if got := st.CanFastForward(); got != tt.want {
				t.Fatalf("CanFastForward(%+v) = %v, want %v", st, got, tt.want)
			}
		})
	}
}

func TestAutoPullCandidates(t *testing.T) {
	behind := Status{Upstream: "origin/main", Behind: 1}
	wt := func(path, branch string, st Status) Worktree {
		return Worktree{Path: path, Branch: branch, Status: st}
	}
	proj := func(def string, wts ...Worktree) Project {
		return Project{ID: "p", Git: true, DefaultBranch: def, Worktrees: wts}
	}
	tests := []struct {
		name string
		p    Project
		want []string
	}{
		{name: "main checkout on the default branch", p: proj("main", wt("/r", "main", behind)), want: []string{"/r"}},
		{
			name: "only the default branch",
			p: proj("main",
				wt("/r", "feature", Status{Upstream: "origin/feature", Behind: 1}),
				wt("/w/main", "main", behind),
				wt("/w/dev", "dev", Status{Upstream: "origin/dev", Behind: 3})),
			want: []string{"/w/main"},
		},
		{name: "default branch other than main", p: proj("trunk", wt("/r", "main", behind), wt("/w", "trunk", Status{Upstream: "origin/trunk", Behind: 1})), want: []string{"/w"}},
		{name: "detached at the default branch", p: proj("main", Worktree{Path: "/r", Detached: true, Status: behind})},
		{name: "on the default branch but dirty", p: proj("main", wt("/r", "main", Status{Upstream: "origin/main", Behind: 1, Modified: 1}))},
		{name: "no default branch known", p: proj("", wt("/r", "main", behind))},
		{name: "project in error", p: func() Project { p := proj("main", wt("/r", "main", behind)); p.Error = "gone"; return p }()},
		{name: "project without git", p: func() Project { p := proj("main", wt("/r", "main", behind)); p.Git = false; return p }()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, w := range AutoPullCandidates(tt.p) {
				got = append(got, w.Path)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("candidates = %v, want %v", got, tt.want)
			}
		})
	}
}

// pullRecorder is AutoPull hooks over switches a test flips, recording each pull.
type pullRecorder struct {
	enabled, busy atomic.Bool
	fail          atomic.Bool
	mu            sync.Mutex
	pulls         []string
}

func (r *pullRecorder) hooks() AutoPull {
	return AutoPull{
		Enabled: r.enabled.Load,
		Busy:    func(string) bool { return r.busy.Load() },
		Pull: func(_ context.Context, w Worktree) error {
			r.mu.Lock()
			r.pulls = append(r.pulls, w.Path)
			r.mu.Unlock()
			if r.fail.Load() {
				return errors.New("Not possible to fast-forward, aborting.")
			}
			_, err := ExecRunner{}.Run(context.Background(), w.Path, "pull", "-q", "--ff-only")
			return err
		},
	}
}

func (r *pullRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pulls)
}

// TestAutoPullPass runs the store's fetch loop against a project that origin moved
// ahead of: nothing is pulled while the setting is off, the project is idle, or the
// checkout is busy; a refused pull is retried on the next fetch; then the checkout is
// fast-forwarded and its status refreshed.
func TestAutoPullPass(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, FetchInterval: 150 * time.Millisecond})
	r := &pullRecorder{}
	h.store.SetAutoPull(r.hooks())
	if _, err := h.store.Register(context.Background(), f.project); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.other, "o.txt"), "o\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "other")
	git(t, f.other, "push", "-q")

	fetches := func(n int) {
		t.Helper()
		start := cr.count("fetch")
		eventually(t, "fetches", 5*time.Second, func() bool { return cr.count("fetch") >= start+n })
		time.Sleep(100 * time.Millisecond) // a pass the last fetch started finishes
	}
	h.waitFor("behind via fetch", worktreeUpdated(f.project, func(w Worktree) bool { return w.Status.Behind == 1 }))

	// Off; then on but idle (no live thread, no detail watch).
	fetches(2)
	r.enabled.Store(true)
	fetches(2)
	if n := r.count(); n != 0 {
		t.Fatalf("pulled %d times while off or idle", n)
	}

	// Live but busy.
	h.store.SetLiveWorktrees([]string{f.project})
	r.busy.Store(true)
	fetches(2)
	if n := r.count(); n != 0 {
		t.Fatalf("pulled %d times while busy", n)
	}

	// A refused pull is tried again after the next fetch.
	r.busy.Store(false)
	r.fail.Store(true)
	eventually(t, "a retried pull", 5*time.Second, func() bool { return r.count() >= 2 })
	r.fail.Store(false)

	h.waitFor("fast-forwarded", worktreeUpdated(f.project, func(w Worktree) bool {
		return w.Status.Behind == 0 && w.Head == git(t, f.other, "rev-parse", "HEAD")
	}))
	n := r.count()
	fetches(2)
	if got := r.count(); got != n {
		t.Fatalf("pulled %d more times with nothing to pull", got-n)
	}
}
