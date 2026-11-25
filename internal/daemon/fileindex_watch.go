package daemon

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// fileIndexWatchTarget is the part of fsx.FileIndex driven by project events.
type fileIndexWatchTarget interface {
	Invalidate(root string)
	SetWatched(root string, watched bool)
}

// wtFileState tracks the WorktreeUpdated fields whose change can alter a checkout's
// file list (`git ls-files -co --exclude-standard`).
type wtFileState struct {
	projectID string
	head      string
	branch    string
	detached  bool
	staged    int
	modified  int
	untracked int
}

func fileStateOf(w project.Worktree) wtFileState {
	return wtFileState{
		projectID: w.ProjectID,
		head:      w.Head,
		branch:    w.Branch,
		detached:  w.Detached,
		staged:    w.Status.Staged,
		modified:  w.Status.Modified,
		untracked: w.Status.Untracked,
	}
}

// startFileIndexWatch connects fsx.FileIndex to the project store's FSEvents-driven
// event stream so watched git checkouts reuse their file list past the 5 s TTL and
// invalidate immediately on structural file changes (create, remove, rename, .gitignore)
// or git HEAD/branch/index/worktree changes. The returned func stops it.
func startFileIndexWatch(ctx context.Context, log *slog.Logger, projects func() *project.Snapshot, index fileIndexWatchTarget, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	sub := bus.Subscribe[project.Event](b, 512)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer sub.Close()
		tracked := map[string]wtFileState{} // worktree path -> last seen state

		syncProject := func(p project.Project) {
			if !p.Git {
				for path, st := range tracked {
					if st.projectID == p.ID {
						index.Invalidate(path)
						index.SetWatched(path, false)
						delete(tracked, path)
					}
				}
				return
			}
			keep := make(map[string]bool, len(p.Worktrees))
			for _, w := range p.Worktrees {
				keep[w.Path] = true
				index.SetWatched(w.Path, true)
				next := fileStateOf(w)
				if prev, ok := tracked[w.Path]; ok && prev != next {
					index.Invalidate(w.Path)
				}
				tracked[w.Path] = next
			}
			for path, st := range tracked {
				if st.projectID == p.ID && !keep[path] {
					index.Invalidate(path)
					index.SetWatched(path, false)
					delete(tracked, path)
				}
			}
		}

		syncAll := func(invalidate bool) {
			if invalidate {
				for path := range tracked {
					index.Invalidate(path)
				}
			}
			snap := projects()
			if snap == nil {
				return
			}
			seen := map[string]bool{}
			for _, p := range snap.Projects {
				if !p.Git {
					continue
				}
				for _, w := range p.Worktrees {
					seen[w.Path] = true
					index.SetWatched(w.Path, true)
					tracked[w.Path] = fileStateOf(w)
				}
			}
			for path := range tracked {
				if !seen[path] {
					index.Invalidate(path)
					index.SetWatched(path, false)
					delete(tracked, path)
				}
			}
		}

		syncAll(false)
		var dropped uint64
		for {
			select {
			case <-ctx.Done():
				return
			case ev, open := <-sub.C():
				if !open {
					return
				}
				if d := sub.Dropped(); d != dropped {
					dropped = d
					log.Debug("project events dropped; invalidating file index", "dropped", d)
					syncAll(true)
				}
				switch e := ev.(type) {
				case project.WorktreeFilesChanged:
					if filesChangedInvalidates(e) {
						index.Invalidate(e.Path)
					}
				case project.WorktreeUpdated:
					next := fileStateOf(e.Worktree)
					prev, ok := tracked[e.Worktree.Path]
					if !ok {
						if snap := projects(); snap != nil {
							if p, exists := snap.Project(e.Worktree.ProjectID); exists && p.Git {
								index.SetWatched(e.Worktree.Path, true)
								tracked[e.Worktree.Path] = next
							}
						}
						continue
					}
					if prev != next {
						index.Invalidate(e.Worktree.Path)
						tracked[e.Worktree.Path] = next
					}
				case project.WorktreeRemoved:
					index.Invalidate(e.Path)
					index.SetWatched(e.Path, false)
					delete(tracked, e.Path)
				case project.ProjectUpdated:
					syncProject(e.Project)
				case project.ProjectRemoved:
					for path, st := range tracked {
						if st.projectID == e.ID {
							index.Invalidate(path)
							index.SetWatched(path, false)
							delete(tracked, path)
						}
					}
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}

// filesChangedInvalidates reports whether e may have added, removed, or renamed a file
// in git's candidate list (or edited a .gitignore). Plain modifications of existing
// files keep the cached file list valid.
func filesChangedInvalidates(e project.WorktreeFilesChanged) bool {
	if e.Truncated {
		return true
	}
	for _, f := range e.Files {
		switch f.Op {
		case project.FileCreated, project.FileRemoved, project.FileRenamed:
			return true
		}
		if filepath.Base(f.Path) == ".gitignore" {
			return true
		}
	}
	return false
}
