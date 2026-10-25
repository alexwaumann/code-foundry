package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// ProjectSource is the part of the project store workspaces need: resolving member
// refs. *project.Git implements it.
type ProjectSource interface {
	Snapshot() *project.Snapshot
}

// Options configures a Manager. DB, Projects and Dir are required.
type Options struct {
	DB       *sql.DB
	Projects ProjectSource
	// Dir holds the managed dirs, one per workspace id (paths.Workspaces:
	// <config home>/workspaces).
	Dir string
	// Home, when set, is the folder every root path must be inside (the user's home),
	// and never a root itself.
	Home string
	// InUse, when set, refuses Remove of a synthetic workspace (whose managed dir goes)
	// while a thread runs there; the daemon wires it to the thread store, which this
	// store never looks at. The error names the threads.
	InUse func(Workspace) error
	Bus   *bus.Bus     // default: a private bus
	Log   *slog.Logger // default: slog.Default()
	Now   func() time.Time
}

// Manager is the Store backed by SQLite.
type Manager struct {
	opts Options
	log  *slog.Logger
	// mu serializes mutations. Reads use snap.
	mu   sync.Mutex
	byID map[string]Workspace
	snap atomic.Pointer[Snapshot]
}

var _ Store = (*Manager)(nil)

// New loads persisted workspaces and makes their managed dirs (EnsureDirs; a failure is
// logged, the store still opens).
func New(ctx context.Context, opts Options) (*Manager, error) {
	if opts.DB == nil || opts.Projects == nil || opts.Dir == "" {
		return nil, errors.New("workspace: Options.DB, Options.Projects and Options.Dir are required")
	}
	if opts.Bus == nil {
		opts.Bus = bus.New()
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	rows, err := loadWorkspaces(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	m := &Manager{opts: opts, log: opts.Log, byID: make(map[string]Workspace, len(rows))}
	for _, w := range rows {
		w.ManagedDir = m.managedDir(w.ID)
		m.byID[w.ID] = w
	}
	m.rebuild()
	if err := m.EnsureDirs(ctx, ""); err != nil {
		m.log.Warn("workspace managed dirs", "err", err)
	}
	return m, nil
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

func (m *Manager) managedDir(id string) string { return filepath.Join(m.opts.Dir, id) }

// rebuild publishes a new snapshot. Callers hold m.mu (or own m exclusively).
func (m *Manager) rebuild() {
	out := make([]Workspace, 0, len(m.byID))
	for _, w := range m.byID {
		out = append(out, w)
	}
	sortWorkspaces(out)
	m.snap.Store(&Snapshot{Workspaces: out})
}

// commit persists w, publishes the snapshot and emits Updated. Callers hold m.mu.
func (m *Manager) commit(ctx context.Context, w Workspace) (Workspace, error) {
	w = withContents(w)
	if err := saveWorkspace(context.WithoutCancel(ctx), m.opts.DB, w); err != nil {
		return Workspace{}, err
	}
	m.byID[w.ID] = w
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Updated{Workspace: w})
	return w, nil
}

// resolveMembers resolves project refs to ids, refusing duplicates.
func (m *Manager) resolveMembers(refs []string) ([]string, error) {
	snap := m.opts.Projects.Snapshot()
	var ids []string
	for _, ref := range refs {
		r, err := ResolveProject(snap, ref)
		if err != nil {
			return nil, err
		}
		if slices.Contains(ids, r.ID) {
			return nil, fmt.Errorf("%w: project %s is listed twice", ErrInvalidArgument, r.Name)
		}
		ids = append(ids, r.ID)
	}
	return ids, nil
}

// cleanRoot validates a root path: absolute, an existing folder, inside Options.Home
// when set but not Home itself, and neither a registered project's checkout or worktree
// nor inside one (a thread whose primary is the workspace would run in that project's
// checkout without being one of its threads); returned cleaned with symlinks resolved.
func (m *Manager) cleanRoot(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", nil
	}
	root, err := m.rootFolder(root)
	if err != nil {
		return "", err
	}
	for _, r := range m.opts.Projects.Snapshot().Projects {
		paths := []string{r.Path}
		for _, w := range r.Worktrees {
			paths = append(paths, w.Path)
		}
		for _, p := range paths {
			if p != "" && Within(root, p) {
				return "", fmt.Errorf("%w: root %s is inside project %s (%s); add the project with projects instead",
					ErrInvalidArgument, root, r.Name, p)
			}
		}
	}
	return root, nil
}

// rootFolder is cleanRoot's check of the folder itself.
func (m *Manager) rootFolder(root string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("%w: root %q must be an absolute path", ErrInvalidArgument, root)
	}
	fi, err := os.Stat(root)
	if err != nil || !fi.IsDir() {
		return "", fmt.Errorf("%w: root %s is not a folder", ErrInvalidArgument, root)
	}
	root = realPath(root)
	if m.opts.Home != "" {
		home := realPath(m.opts.Home)
		switch {
		case !fsx.Within(home, root):
			return "", fmt.Errorf("%w: root %s is outside your home directory", ErrInvalidArgument, root)
		case root == home:
			return "", fmt.Errorf("%w: your home directory cannot be a workspace's root (its .claude is your own Claude config); pick a folder inside it", ErrInvalidArgument)
		}
	}
	return root, nil
}

