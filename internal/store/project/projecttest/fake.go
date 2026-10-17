// Package repotest provides an in-memory repo.Store for tests of code that consumes
// the project store (API handlers, commands, the gh store).
package projecttest

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Fake is an in-memory repo.Store. It never runs git: Register treats the path as the
// main worktree, CreateWorktree records a worktree, and every mutation publishes the
// same events the real store does on the bus it was given (if any).
type Fake struct {
	bus *bus.Bus

	mu       sync.Mutex
	projects map[string]project.Project
	snap     *project.Snapshot
	// details backs WorktreeDetail (detail.go); nil until SetDetail.
	details map[string]project.WorktreeDetail
	// refs backs ListRefs; nil until SetRefs.
	refs map[string]project.Refs

	// WorktreeRoot is where CreateWorktree puts worktrees without a path, like
	// repo.Options.WorktreeRoot. New sets it to DefaultWorktreeRoot.
	WorktreeRoot string
	// AllowedRoot, when set, makes Register refuse paths outside it (compared
	// lexically), like repo.Options.AllowedRoot. Empty accepts any absolute path.
	AllowedRoot string
	// Remotes are given to repos created by Register (cloned). Nil, the default,
	// registers local-only repos; Put sets any remotes directly.
	Remotes []string
	// MakeDirs makes CreateWorktree create the worktree's directory, for callers that
	// start processes in it.
	MakeDirs bool
	// NotGit makes Register create projects without git (Git false, one main worktree
	// with no branch), like the real store for a plain directory.
	NotGit bool
	// Err, when set, is returned by every mutating method.
	Err error
	// Calls records method calls, e.g. "Register /x", "Refresh r1".
	Calls []string
	// Creates records every CreateWorktree's options, in call order.
	Creates []project.CreateWorktreeOptions
}

var _ project.Store = (*Fake)(nil)

// DefaultWorktreeRoot is the fake's initial WorktreeRoot.
const DefaultWorktreeRoot = "/worktrees"

// New returns an empty fake publishing to b (which may be nil).
func New(b *bus.Bus) *Fake {
	return &Fake{bus: b, projects: map[string]project.Project{}, snap: &project.Snapshot{}, WorktreeRoot: DefaultWorktreeRoot}
}

// ID returns the id the fake assigns to path.
func ID(path string) string {
	return "id-" + strings.ReplaceAll(strings.Trim(filepath.Clean(path), "/"), "/", "-")
}

// Put inserts or replaces a repo and publishes RepoUpdated.
func (f *Fake) Put(r project.Project) {
	f.mu.Lock()
	f.projects[r.ID] = r
	f.rebuild()
	f.mu.Unlock()
	f.publish(project.ProjectUpdated{Project: r})
}

// UpdateWorktree replaces a worktree's state and publishes WorktreeUpdated.
func (f *Fake) UpdateWorktree(w project.Worktree) {
	f.mu.Lock()
	r := f.projects[w.ProjectID]
	r.Worktrees = slices.Clone(r.Worktrees)
	for i := range r.Worktrees {
		if r.Worktrees[i].Path == w.Path {
			r.Worktrees[i] = w
		}
	}
	f.projects[w.ProjectID] = r
	f.rebuild()
	f.mu.Unlock()
	f.publish(project.WorktreeUpdated{Worktree: w})
}

// Snapshot implements repo.Store.
func (f *Fake) Snapshot() *project.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// Register implements repo.Store.
func (f *Fake) Register(_ context.Context, path string) (project.Project, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "Register "+path)
	if f.Err != nil {
		defer f.mu.Unlock()
		return project.Project{}, f.Err
	}
	if path == "" || !filepath.IsAbs(path) {
		f.mu.Unlock()
		return project.Project{}, fmt.Errorf("%w: path must be absolute", project.ErrInvalidArgument)
	}
	if f.AllowedRoot != "" && !fsx.Within(f.AllowedRoot, filepath.Clean(path)) {
		f.mu.Unlock()
		return project.Project{}, fmt.Errorf("%w: %s is outside your home directory", project.ErrInvalidArgument, path)
	}
	id := ID(path)
	if r, ok := f.projects[id]; ok {
		f.mu.Unlock()
		return r, nil
	}
	remotes, notGit := slices.Clone(f.Remotes), f.NotGit
	f.mu.Unlock()
	r := project.Project{
		ID: id, Path: path, Name: filepath.Base(path), RegisteredAt: time.Now(), DefaultBranch: "main", Remotes: remotes,
		Git:       true,
		Worktrees: []project.Worktree{{ProjectID: id, Path: path, Branch: "main", IsMain: true}},
	}
	if notGit {
		r.DefaultBranch, r.Remotes, r.Git = "", nil, false
		r.Worktrees = []project.Worktree{{ProjectID: id, Path: path, IsMain: true}}
	}
	f.Put(r)
	return r, nil
}

// notGit returns the real store's error for a git operation on a project without
// git, or nil. f.mu must be held.
func notGit(r project.Project) error {
	if r.Git {
		return nil
	}
	return fmt.Errorf("%w: %s is %w", project.ErrFailedPrecondition, r.Name, project.ErrNotGit)
}

