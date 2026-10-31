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

// An archived thread's derived worktrees go at once unless something else holds them;
// its plain folders and its user's own checkouts are never touched.
func TestArchiveCleanup(t *testing.T) {
	const (
		webWT = "/wt/web/feat-x"
		apiWT = "/wt/api/feat-x"
	)
	clean := project.Status{RefreshedAt: time.Now()}
	archived := thread.Thread{ID: "s-1", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT,
		CreatedWorktree: true, Branch: "feat/x", ArchivedAt: time.Now()}
	checkouts := func(t thread.Thread) []thread.Checkout {
		switch t.ID {
		case "s-other":
			return []thread.Checkout{{ProjectID: "api", Path: apiWT}, {ProjectID: "docs", Path: "/src/docs", Primary: true}}
		case "s-3":
			return []thread.Checkout{{ProjectID: "web", Path: t.WorktreePath, Primary: true}}
		}
		return []thread.Checkout{
			{ProjectID: "api", Path: apiWT, WorktreeMode: true, Registered: true, Git: true},
			{ProjectID: "web", Path: webWT, WorktreeMode: true, Registered: true, Git: true, Primary: true},
		}
	}
	tests := []struct {
		name string
		// others are the other threads; dirty marks the api worktree dirty; term opens a
		// terminal in the web worktree.
		others      []thread.Thread
		dirty, term bool
		wantRemoved []string
	}{
		{name: "both go", wantRemoved: []string{apiWT, webWT}},
		{name: "another thread has a checkout there", others: []thread.Thread{{ID: "s-other", ProjectID: "docs", WorktreePath: "/src/docs"}},
			wantRemoved: []string{webWT}},
		{name: "an archived thread holds nothing", others: []thread.Thread{{ID: "s-other", ProjectID: "docs", WorktreePath: "/src/docs", ArchivedAt: time.Now()}},
			wantRemoved: []string{apiWT, webWT}},
		{name: "another thread's cwd is inside it", others: []thread.Thread{{ID: "s-3", ProjectID: "web", WorktreePath: webWT + "/sub"}},
			wantRemoved: []string{apiWT}},
		{name: "uncommitted changes keep it", dirty: true, wantRemoved: []string{webWT}},
		{name: "a terminal keeps it", term: true, wantRemoved: []string{apiWT}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pf := projecttest.New(nil)
			apiStatus := clean
			if tt.dirty {
				apiStatus.Untracked = 1
			}
			pf.Put(project.Project{ID: "web", Name: "web", Git: true, Path: "/src/web", Worktrees: []project.Worktree{
				{ProjectID: "web", Path: "/src/web", IsMain: true, Branch: "main", Status: clean},
				{ProjectID: "web", Path: webWT, Branch: "feat/y", Managed: true, Status: clean}, // moved
			}})
			pf.Put(project.Project{ID: "api", Name: "api", Git: true, Path: "/src/api", Worktrees: []project.Worktree{
				{ProjectID: "api", Path: "/src/api", IsMain: true, Branch: "main", Status: clean},
				{ProjectID: "api", Path: apiWT, Branch: "feat/x", Managed: true, Status: apiStatus},
			}})
			snap := &thread.Snapshot{Threads: append([]thread.Thread{archived}, tt.others...)}
			var terms []terminal.Terminal
			if tt.term {
				terms = []terminal.Terminal{{ID: "t1", State: terminal.StateRunning, Cwd: webWT}}
			}
			var remembered []string // the threads' last heads, recorded right before each removal
			c := &archiveCleaner{
				log: slog.New(slog.NewTextHandler(io.Discard, nil)), projects: pf, checkouts: checkouts,
				threads: func() *thread.Snapshot { return snap }, terminals: func() []terminal.Terminal { return terms },
				remember: func(w project.Worktree) { remembered = append(remembered, w.Path+" "+w.Branch) },
			}
			c.ctx, c.cancel = context.WithCancel(context.Background())
			c.archived(archived)
			c.stop()
			var removed []string
			for _, call := range pf.Calls {
				if p, ok := strings.CutPrefix(call, "RemoveWorktree "); ok {
					removed = append(removed, p[strings.Index(p, " ")+1:])
				}
			}
			slices.Sort(removed)
			if !slices.Equal(removed, tt.wantRemoved) {
				t.Errorf("removed %q, want %q", removed, tt.wantRemoved)
			}
			var wantHeads []string
			for _, p := range tt.wantRemoved {
				wantHeads = append(wantHeads, p+" "+map[string]string{webWT: "feat/y", apiWT: "feat/x"}[p])
			}
			slices.Sort(remembered)
			if !slices.Equal(remembered, wantHeads) {
				t.Errorf("heads remembered %q, want %q", remembered, wantHeads)
			}
		})
	}
}