// primaryOf resolves a default primary ref for w: a member, or PrimaryWorkspace. A
// registered project whose id or name is "workspace" wins over the keyword (IsKeyword).
func (m *Manager) primaryOf(w Workspace, ref string) (string, error) {
	snap := m.opts.Projects.Snapshot()
	if IsKeyword(snap, ref) {
		return PrimaryWorkspace, nil
	}
	return memberRef(w, snap, ref)
}

// fallbackPrimary is where new threads of w start once its default primary is gone:
// the first member left of a synthetic workspace (its managed dir holds no code), else
// PrimaryWorkspace.
func fallbackPrimary(w Workspace) string {
	if w.Synthetic() && len(w.Members) > 0 {
		return w.Members[0]
	}
	return PrimaryWorkspace
}

// Create implements Store.
func (m *Manager) Create(ctx context.Context, o CreateOptions) (Workspace, error) {
	name, err := cleanName(o.Name)
	if err != nil {
		return Workspace{}, err
	}
	root, err := m.cleanRoot(o.RootPath)
	if err != nil {
		return Workspace{}, err
	}
	given, err := m.resolveMembers(o.Members)
	if err != nil {
		return Workspace{}, err
	}
	if len(given) == 0 && root == "" {
		return Workspace{}, fmt.Errorf("%w: a workspace needs at least one project or a root folder", ErrInvalidArgument)
	}
	id, err := newID()
	if err != nil {
		return Workspace{}, err
	}
	w := Workspace{ID: id, Name: name, RootPath: root, Members: sortedMembers(given), ManagedDir: m.managedDir(id),
		CreatedAt: m.opts.Now().Truncate(time.Millisecond)}
	switch {
	case strings.TrimSpace(o.DefaultPrimary) != "":
		if w.DefaultPrimary, err = m.primaryOf(w, o.DefaultPrimary); err != nil {
			return Workspace{}, err
		}
	case root != "" || len(given) == 0:
		w.DefaultPrimary = PrimaryWorkspace
	default:
		w.DefaultPrimary = given[0]
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := nameFree(m.Snapshot(), name, ""); err != nil {
		return Workspace{}, err
	}
	if err := ensureDir(m.log, w); err != nil {
		return Workspace{}, err
	}
	if w, err = m.commit(ctx, w); err != nil {
		_ = removeDir(m.log, m.opts.Dir, w)
		return Workspace{}, err
	}
	m.log.Info("workspace created", "workspace", w.ID, "name", w.Name, "members", len(w.Members), "root", w.RootPath, "dir", w.ManagedDir)
	return w, nil
}

// update applies fn to the workspace ref names and commits it. Callers do not hold m.mu.
func (m *Manager) update(ctx context.Context, ref string, fn func(*Workspace) error) (Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), ref)
	if err != nil {
		return Workspace{}, err
	}
	w.Members = slices.Clone(w.Members)
	if err := fn(&w); err != nil {
		return Workspace{}, err
	}
	return m.commit(ctx, w)
}

// AddProject implements Store.
func (m *Manager) AddProject(ctx context.Context, ref, projectRef string) (Workspace, error) {
	r, err := ResolveProject(m.opts.Projects.Snapshot(), projectRef)
	if err != nil {
		return Workspace{}, err
	}
	return m.update(ctx, ref, func(w *Workspace) error {
		if w.Member(r.ID) {
			return fmt.Errorf("%w: %s is already in workspace %s", ErrFailedPrecondition, r.Name, w.Name)
		}
		w.Members = sortedMembers(append(w.Members, r.ID))
		m.log.Info("workspace project added", "workspace", w.ID, "project", r.ID)
		return nil
	})
}