// InitGit implements repo.Store: the project becomes a git project on main with the
// main worktree on main.
func (f *Fake) InitGit(_ context.Context, id string) (project.Project, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "InitGit "+id)
	if f.Err != nil {
		defer f.mu.Unlock()
		return project.Project{}, f.Err
	}
	r, ok := f.projects[id]
	if !ok {
		f.mu.Unlock()
		return project.Project{}, fmt.Errorf("%w: project %q", project.ErrNotFound, id)
	}
	if r.Git {
		f.mu.Unlock()
		return project.Project{}, fmt.Errorf("%w: %s is already a git repository", project.ErrFailedPrecondition, r.Name)
	}
	f.mu.Unlock()
	r.Git, r.DefaultBranch = true, "main"
	r.Worktrees = []project.Worktree{{ProjectID: id, Path: r.Path, Branch: "main", Head: strings.Repeat("0", 40), IsMain: true}}
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
	if _, ok := f.projects[id]; !ok {
		f.mu.Unlock()
		return fmt.Errorf("%w: project %q", project.ErrNotFound, id)
	}
	delete(f.projects, id)
	f.rebuild()
	f.mu.Unlock()
	f.publish(project.ProjectRemoved{ID: id})
	return nil
}

// CreateWorktree implements repo.Store.
func (f *Fake) CreateWorktree(_ context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "CreateWorktree "+o.ProjectID+" "+o.Branch)
	f.Creates = append(f.Creates, o)
	if f.Err != nil {
		defer f.mu.Unlock()
		return project.Worktree{}, f.Err
	}
	r, ok := f.projects[o.ProjectID]
	if !ok {
		f.mu.Unlock()
		return project.Worktree{}, fmt.Errorf("%w: project %q", project.ErrNotFound, o.ProjectID)
	}
	if err := notGit(r); err != nil {
		f.mu.Unlock()
		return project.Worktree{}, err
	}
	if o.Branch == "" {
		f.mu.Unlock()
		return project.Worktree{}, fmt.Errorf("%w: branch is required", project.ErrInvalidArgument)
	}
	path := o.Path
	if path == "" {
		slug := cmp.Or(r.GitHubSlug, "_local/"+r.Name)
		path = filepath.Join(f.WorktreeRoot, filepath.FromSlash(slug), strings.ReplaceAll(o.Branch, "/", "-"))
	}
	w := project.Worktree{ProjectID: r.ID, Path: path, Branch: o.Branch}
	r.Worktrees = append(slices.Clone(r.Worktrees), w)
	makeDirs := f.MakeDirs
	f.mu.Unlock()
	if makeDirs {
		if err := os.MkdirAll(path, 0o755); err != nil {
			return project.Worktree{}, err
		}
	}
	f.Put(r)
	return w, nil
}

// RemoveWorktree implements repo.Store.
func (f *Fake) RemoveWorktree(_ context.Context, o project.RemoveWorktreeOptions) error {
	f.mu.Lock()
	f.Calls = append(f.Calls, "RemoveWorktree "+o.ProjectID+" "+o.Path)
	if f.Err != nil {
		defer f.mu.Unlock()
		return f.Err
	}
	r, ok := f.projects[o.ProjectID]
	if !ok {
		f.mu.Unlock()
		return fmt.Errorf("%w: project %q", project.ErrNotFound, o.ProjectID)
	}
	i := slices.IndexFunc(r.Worktrees, func(w project.Worktree) bool { return w.Path == o.Path })
	if i < 0 {
		f.mu.Unlock()
		return fmt.Errorf("%w: worktree %q", project.ErrNotFound, o.Path)
	}
	if r.Worktrees[i].IsMain {
		f.mu.Unlock()
		return fmt.Errorf("%w: cannot remove the main worktree", project.ErrInvalidArgument)
	}
	r.Worktrees = slices.Delete(slices.Clone(r.Worktrees), i, i+1)
	f.projects[r.ID] = r
	f.rebuild()
	f.mu.Unlock()
	f.publish(project.WorktreeRemoved{ProjectID: r.ID, Path: o.Path})
	f.publish(project.ProjectUpdated{Project: r})
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
	if _, ok := f.projects[id]; id != "" && !ok {
		return fmt.Errorf("%w: project %q", project.ErrNotFound, id)
	}
	return nil
}

// SetRefs sets what ListRefs returns for repoID.
func (f *Fake) SetRefs(projectID string, refs project.Refs) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refs == nil {
		f.refs = map[string]project.Refs{}
	}
	f.refs[projectID] = refs
}

// ListRefs implements repo.Store. Without SetRefs, a known repo lists its worktrees'
// branches as local refs and its default branch as DefaultRef.
func (f *Fake) ListRefs(_ context.Context, projectID string) (project.Refs, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "ListRefs "+projectID)
	r, ok := f.projects[projectID]
	if !ok {
		return project.Refs{}, fmt.Errorf("%w: project %q", project.ErrNotFound, projectID)
	}
	if err := notGit(r); err != nil {
		return project.Refs{}, err
	}
	if refs, ok := f.refs[projectID]; ok {
		return refs, nil
	}
	var local []string
	for _, w := range r.Worktrees {
		if w.Branch != "" {
			local = append(local, w.Branch)
		}
	}
	slices.Sort(local)
	return project.Refs{Local: slices.Compact(local), DefaultRef: r.DefaultBranch}, nil
}

func (f *Fake) rebuild() {
	s := &project.Snapshot{Projects: make([]project.Project, 0, len(f.projects))}
	for _, r := range f.projects {
		s.Projects = append(s.Projects, r)
	}
	slices.SortFunc(s.Projects, func(a, b project.Project) int { return strings.Compare(a.Name+a.Path, b.Name+b.Path) })
	f.snap = s
}

func (f *Fake) publish(ev project.Event) {
	if f.bus != nil {
		bus.Publish(f.bus, ev)
	}
}
