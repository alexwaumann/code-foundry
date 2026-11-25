package daemon

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

func TestFilesChangedInvalidates(t *testing.T) {
	tests := []struct {
		name string
		ev   project.WorktreeFilesChanged
		want bool
	}{
		{"plain modify", project.WorktreeFilesChanged{Files: []project.ChangedFile{{Path: "src/main.go", Op: project.FileModified}}}, false},
		{"created", project.WorktreeFilesChanged{Files: []project.ChangedFile{{Path: "src/new.go", Op: project.FileCreated}}}, true},
		{"removed", project.WorktreeFilesChanged{Files: []project.ChangedFile{{Path: "src/old.go", Op: project.FileRemoved}}}, true},
		{"renamed", project.WorktreeFilesChanged{Files: []project.ChangedFile{{Path: "src/b.go", Op: project.FileRenamed}}}, true},
		{"root gitignore modified", project.WorktreeFilesChanged{Files: []project.ChangedFile{{Path: ".gitignore", Op: project.FileModified}}}, true},
		{"nested gitignore modified", project.WorktreeFilesChanged{Files: []project.ChangedFile{{Path: "pkg/.gitignore", Op: project.FileModified}}}, true},
		{"truncated without files", project.WorktreeFilesChanged{Truncated: true}, true},
		{"empty", project.WorktreeFilesChanged{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := filesChangedInvalidates(tt.ev); got != tt.want {
				t.Fatalf("filesChangedInvalidates(%+v) = %v, want %v", tt.ev, got, tt.want)
			}
		})
	}
}

type fakeFileIndex struct {
	mu          sync.Mutex
	watched     map[string]bool
	invalidated []string
}

func newFakeFileIndex() *fakeFileIndex {
	return &fakeFileIndex{watched: map[string]bool{}}
}

func (f *fakeFileIndex) SetWatched(root string, w bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if w {
		f.watched[root] = true
	} else {
		delete(f.watched, root)
	}
}

func (f *fakeFileIndex) Invalidate(root string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invalidated = append(f.invalidated, root)
}

func (f *fakeFileIndex) isWatched(root string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.watched[root]
}

func (f *fakeFileIndex) invalidationCount(root string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.invalidated {
		if p == root {
			n++
		}
	}
	return n
}

func waitCond(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFileIndexWatchEvents(t *testing.T) {
	b := bus.New()
	idx := newFakeFileIndex()
	snap := &project.Snapshot{
		Projects: []project.Project{
			{
				ID: "p1", Path: "/repo/a", Git: true,
				Worktrees: []project.Worktree{
					{ProjectID: "p1", Path: "/repo/a", Branch: "main", Head: "h1", IsMain: true},
				},
			},
			{
				ID: "plain", Path: "/notes", Git: false,
				Worktrees: []project.Worktree{
					{ProjectID: "plain", Path: "/notes", IsMain: true},
				},
			},
		},
	}
	stop := startFileIndexWatch(context.Background(), slog.New(slog.DiscardHandler), func() *project.Snapshot { return snap }, idx, b)
	defer stop()

	waitCond(t, "initial git worktree watched", func() bool { return idx.isWatched("/repo/a") })
	if idx.isWatched("/notes") {
		t.Fatal("non-git project should not be marked watched")
	}

	// Plain FileModified does not invalidate; FileCreated does.
	bus.Publish[project.Event](b, project.WorktreeFilesChanged{
		ProjectID: "p1", Path: "/repo/a",
		Files: []project.ChangedFile{{Path: "main.go", Op: project.FileModified}},
	})
	bus.Publish[project.Event](b, project.WorktreeFilesChanged{
		ProjectID: "p1", Path: "/repo/a",
		Files: []project.ChangedFile{{Path: "new.go", Op: project.FileCreated}},
	})
	waitCond(t, "FileCreated invalidation", func() bool { return idx.invalidationCount("/repo/a") == 1 })

	// Behind/RefreshedAt-only WorktreeUpdated does not invalidate; HEAD change does.
	bus.Publish[project.Event](b, project.WorktreeUpdated{
		Worktree: project.Worktree{
			ProjectID: "p1", Path: "/repo/a", Branch: "main", Head: "h1", IsMain: true,
			Status: project.Status{Behind: 3, BaseBehind: 3, RefreshedAt: time.Now()},
		},
	})
	bus.Publish[project.Event](b, project.WorktreeUpdated{
		Worktree: project.Worktree{
			ProjectID: "p1", Path: "/repo/a", Branch: "main", Head: "h2", IsMain: true,
		},
	})
	waitCond(t, "HEAD change invalidation", func() bool { return idx.invalidationCount("/repo/a") == 2 })

	// ProjectUpdated adds a linked worktree as watched; WorktreeRemoved unwatches & invalidates it.
	bus.Publish[project.Event](b, project.ProjectUpdated{
		Project: project.Project{
			ID: "p1", Path: "/repo/a", Git: true,
			Worktrees: []project.Worktree{
				{ProjectID: "p1", Path: "/repo/a", Branch: "main", Head: "h2", IsMain: true},
				{ProjectID: "p1", Path: "/wt/feat", Branch: "feat", Head: "h2"},
			},
		},
	})
	waitCond(t, "linked worktree watched", func() bool { return idx.isWatched("/wt/feat") })

	bus.Publish[project.Event](b, project.WorktreeRemoved{ProjectID: "p1", Path: "/wt/feat"})
	waitCond(t, "removed worktree unwatched", func() bool { return !idx.isWatched("/wt/feat") && idx.invalidationCount("/wt/feat") == 1 })

	// ProjectRemoved unwatches & invalidates remaining worktrees of p1.
	bus.Publish[project.Event](b, project.ProjectRemoved{ID: "p1"})
	waitCond(t, "removed project unwatched", func() bool { return !idx.isWatched("/repo/a") && idx.invalidationCount("/repo/a") == 3 })
}
