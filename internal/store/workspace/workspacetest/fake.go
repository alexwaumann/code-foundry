// Package workspacetest provides an in-memory workspace.Store for tests of code that
// consumes workspaces (API handlers, commands). It never runs git: members get
// worktree paths under WorktreeRoot, and every mutation publishes the same events as
// the real store.
package workspacetest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Fake implements workspace.Store.
type Fake struct {
	bus *bus.Bus
	// Projects, when set, is joined into Members (project names, branches). Nil: members
	// are reported with no project name and Missing.
	Projects func() *project.Snapshot
	// WorktreeRoot is where member worktrees "are": <root>/<project>/<branch, / -> ->.
	WorktreeRoot string
	// MakeDirs makes Create create the member worktrees' directories, for callers that
	// start processes in them.
	MakeDirs bool
	// Err, when set, is returned by every mutating method.
	Err error
	// Uncommitted, when set, makes RemoveProject and Remove without Force fail as the
	// store does for members with uncommitted changes (*project.UncommittedError).
	Uncommitted []project.Worktree
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

func (f *Fake) path(projectID, branch string) string {
	return filepath.Join(f.WorktreeRoot, projectID, strings.ReplaceAll(branch, "/", "-"))
}

// Snapshot implements workspace.Store.
func (f *Fake) Snapshot() *workspace.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// Create implements workspace.Store. Project refs are used as project ids verbatim; the
// branch defaults to cf/<name>.
func (f *Fake) Create(_ context.Context, o workspace.CreateOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	projects := make([]string, len(o.Members))
	for i, m := range o.Members {
		projects[i] = m.Project
		if m.BaseRef != "" {
			projects[i] += ":" + m.BaseRef
		}
	}
	if err := f.record("Create " + o.Name + " " + strings.Join(projects, ",")); err != nil {
		return workspace.Workspace{}, err
	}
	if o.Name == "" || len(o.Members) == 0 {
		return workspace.Workspace{}, fmt.Errorf("%w: a name and a project are required", workspace.ErrInvalidArgument)
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
		w.Members = append(w.Members, workspace.Member{ProjectID: m.Project, WorktreePath: f.path(m.Project, w.Branch)})
		if f.MakeDirs {
			if err := os.MkdirAll(w.Members[len(w.Members)-1].WorktreePath, 0o755); err != nil {
				return workspace.Workspace{}, err
			}
		}
	}
	f.putLocked(w)
	return w, nil
}

// AddProject implements workspace.Store.
func (f *Fake) AddProject(_ context.Context, o workspace.AddProjectOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("AddProject " + o.Workspace + o.Cwd + " " + o.Member.Project); err != nil {
		return workspace.Workspace{}, err
	}
	w, err := workspace.ResolveWorkspace(f.snap, o.Ref)
	if err != nil {
		return workspace.Workspace{}, err
	}
	if _, ok := w.Member(o.Member.Project); ok {
		return workspace.Workspace{}, fmt.Errorf("%w: %s is already in workspace %s", workspace.ErrFailedPrecondition, o.Member.Project, w.Name)
	}
	w.Members = append(slices.Clone(w.Members), workspace.Member{ProjectID: o.Member.Project, WorktreePath: f.path(o.Member.Project, w.Branch)})
	f.putLocked(w)
	return w, nil
}

// RemoveProject implements workspace.Store. Project is matched against member project ids.
func (f *Fake) RemoveProject(_ context.Context, o workspace.RemoveProjectOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := "RemoveProject " + o.Workspace + o.Cwd + " " + o.Project
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
	if err := f.uncommitted(o.Force); err != nil {
		return workspace.Workspace{}, err
	}
	i := slices.IndexFunc(w.Members, func(m workspace.Member) bool { return m.ProjectID == o.Project })
	if i < 0 {
		return workspace.Workspace{}, fmt.Errorf("%w: %q is not a member of workspace %s", workspace.ErrNotFound, o.Project, w.Name)
	}
	w.Members = slices.Delete(slices.Clone(w.Members), i, i+1)
	f.putLocked(w)
	return w, nil
}

// uncommitted is the refusal of a removal without force while Uncommitted is set.
func (f *Fake) uncommitted(force bool) error {
	if force || len(f.Uncommitted) == 0 {
		return nil
	}
	return fmt.Errorf("%w: %w", workspace.ErrFailedPrecondition, &project.UncommittedError{Worktrees: f.Uncommitted})
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
	if err := f.uncommitted(o.Force); err != nil {
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
	var projects *project.Snapshot
	if f.Projects != nil {
		projects = f.Projects()
	}
	return workspace.Join(w, projects, ref.Cwd), nil
}
