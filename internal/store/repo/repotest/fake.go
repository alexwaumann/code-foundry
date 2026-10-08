// Package repotest provides an in-memory repo.Store for tests of code that consumes
// the repo store (API handlers, commands, the gh store).
package repotest

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// Fake is an in-memory repo.Store. It never runs git: Register treats the path as the
// main worktree, CreateWorktree records a worktree, and every mutation publishes the
// same events the real store does on the bus it was given (if any).
type Fake struct {
	bus *bus.Bus

	mu    sync.Mutex
	repos map[string]repo.Repo
	snap  *repo.Snapshot
	// details backs WorktreeDetail (detail.go); nil until SetDetail.
	details map[string]repo.WorktreeDetail

	// Err, when set, is returned by every mutating method.
	Err error
	// Calls records method calls, e.g. "Register /x", "Refresh r1".
	Calls []string
}

var _ repo.Store = (*Fake)(nil)

// New returns an empty fake publishing to b (which may be nil).
func New(b *bus.Bus) *Fake {
	return &Fake{bus: b, repos: map[string]repo.Repo{}, snap: &repo.Snapshot{}}
}

// ID returns the id the fake assigns to path.
func ID(path string) string {
	return "id-" + strings.ReplaceAll(strings.Trim(filepath.Clean(path), "/"), "/", "-")
}

// Put inserts or replaces a repo and publishes RepoUpdated.
func (f *Fake) Put(r repo.Repo) {
	f.mu.Lock()
	f.repos[r.ID] = r
	f.rebuild()
	f.mu.Unlock()
	f.publish(repo.RepoUpdated{Repo: r})
}

// UpdateWorktree replaces a worktree's state and publishes WorktreeUpdated.
func (f *Fake) UpdateWorktree(w repo.Worktree) {
	f.mu.Lock()
	r := f.repos[w.RepoID]
	r.Worktrees = slices.Clone(r.Worktrees)
	for i := range r.Worktrees {
		if r.Worktrees[i].Path == w.Path {
			r.Worktrees[i] = w
		}
	}
	f.repos[w.RepoID] = r
	f.rebuild()
	f.mu.Unlock()
	f.publish(repo.WorktreeUpdated{Worktree: w})
}

// Snapshot implements repo.Store.
func (f *Fake) Snapshot() *repo.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// Register implements repo.Store.
func (f *Fake) Register(_ context.Context, path string) (repo.Repo, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "Register "+path)
	if f.Err != nil {
		defer f.mu.Unlock()
		return repo.Repo{}, f.Err
	}
	if path == "" || !filepath.IsAbs(path) {
		f.mu.Unlock()
		return repo.Repo{}, fmt.Errorf("%w: path must be absolute", repo.ErrInvalidArgument)
	}
	id := ID(path)
	if r, ok := f.repos[id]; ok {
		f.mu.Unlock()
		return r, nil
	}
	f.mu.Unlock()
	r := repo.Repo{
		ID: id, Path: path, Name: filepath.Base(path), RegisteredAt: time.Now(), DefaultBranch: "main",
		Worktrees: []repo.Worktree{{RepoID: id, Path: path, Branch: "main", IsMain: true}},
	}
	f.Put(r)
	return r, nil
}

// Unregister implements repo.Store.
func (f *Fake) Unregister(_ context.Context, id string) error {
	f.mu.Lock()
	f.Calls = append(f.Calls, "Unregister "+id)
	if f.Err != nil {
		defer f.mu.Unlock()
		return f.Err
	}
	if _, ok := f.repos[id]; !ok {
		f.mu.Unlock()
		return fmt.Errorf("%w: repo %q", repo.ErrNotFound, id)
	}
	delete(f.repos, id)
	f.rebuild()
	f.mu.Unlock()
	f.publish(repo.RepoRemoved{ID: id})
	return nil
}

// CreateWorktree implements repo.Store.
func (f *Fake) CreateWorktree(_ context.Context, o repo.CreateWorktreeOptions) (repo.Worktree, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "CreateWorktree "+o.RepoID+" "+o.Branch)
	if f.Err != nil {
		defer f.mu.Unlock()
		return repo.Worktree{}, f.Err
	}
	r, ok := f.repos[o.RepoID]
	if !ok {
		f.mu.Unlock()
		return repo.Worktree{}, fmt.Errorf("%w: repo %q", repo.ErrNotFound, o.RepoID)
	}
	if o.Branch == "" {
		f.mu.Unlock()
		return repo.Worktree{}, fmt.Errorf("%w: branch is required", repo.ErrInvalidArgument)
	}
	path := o.Path
	if path == "" {
		path = filepath.Join(filepath.Dir(r.Path), r.Name+".worktrees", strings.ReplaceAll(o.Branch, "/", "-"))
	}
	w := repo.Worktree{RepoID: r.ID, Path: path, Branch: o.Branch}
	r.Worktrees = append(slices.Clone(r.Worktrees), w)
	f.mu.Unlock()
	f.Put(r)
	return w, nil
}

// RemoveWorktree implements repo.Store.
func (f *Fake) RemoveWorktree(_ context.Context, o repo.RemoveWorktreeOptions) error {
	f.mu.Lock()
	f.Calls = append(f.Calls, "RemoveWorktree "+o.RepoID+" "+o.Path)
	if f.Err != nil {
		defer f.mu.Unlock()
		return f.Err
	}
	r, ok := f.repos[o.RepoID]
	if !ok {
		f.mu.Unlock()
		return fmt.Errorf("%w: repo %q", repo.ErrNotFound, o.RepoID)
	}
	i := slices.IndexFunc(r.Worktrees, func(w repo.Worktree) bool { return w.Path == o.Path })
	if i < 0 {
		f.mu.Unlock()
		return fmt.Errorf("%w: worktree %q", repo.ErrNotFound, o.Path)
	}
	if r.Worktrees[i].IsMain {
		f.mu.Unlock()
		return fmt.Errorf("%w: cannot remove the main worktree", repo.ErrInvalidArgument)
	}
	r.Worktrees = slices.Delete(slices.Clone(r.Worktrees), i, i+1)
	f.repos[r.ID] = r
	f.rebuild()
	f.mu.Unlock()
	f.publish(repo.WorktreeRemoved{RepoID: r.ID, Path: o.Path})
	f.publish(repo.RepoUpdated{Repo: r})
	return nil
}

// Refresh implements repo.Store.
func (f *Fake) Refresh(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "Refresh "+id)
	if f.Err != nil {
		return f.Err
	}
	if _, ok := f.repos[id]; id != "" && !ok {
		return fmt.Errorf("%w: repo %q", repo.ErrNotFound, id)
	}
	return nil
}

func (f *Fake) rebuild() {
	s := &repo.Snapshot{Repos: make([]repo.Repo, 0, len(f.repos))}
	for _, r := range f.repos {
		s.Repos = append(s.Repos, r)
	}
	slices.SortFunc(s.Repos, func(a, b repo.Repo) int { return strings.Compare(a.Name+a.Path, b.Name+b.Path) })
	f.snap = s
}

func (f *Fake) publish(ev repo.Event) {
	if f.bus != nil {
		bus.Publish(f.bus, ev)
	}
}
