// Package workspacetest provides an in-memory workspace.Store for tests of code that
// consumes workspaces (API handlers, commands). It never runs git: members get
// worktree paths under WorktreeRoot, and every mutation publishes the same events as
// the real store.
package workspacetest

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Fake implements workspace.Store.
type Fake struct {
	bus *bus.Bus
	// Repos, when set, is joined into Members (repo names, branches). Nil: members
	// are reported with no repo name and Missing.
	Repos func() *repo.Snapshot
	// WorktreeRoot is where member worktrees "are": <root>/<repo>/<branch, / -> ->.
	WorktreeRoot string
	// Err, when set, is returned by every mutating method.
	Err error
	// Now is the clock for CreatedAt.
	Now func() time.Time

	mu    sync.Mutex
	next  int
	byID  map[string]workspace.Workspace
	snap  *workspace.Snapshot
	calls []string
}

var _ workspace.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, WorktreeRoot: "/worktrees", Now: time.Now, byID: map[string]workspace.Workspace{}, snap: &workspace.Snapshot{}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Calls returns the recorded calls, e.g. "Create login web,api", "Remove login force".
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Put inserts or replaces a workspace and publishes Updated.
func (f *Fake) Put(w workspace.Workspace) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.putLocked(w)
}

func (f *Fake) putLocked(w workspace.Workspace) {
	f.byID[w.ID] = w
	f.rebuild()
	bus.Publish[workspace.Event](f.bus, workspace.Updated{Workspace: w})
}

func (f *Fake) rebuild() {
	out := make([]workspace.Workspace, 0, len(f.byID))
	for _, w := range f.byID {
		out = append(out, w)
	}
	slices.SortFunc(out, func(a, b workspace.Workspace) int { return strings.Compare(a.Name+a.ID, b.Name+b.ID) })
	f.snap = &workspace.Snapshot{Workspaces: out}
}

func (f *Fake) record(call string) error {
	f.calls = append(f.calls, call)
	return f.Err
}

func (f *Fake) path(repoID, branch string) string {
	return filepath.Join(f.WorktreeRoot, repoID, strings.ReplaceAll(branch, "/", "-"))
}

// Snapshot implements workspace.Store.
func (f *Fake) Snapshot() *workspace.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// Create implements workspace.Store. Repo refs are used as repo ids verbatim; the
// branch defaults to cf/<name>.
func (f *Fake) Create(_ context.Context, o workspace.CreateOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	repos := make([]string, len(o.Members))
	for i, m := range o.Members {
		repos[i] = m.Repo
		if m.BaseRef != "" {
			repos[i] += ":" + m.BaseRef
		}
	}
	if err := f.record("Create " + o.Name + " " + strings.Join(repos, ",")); err != nil {
		return workspace.Workspace{}, err
	}
	if o.Name == "" || len(o.Members) == 0 {
		return workspace.Workspace{}, fmt.Errorf("%w: a name and a repository are required", workspace.ErrInvalidArgument)
	}
	for _, w := range f.byID {
		if w.Name == o.Name {
			return workspace.Workspace{}, fmt.Errorf("%w: a workspace named %q exists", workspace.ErrFailedPrecondition, o.Name)
		}
	}
	f.next++
	w := workspace.Workspace{ID: "w-" + strconv.Itoa(f.next), Name: o.Name, Branch: o.Branch, CreatedAt: f.Now()}
	if w.Branch == "" {
		w.Branch = "cf/" + o.Name
	}
	for _, m := range o.Members {
		w.Members = append(w.Members, workspace.Member{RepoID: m.Repo, WorktreePath: f.path(m.Repo, w.Branch)})
	}
	f.putLocked(w)
	return w, nil
}

// AddRepo implements workspace.Store.
func (f *Fake) AddRepo(_ context.Context, o workspace.AddRepoOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("AddRepo " + o.Workspace + o.Cwd + " " + o.Member.Repo); err != nil {
		return workspace.Workspace{}, err
	}
	w, err := workspace.ResolveWorkspace(f.snap, o.Ref)
	if err != nil {
		return workspace.Workspace{}, err
	}
	if _, ok := w.Member(o.Member.Repo); ok {
		return workspace.Workspace{}, fmt.Errorf("%w: %s is already in workspace %s", workspace.ErrFailedPrecondition, o.Member.Repo, w.Name)
	}
	w.Members = append(slices.Clone(w.Members), workspace.Member{RepoID: o.Member.Repo, WorktreePath: f.path(o.Member.Repo, w.Branch)})
	f.putLocked(w)
	return w, nil
}

// RemoveRepo implements workspace.Store. Repo is matched against member repo ids.
func (f *Fake) RemoveRepo(_ context.Context, o workspace.RemoveRepoOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := "RemoveRepo " + o.Workspace + o.Cwd + " " + o.Repo
	if o.Force {
		call += " force"
	}
	if o.DeleteBranch {
		call += " delete-branch"
	}
	if err := f.record(call); err != nil {
		return workspace.Workspace{}, err
	}
	w, err := workspace.ResolveWorkspace(f.snap, o.Ref)
	if err != nil {
		return workspace.Workspace{}, err
	}
	i := slices.IndexFunc(w.Members, func(m workspace.Member) bool { return m.RepoID == o.Repo })
	if i < 0 {
		return workspace.Workspace{}, fmt.Errorf("%w: %q is not a member of workspace %s", workspace.ErrNotFound, o.Repo, w.Name)
	}
	w.Members = slices.Delete(slices.Clone(w.Members), i, i+1)
	f.putLocked(w)
	return w, nil
}

// Remove implements workspace.Store.
func (f *Fake) Remove(_ context.Context, o workspace.RemoveOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := "Remove " + o.Workspace
	if o.Force {
		call += " force"
	}
	if o.DeleteBranch {
		call += " delete-branch"
	}
	if err := f.record(call); err != nil {
		return err
	}
	w, err := workspace.ResolveWorkspace(f.snap, workspace.Ref{Workspace: o.Workspace})
	if err != nil {
		return err
	}
	delete(f.byID, w.ID)
	f.rebuild()
	bus.Publish[workspace.Event](f.bus, workspace.Removed{ID: w.ID})
	return nil
}

// Members implements workspace.Store.
func (f *Fake) Members(_ context.Context, ref workspace.Ref) (workspace.Membership, error) {
	f.mu.Lock()
	snap := f.snap
	f.calls = append(f.calls, "Members "+ref.Workspace+ref.Cwd)
	f.mu.Unlock()
	w, err := workspace.ResolveWorkspace(snap, ref)
	if err != nil {
		return workspace.Membership{}, err
	}
	var repos *repo.Snapshot
	if f.Repos != nil {
		repos = f.Repos()
	}
	return workspace.Join(w, repos, ref.Cwd), nil
}
