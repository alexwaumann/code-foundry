package daemon

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// removedPaths are the worktree paths RemoveWorktree was called with, sorted.
func removedPaths(pf *projecttest.Fake) []string {
	var removed []string
	for _, call := range pf.Calls {
		if p, ok := strings.CutPrefix(call, "RemoveWorktree "); ok {
			removed = append(removed, p[strings.Index(p, " ")+1:])
		}
	}
	slices.Sort(removed)
	return removed
}

// Threads archived together that share a worktree each start a cleanup: one removes it,
// the others find it gone, and nothing is logged as a failure (fuzz finding A10).
func TestArchiveCleanupSharedWorktree(t *testing.T) {
	const wt = "/wt/web/feat-x"
	clean := project.Status{RefreshedAt: time.Now()}
	pf := projecttest.New(nil)
	pf.Put(project.Project{ID: "web", Name: "web", Git: true, Path: "/src/web", Worktrees: []project.Worktree{
		{ProjectID: "web", Path: "/src/web", IsMain: true, Branch: "main", Status: clean},
		{ProjectID: "web", Path: wt, Branch: "feat/x", Managed: true, Status: clean},
	}})
	var threads []thread.Thread
	for _, id := range []string{"s-1", "s-2", "s-3"} {
		threads = append(threads, thread.Thread{ID: id, ProjectID: "web", ProjectIDs: []string{"web"}, WorktreePath: wt,
			CreatedWorktree: true, Branch: "feat/x", ArchivedAt: time.Now()})
	}
	snap := &thread.Snapshot{Threads: threads}
	// Each cleanup reads the checkouts when it starts, all before the first removal.
	checkouts := func(thread.Thread) []thread.Checkout {
		return []thread.Checkout{{ProjectID: "web", Path: wt, Derived: true, Registered: true, Git: true, Primary: true}}
	}
	var logs strings.Builder
	c := &archiveCleaner{
		log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn})), projects: pf, checkouts: checkouts,
		threads: func() *thread.Snapshot { return snap }, terminals: func() []terminal.Terminal { return nil },
	}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	for _, s := range threads {
		c.archived(s)
	}
	c.stop()
	if got := removedPaths(pf); !slices.Equal(got, []string{wt}) {
		t.Errorf("removed %q, want %s once", got, wt)
	}
	if logs.Len() > 0 {
		t.Errorf("warnings logged:\n%s", logs.String())
	}
}

// Unregistering a project first removes the clean worktrees Code Foundry made for it
// that nothing uses, by the archived verdict; the rest stay (fuzz finding A10).
func TestUnregisterCleansUpWorktrees(t *testing.T) {
	clean := project.Status{RefreshedAt: time.Now()}
	pf := projecttest.New(nil)
	pf.Put(project.Project{ID: "api", Name: "api", Git: true, Path: "/src/api", Worktrees: []project.Worktree{
		{ProjectID: "api", Path: "/src/api", IsMain: true, Branch: "main", Status: clean, Managed: true},
		{ProjectID: "api", Path: "/wt/api/orphan", Branch: "feat/orphan", Managed: true, Status: clean},
		{ProjectID: "api", Path: "/wt/api/live", Branch: "feat/live", Managed: true, Status: clean},
		{ProjectID: "api", Path: "/wt/api/dirty", Branch: "feat/dirty", Managed: true, Status: project.Status{RefreshedAt: time.Now(), Untracked: 1}},
		{ProjectID: "api", Path: "/src/api-hand", Branch: "feat/hand", Status: clean},
	}})
	live := thread.Thread{ID: "s-live", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: "/wt/web/live",
		CreatedWorktree: true, Branch: "feat/live"}
	gone := thread.Thread{ID: "s-gone", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: "/wt/web/orphan",
		CreatedWorktree: true, Branch: "feat/orphan", ArchivedAt: time.Now()}
	snap := &thread.Snapshot{Threads: []thread.Thread{live, gone}}
	checkouts := func(t thread.Thread) []thread.Checkout {
		return []thread.Checkout{
			{ProjectID: "api", Path: "/wt/api/" + strings.TrimPrefix(t.Branch, "feat/"), Derived: true, Registered: true, Git: true},
			{ProjectID: "web", Path: t.WorktreePath, Derived: true, Registered: true, Git: true, Primary: true},
		}
	}
	c := &archiveCleaner{
		log: slog.New(slog.NewTextHandler(io.Discard, nil)), projects: pf, checkouts: checkouts,
		threads: func() *thread.Snapshot { return snap }, terminals: func() []terminal.Terminal { return nil },
	}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	defer c.stop()
	c.unregistering(context.Background(), "api")
	c.unregistering(context.Background(), "nosuch")
	if got := removedPaths(pf); !slices.Equal(got, []string{"/wt/api/orphan"}) {
		t.Errorf("removed %q, want only the orphan", got)
	}
}
