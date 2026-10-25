package daemon

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Workspaces and the other stores (docs/notes/workspaces-v2-fix-1-workspace.md). The
// workspace store never looks at projects' events or at threads; the daemon tells it:
//
//   - a project is unregistered (project.ProjectRemoved): it leaves every workspace
//     (ProjectRemoved), and at start any member already unregistered does;
//   - Remove of a synthetic workspace asks workspaceInUse, which refuses while a thread
//     that is not archived runs in its managed dir (removing it would delete the
//     thread's cwd).

// workspaceMembers is the part of the workspace store this needs. *workspace.Manager
// implements it.
type workspaceMembers interface {
	Snapshot() *workspace.Snapshot
	ProjectRemoved(ctx context.Context, projectID string) error
}

// startWorkspaceProjects drops unregistered projects from workspaces: the ones gone
// already now, then each one the project store removes. The returned func stops it.
func startWorkspaceProjects(ctx context.Context, log *slog.Logger, ws workspaceMembers, projects func() *project.Snapshot, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[project.Event](b, 256)
	drop := func(id string) {
		if err := ws.ProjectRemoved(ctx, id); err != nil && !errors.Is(err, context.Canceled) {
			log.Warn("drop an unregistered project from workspaces", "project", id, "err", err)
		}
	}
	for _, id := range unregisteredMembers(ws.Snapshot(), projects()) {
		drop(id)
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev, open := <-events.C():
				if !open {
					return
				}
				if e, ok := ev.(project.ProjectRemoved); ok {
					drop(e.ID)
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}

// unregisteredMembers are the member ids of any workspace in ws that projects does not
// have, each once.
func unregisteredMembers(ws *workspace.Snapshot, projects *project.Snapshot) []string {
	if ws == nil || projects == nil {
		return nil
	}
	var out []string
	for _, w := range ws.Workspaces {
		for _, id := range w.Members {
			if _, ok := projects.Project(id); !ok && !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
	}
	return out
}

// workspaceInUse is Options.InUse: an error naming the threads that are not archived
// (nor being removed) whose cwd is w's managed dir or inside it.
func workspaceInUse(snap *thread.Snapshot, w workspace.Workspace) error {
	if snap == nil || w.ManagedDir == "" {
		return nil
	}
	var names []string
	for _, t := range snap.Threads {
		if !t.ArchivedAt.IsZero() || t.Removing || t.WorktreePath == "" || !workspace.Within(t.WorktreePath, w.ManagedDir) {
			continue
		}
		label := t.ID
		if t.Name != "" {
			label = t.Name + " (" + t.ID + ")"
		}
		names = append(names, label)
	}
	switch len(names) {
	case 0:
		return nil
	case 1:
		return errors.New("thread " + names[0] + " runs in its folder; archive it or move it with thread run-in")
	default:
		return errors.New("threads " + strings.Join(names, ", ") + " run in its folder; archive them or move them with thread run-in")
	}
}
