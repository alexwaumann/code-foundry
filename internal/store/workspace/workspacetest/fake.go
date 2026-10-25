// Package workspacetest provides an in-memory workspace.Store for tests of code that
// consumes workspaces (API handlers, commands, the thread store). Managed dirs are
// <Dir>/<id>; EnsureDirs makes them only with MakeDirs. Every mutation publishes the
// same events as the real store.
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
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Fake implements workspace.Store.
type Fake struct {
	bus *bus.Bus
	// Dir holds the managed dirs. Default /workspaces.
	Dir string
	// MakeDirs makes Create and EnsureDirs create the managed dirs on disk.
	MakeDirs bool
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
	return &Fake{bus: b, Dir: "/workspaces", Now: time.Now, byID: map[string]workspace.Workspace{}, snap: &workspace.Snapshot{}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Calls returns the recorded calls ("Create login", "EnsureDirs w-1", ...).
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Put inserts or replaces a workspace (members sorted, ManagedDir filled when empty) and
// publishes Updated.
func (f *Fake) Put(w workspace.Workspace) workspace.Workspace {
	f.mu.Lock()
	w = f.normalize(w)
	f.byID[w.ID] = w
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[workspace.Event](f.bus, workspace.Updated{Workspace: w})
	return w
}

func (f *Fake) normalize(w workspace.Workspace) workspace.Workspace {
	w.Members = slices.Sorted(slices.Values(w.Members))
	w.Members = slices.Compact(w.Members)
	if w.ManagedDir == "" {
		w.ManagedDir = filepath.Join(f.Dir, w.ID)
	}
	return w
}

// Snapshot implements workspace.Store.
func (f *Fake) Snapshot() *workspace.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *Fake) rebuild() {
	out := make([]workspace.Workspace, 0, len(f.byID))
	for _, w := range f.byID {
		out = append(out, w)
	}
	slices.SortFunc(out, func(a, b workspace.Workspace) int {
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	f.snap = &workspace.Snapshot{Workspaces: out}
}

func (f *Fake) record(call string) error {
	f.calls = append(f.calls, call)
	return f.Err
}

// Create implements workspace.Store: members are taken as ids as given.
func (f *Fake) Create(_ context.Context, o workspace.CreateOptions) (workspace.Workspace, error) {
	f.mu.Lock()
	if err := f.record("Create " + o.Name); err != nil {
		f.mu.Unlock()
		return workspace.Workspace{}, err
	}
	if _, ok := f.snap.Named(o.Name); ok {
		f.mu.Unlock()
		return workspace.Workspace{}, fmt.Errorf("%w: a workspace named %q exists", workspace.ErrFailedPrecondition, o.Name)
	}
	f.next++
	w := workspace.Workspace{ID: "w-" + strconv.Itoa(f.next), Name: o.Name, RootPath: o.RootPath, Members: o.Members,
		DefaultPrimary: o.DefaultPrimary, CreatedAt: f.Now()}
	if w.DefaultPrimary == "" {
		w.DefaultPrimary = workspace.PrimaryWorkspace
		if o.RootPath == "" && len(o.Members) > 0 {
			w.DefaultPrimary = o.Members[0]
		}
	}
	w = f.normalize(w)
	makeDirs := f.MakeDirs
	f.mu.Unlock()
	if makeDirs {
		if err := os.MkdirAll(w.ManagedDir, 0o755); err != nil {
			return workspace.Workspace{}, err
		}
	}
	return f.Put(w), nil
}

// change applies fn to the workspace ref names and publishes it.
func (f *Fake) change(call, ref string, fn func(*workspace.Workspace) error) (workspace.Workspace, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return workspace.Workspace{}, err
	}
	w, err := workspace.ResolveWorkspace(f.snap, ref)
	if err != nil {
		f.mu.Unlock()
		return workspace.Workspace{}, err
	}
	w.Members = slices.Clone(w.Members)
	if err := fn(&w); err != nil {
		f.mu.Unlock()
		return workspace.Workspace{}, err
	}
	f.mu.Unlock()
	return f.Put(w), nil
}

// AddProject implements workspace.Store (the project ref is taken as an id).
func (f *Fake) AddProject(_ context.Context, ref, project string) (workspace.Workspace, error) {
	return f.change("AddProject "+ref+" "+project, ref, func(w *workspace.Workspace) error {
		if w.Member(project) {
			return fmt.Errorf("%w: %s is already in workspace %s", workspace.ErrFailedPrecondition, project, w.Name)
		}
		w.Members = append(w.Members, project)
		return nil
	})
}

// RemoveProject implements workspace.Store.
func (f *Fake) RemoveProject(_ context.Context, ref, project string) (workspace.Workspace, error) {
	return f.change("RemoveProject "+ref+" "+project, ref, func(w *workspace.Workspace) error {
		if !w.Member(project) {
			return fmt.Errorf("%w: %q is not a member of workspace %s", workspace.ErrNotFound, project, w.Name)
		}
		w.Members = slices.DeleteFunc(w.Members, func(id string) bool { return id == project })
		if w.DefaultPrimary == project {
			w.DefaultPrimary = workspace.PrimaryWorkspace
		}
		return nil
	})
}

// Rename implements workspace.Store.
func (f *Fake) Rename(_ context.Context, ref, name string) (workspace.Workspace, error) {
	return f.change("Rename "+ref+" "+name, ref, func(w *workspace.Workspace) error {
		if o, ok := f.snap.Named(name); ok && o.ID != w.ID {
			return fmt.Errorf("%w: a workspace named %q exists", workspace.ErrFailedPrecondition, name)
		}
		w.Name = name
		return nil
	})
}

// SetDefaultPrimary implements workspace.Store.
func (f *Fake) SetDefaultPrimary(_ context.Context, ref, primary string) (workspace.Workspace, error) {
	return f.change("SetDefaultPrimary "+ref+" "+primary, ref, func(w *workspace.Workspace) error {
		if primary != workspace.PrimaryWorkspace && !w.Member(primary) {
			return fmt.Errorf("%w: %q is not a member of workspace %s", workspace.ErrNotFound, primary, w.Name)
		}
		w.DefaultPrimary = primary
		return nil
	})
}

// Remove implements workspace.Store.
func (f *Fake) Remove(_ context.Context, ref string) error {
	f.mu.Lock()
	if err := f.record("Remove " + ref); err != nil {
		f.mu.Unlock()
		return err
	}
	w, err := workspace.ResolveWorkspace(f.snap, ref)
	if err != nil {
		f.mu.Unlock()
		return err
	}
	delete(f.byID, w.ID)
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[workspace.Event](f.bus, workspace.Removed{ID: w.ID})
	return nil
}

// ProjectRemoved implements workspace.Store: the project leaves every workspace, a
// default primary that was it becomes workspace.PrimaryWorkspace (the fake does not
// fall back to another member).
func (f *Fake) ProjectRemoved(_ context.Context, project string) error {
	f.mu.Lock()
	f.calls = append(f.calls, "ProjectRemoved "+project)
	var changed []workspace.Workspace
	for _, w := range f.byID {
		if !w.Member(project) {
			continue
		}
		w.Members = slices.DeleteFunc(slices.Clone(w.Members), func(id string) bool { return id == project })
		if w.DefaultPrimary == project {
			w.DefaultPrimary = workspace.PrimaryWorkspace
		}
		changed = append(changed, w)
	}
	f.mu.Unlock()
	for _, w := range changed {
		f.Put(w)
	}
	return nil
}

// SetRoot implements workspace.Store: the root is taken as given; a synthetic workspace
// is refused.
func (f *Fake) SetRoot(_ context.Context, ref, root string) (workspace.Workspace, error) {
	return f.change("SetRoot "+ref+" "+root, ref, func(w *workspace.Workspace) error {
		if w.Synthetic() {
			return fmt.Errorf("%w: workspace %s has no root", workspace.ErrFailedPrecondition, w.Name)
		}
		w.RootPath = root
		return nil
	})
}

// EnsureDirs records "EnsureDirs <id>" and, with MakeDirs, makes the managed dirs.
func (f *Fake) EnsureDirs(_ context.Context, id string) error {
	f.mu.Lock()
	f.calls = append(f.calls, strings.TrimSpace("EnsureDirs "+id))
	snap, makeDirs := f.snap, f.MakeDirs
	f.mu.Unlock()
	if !makeDirs {
		return nil
	}
	for _, w := range snap.Workspaces {
		if id == "" || w.ID == id {
			if err := os.MkdirAll(w.ManagedDir, 0o755); err != nil {
				return err
			}
		}
	}
	return nil
}
