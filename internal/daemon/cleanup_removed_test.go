package daemon

import (
	"context"
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

// A removed thread's derived worktrees go as an archived thread's do: clean ones at
// once, a dirty one or one another live thread holds kept with the reason logged. The
// removed thread is no longer in the snapshot (Options.Removed runs after its row
// goes), so it holds nothing itself; never a branch.
func TestRemoveCleanup(t *testing.T) {
	const (
		webWT = "/wt/web/feat-x"
		apiWT = "/wt/api/feat-x"
	)
	clean := project.Status{RefreshedAt: time.Now()}
	removed := thread.Thread{ID: "s-1", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT,
		CreatedWorktree: true, Branch: "feat/x"}
	checkouts := func(t thread.Thread) []thread.Checkout {
		switch t.ID {
		case "s-other":
			// A live thread on the same branch: the same worktrees.
			return []thread.Checkout{{ProjectID: "web", Path: webWT, Primary: true}, {ProjectID: "api", Path: apiWT}}
		case "s-docs":
			return []thread.Checkout{{ProjectID: "docs", Path: "/src/docs", Primary: true}}
		}
		return []thread.Checkout{
			{ProjectID: "api", Path: apiWT, WorktreeMode: true, Registered: true, Git: true},
			{ProjectID: "web", Path: webWT, WorktreeMode: true, Registered: true, Git: true, Primary: true},
		}
	}
	tests := []struct {
		name        string
		others      []thread.Thread
		dirty       bool
		wantRemoved []string
		// wantLog are lines the log has.
		wantLog []string
	}{
		{name: "clean members go", others: []thread.Thread{{ID: "s-docs", ProjectID: "docs", WorktreePath: "/src/docs"}},
			wantRemoved: []string{apiWT, webWT},
			wantLog:     []string{`msg="worktree removed (its branch stays)" thread=s-1 cause=removed project=api`}},
		{name: "a dirty member stays", dirty: true, wantRemoved: []string{webWT},
			wantLog: []string{`msg="worktree kept" thread=s-1 cause=removed project=api path=/wt/api/feat-x reason="uncommitted changes"`}},
		{name: "another live thread on the branch keeps both",
			others: []thread.Thread{{ID: "s-other", Name: "twin", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT,
				CreatedWorktree: true, Branch: "feat/x"}},
			wantLog: []string{`cause=removed project=web path=/wt/web/feat-x reason="thread twin is on it"`,
				`cause=removed project=api path=/wt/api/feat-x reason="thread twin is on it"`}},
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
				{ProjectID: "web", Path: webWT, Branch: "feat/x", Managed: true, Status: clean},
			}})
			pf.Put(project.Project{ID: "api", Name: "api", Git: true, Path: "/src/api", Worktrees: []project.Worktree{
				{ProjectID: "api", Path: "/src/api", IsMain: true, Branch: "main", Status: clean},
				{ProjectID: "api", Path: apiWT, Branch: "feat/x", Managed: true, Status: apiStatus},
			}})
			// The removed thread is gone from the snapshot.
			snap := &thread.Snapshot{Threads: tt.others}
			var logs strings.Builder
			c := &archiveCleaner{
				log: slog.New(slog.NewTextHandler(&logs, nil)), projects: pf, checkouts: checkouts,
				threads: func() *thread.Snapshot { return snap }, terminals: func() []terminal.Terminal { return nil },
			}
			c.ctx, c.cancel = context.WithCancel(context.Background())
			c.removed(removed)
			c.stop()
			if got := removedPaths(pf); !slices.Equal(got, tt.wantRemoved) {
				t.Errorf("removed %q, want %q", got, tt.wantRemoved)
			}
			for _, call := range pf.Calls {
				if strings.Contains(call, "Branch") {
					t.Errorf("a branch was touched: %s", call)
				}
			}
			for _, want := range tt.wantLog {
				if !strings.Contains(logs.String(), want) {
					t.Errorf("log lacks %s:\n%s", want, logs.String())
				}
			}
		})
	}
}