// RemoveProject implements Store.
func (m *Manager) RemoveProject(ctx context.Context, ref, projectRef string) (Workspace, error) {
	return m.update(ctx, ref, func(w *Workspace) error {
		pid, err := memberRef(*w, m.opts.Projects.Snapshot(), projectRef)
		if err != nil {
			return err
		}
		dropMember(w, pid)
		m.log.Info("workspace project removed", "workspace", w.ID, "project", pid, "default_primary", w.DefaultPrimary)
		return nil
	})
}

// dropMember removes pid from w's members; a default primary that was pid moves
// (fallbackPrimary).
func dropMember(w *Workspace, pid string) {
	w.Members = slices.DeleteFunc(w.Members, func(id string) bool { return id == pid })
	if w.DefaultPrimary == pid {
		w.DefaultPrimary = fallbackPrimary(*w)
	}
}

// ProjectRemoved implements Store.
func (m *Manager) ProjectRemoved(ctx context.Context, projectID string) error {
	var errs []error
	for _, w := range m.Snapshot().Workspaces {
		if !w.Member(projectID) {
			continue
		}
		_, err := m.update(ctx, w.ID, func(w *Workspace) error {
			if !w.Member(projectID) {
				return nil
			}
			dropMember(w, projectID)
			m.log.Info("unregistered project dropped from workspace", "workspace", w.ID, "project", projectID, "default_primary", w.DefaultPrimary)
			return nil
		})
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// SetRoot implements Store.
func (m *Manager) SetRoot(ctx context.Context, ref, root string) (Workspace, error) {
	if strings.TrimSpace(root) == "" {
		return Workspace{}, fmt.Errorf("%w: a root folder is required", ErrInvalidArgument)
	}
	clean, err := m.cleanRoot(root)
	if err != nil {
		return Workspace{}, err
	}
	return m.update(ctx, ref, func(w *Workspace) error {
		if w.Synthetic() {
			return fmt.Errorf("%w: workspace %s has no root (its folder is %s); a root is set when it is created", ErrFailedPrecondition, w.Name, w.ManagedDir)
		}
		m.log.Info("workspace root changed", "workspace", w.ID, "from", w.RootPath, "to", clean)
		w.RootPath = clean
		return ensureDir(m.log, *w)
	})
}

// Rename implements Store.
func (m *Manager) Rename(ctx context.Context, ref, name string) (Workspace, error) {
	name, err := cleanName(name)
	if err != nil {
		return Workspace{}, err
	}
	return m.update(ctx, ref, func(w *Workspace) error {
		if err := nameFree(m.Snapshot(), name, w.ID); err != nil {
			return err
		}
		w.Name = name
		return nil
	})
}

// SetDefaultPrimary implements Store.
func (m *Manager) SetDefaultPrimary(ctx context.Context, ref, primary string) (Workspace, error) {
	return m.update(ctx, ref, func(w *Workspace) error {
		p, err := m.primaryOf(*w, primary)
		if err != nil {
			return err
		}
		w.DefaultPrimary = p
		return nil
	})
}

// Remove implements Store.
func (m *Manager) Remove(ctx context.Context, ref string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), ref)
	if err != nil {
		return err
	}
	if w.Synthetic() && m.opts.InUse != nil {
		if err := m.opts.InUse(w); err != nil {
			return fmt.Errorf("%w: workspace %s: %w", ErrFailedPrecondition, w.Name, err)
		}
	}
	if err := deleteWorkspace(context.WithoutCancel(ctx), m.opts.DB, w.ID); err != nil {
		return err
	}
	delete(m.byID, w.ID)
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Removed{ID: w.ID})
	m.log.Info("workspace removed", "workspace", w.ID, "name", w.Name, "synthetic", w.Synthetic())
	return removeDir(m.log, m.opts.Dir, w)
}

// EnsureDirs implements Store.
func (m *Manager) EnsureDirs(_ context.Context, id string) error {
	var errs []error
	for _, w := range m.Snapshot().Workspaces {
		if id == "" || w.ID == id {
			errs = append(errs, ensureDir(m.log, w))
			m.refreshContents(w.ID)
		}
	}
	return errors.Join(errs...)
}

// refreshContents reads workspace id's instructions file and skills again; when they
// changed it publishes the snapshot and Updated (nothing is persisted: they live on disk).
func (m *Manager) refreshContents(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, ok := m.byID[id]
	if !ok {
		return
	}
	next := withContents(w)
	if sameContents(w, next) {
		return
	}
	m.byID[id] = next
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Updated{Workspace: next})
}
