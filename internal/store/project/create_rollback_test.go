package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
)

// CreateWorktree publishes the new worktree before it waits for its status (the fast
// path). When that wait fails (the request is cancelled), the worktree is undone on
// disk and subscribers that saw it must be told it is gone: a subscriber applying the
// events ends with what the snapshot has, without the undone worktree.
func TestCreateWorktreeCancelledAfterPublishTellsSubscribers(t *testing.T) {
	f := newFixture(t)
	wtRoot := filepath.Join(f.base, "wt")
	gate := &statusGate{next: ExecRunner{}, entered: make(chan struct{}), release: make(chan struct{})}
	h := startHarness(t, "", Options{Runner: gate, WorktreeRoot: wtRoot})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	// Start the subscriber's view from the snapshot, then apply every event after it.
	view := map[string]bool{}
	for _, w := range h.store.Snapshot().Projects[0].Worktrees {
		view[w.Path] = true
	}
	drain := func() {
		for {
			select {
			case ev := <-h.sub.C():
				applyWorktreeEvent(view, r.ID, ev)
			default:
				return
			}
		}
	}
	drain()

	// Hold the new worktree's status job and cancel the request while it waits for it.
	gate.arm(filepath.Join(wtRoot, "cancelled"))
	cctx, cancel := context.WithCancel(ctx)
	go func() {
		<-gate.entered
		cancel()
	}()
	_, err = h.store.CreateWorktree(cctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cancelled"})
	close(gate.release)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("CreateWorktree err = %v, want context.Canceled", err)
	}
	path := gate.path()
	if path == "" {
		t.Fatal("the new worktree's status never ran: the fast path did not register it")
	}
	if err := h.store.sched.wait(ctx, jobKey{kind: jobStatus, projectID: r.ID, path: path}); err != nil {
		t.Fatal(err)
	}

	seen := false
	for {
		select {
		case ev := <-h.sub.C():
			applyWorktreeEvent(view, r.ID, ev)
			seen = seen || view[path]
			continue
		default:
		}
		break
	}
	if !seen {
		t.Fatalf("no event carried %s: the test no longer exercises the early publish", path)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("undone worktree %s still on disk: %v", path, err)
	}
	if _, ok := h.store.Snapshot().Worktree(r.ID, path); ok {
		t.Fatalf("snapshot still has undone worktree %s", path)
	}
	if view[path] {
		t.Fatalf("a subscriber still has undone worktree %s after the events it was sent", path)
	}
	var want []string
	for _, w := range h.store.Snapshot().Projects[0].Worktrees {
		want = append(want, w.Path)
	}
	var got []string
	for p, ok := range view {
		if ok {
			got = append(got, p)
		}
	}
	slices.Sort(want)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("subscriber has worktrees %v, snapshot has %v", got, want)
	}
}

// applyWorktreeEvent folds ev into view (worktree path → present) the way the GUI's
// projects store does (gui/frontend/src/stores/projects.ts): a project event replaces
// the list, a worktree update adds or replaces, a removal deletes.
func applyWorktreeEvent(view map[string]bool, projectID string, ev Event) {
	switch e := ev.(type) {
	case ProjectUpdated:
		if e.Project.ID != projectID {
			return
		}
		clear(view)
		for _, w := range e.Project.Worktrees {
			view[w.Path] = true
		}
	case WorktreeUpdated:
		if e.Worktree.ProjectID == projectID {
			view[e.Worktree.Path] = true
		}
	case WorktreeRemoved:
		if e.ProjectID == projectID {
			delete(view, e.Path)
		}
	}
}

// statusGate holds the first `git status` run in a worktree whose path ends like the
// armed one (the worktree root may be a symlink) until release is closed.
type statusGate struct {
	next     Runner
	entered  chan struct{}
	release  chan struct{}
	mu       sync.Mutex
	want     string
	seenPath string
}

func (g *statusGate) arm(path string) {
	g.mu.Lock()
	g.want = filepath.Base(path)
	g.mu.Unlock()
}

func (g *statusGate) path() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.seenPath
}

func (g *statusGate) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if len(args) > 0 && args[0] == "status" {
		g.mu.Lock()
		hit := g.want != "" && g.seenPath == "" && filepath.Base(dir) == g.want
		if hit {
			g.seenPath = dir
		}
		g.mu.Unlock()
		if hit {
			close(g.entered)
			<-g.release
		}
	}
	return g.next.Run(ctx, dir, args...)
}
