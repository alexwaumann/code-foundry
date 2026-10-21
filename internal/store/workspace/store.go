package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// ProjectSource is the part of the project store workspaces need. *project.Git implements it.
type ProjectSource interface {
	Snapshot() *project.Snapshot
	CreateWorktree(ctx context.Context, opts project.CreateWorktreeOptions) (project.Worktree, error)
	RemoveWorktree(ctx context.Context, opts project.RemoveWorktreeOptions) error
	ListRefs(ctx context.Context, projectID string) (project.Refs, error)
	Refresh(ctx context.Context, id string) error
}

// Options configures a Manager. DB and Projects are required.
type Options struct {
	DB       *sql.DB
	Projects ProjectSource
	Bus      *bus.Bus     // default: a private bus
	Log      *slog.Logger // default: slog.Default()
	// Threads lists the threads that own their cwd (every one but an archived one, in any
	// state: the daemon's worktreeThreads). Removing a member
	// worktree a thread is on is refused. Nil: none.
	Threads func() []Thread
	// Trust pre-trusts a new member worktree for Claude, as a thread's worktree is
	// before claude starts. Nil skips it. A failure is logged, not returned.
	Trust func(dir string) error
	// BaseFromOrigin reads projects.base_from_origin at every member worktree
	// (project.CreateWorktreeOptions.BaseFromOrigin). Nil: on.
	BaseFromOrigin func() bool
	// DefaultBranch names the branch of a workspace created without one from its name
	// (the daemon: the thread store's WorkspaceBranch, which follows
	// projects.branch_naming). Nil, or "": cf/<slug of the name>.
	DefaultBranch func(ctx context.Context, name string) string
	Now           func() time.Time
}

// Manager is the Store backed by SQLite and the project store.
type Manager struct {
	opts Options
	log  *slog.Logger
	// mu serializes mutations, git work included, so two operations never race on a
	// workspace (or create the same branch twice). Reads use snap.
	mu   sync.Mutex
	byID map[string]Workspace
	snap atomic.Pointer[Snapshot]
}

var _ Store = (*Manager)(nil)

// New loads persisted workspaces and returns the Manager.
func New(ctx context.Context, opts Options) (*Manager, error) {
	if opts.DB == nil || opts.Projects == nil {
		return nil, errors.New("workspace: Options.DB and Options.Projects are required")
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
	if opts.BaseFromOrigin == nil {
		opts.BaseFromOrigin = func() bool { return true }
	}
	rows, err := loadWorkspaces(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	m := &Manager{opts: opts, log: opts.Log, byID: make(map[string]Workspace, len(rows))}
	for _, w := range rows {
		m.byID[w.ID] = w
	}
	m.rebuild()
	return m, nil
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

// rebuild publishes a new snapshot. Callers hold m.mu (or own m exclusively).
func (m *Manager) rebuild() {
	out := make([]Workspace, 0, len(m.byID))
	for _, w := range m.byID {
		out = append(out, w)
	}
	sortWorkspaces(out)
	m.snap.Store(&Snapshot{Workspaces: out})
}

// put stores w, publishes the snapshot, and emits Updated. Callers hold m.mu.
func (m *Manager) put(w Workspace) {
	m.byID[w.ID] = w
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Updated{Workspace: w})
}

func (m *Manager) threads() []Thread {
	if m.opts.Threads == nil {
		return nil
	}
	return m.opts.Threads()
}

// Create implements Store.
func (m *Manager) Create(ctx context.Context, o CreateOptions) (Workspace, error) {
	name, err := cleanName(o.Name)
	if err != nil {
		return Workspace{}, err
	}
	// Everything cheap is checked before the branch is named: naming one from the name
	// may ask the namer, a model call bounded by its timeout (fuzz finding api 4).
	if err := validateRef("base ref", o.BaseRef); err != nil {
		return Workspace{}, err
	}
	if len(o.Members) == 0 {
		return Workspace{}, fmt.Errorf("%w: a workspace needs at least one project", ErrInvalidArgument)
	}
	if err := nameFree(m.Snapshot(), name); err != nil {
		return Workspace{}, err
	}
	projects := m.opts.Projects.Snapshot()
	type plan struct {
		r    project.Project
		base string
	}
	plans := make([]plan, 0, len(o.Members))
	for _, spec := range o.Members {
		r, err := ResolveProject(projects, spec.Project)
		if err != nil {
			return Workspace{}, err
		}
		if err := RequireGit(r); err != nil {
			return Workspace{}, err
		}
		if slices.ContainsFunc(plans, func(p plan) bool { return p.r.ID == r.ID }) {
			return Workspace{}, fmt.Errorf("%w: project %s is listed twice", ErrInvalidArgument, r.Name)
		}
		base := strings.TrimSpace(spec.BaseRef)
		if base == "" {
			base = strings.TrimSpace(o.BaseRef)
		}
		if err := validateRef("base ref", base); err != nil {
			return Workspace{}, err
		}
		plans = append(plans, plan{r: r, base: base})
	}
	branch, err := branchFor(ctx, name, o.Branch, m.opts.DefaultBranch)
	if err != nil {
		return Workspace{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := nameFree(m.Snapshot(), name); err != nil { // again: one may have been made meanwhile
		return Workspace{}, err
	}
	id, err := newID()
	if err != nil {
		return Workspace{}, err
	}
	var made []created
	for _, p := range plans {
		c, err := m.createMember(ctx, p.r, branch, p.base, o.Fetch)
		if err != nil {
			m.rollback(ctx, made)
			return Workspace{}, err
		}
		made = append(made, c)
	}
	w := Workspace{ID: id, Name: name, Branch: branch, CreatedAt: m.opts.Now().Truncate(time.Millisecond)}
	for _, c := range made {
		w.Members = append(w.Members, c.member)
	}
	if err := insertWorkspace(context.WithoutCancel(ctx), m.opts.DB, w); err != nil {
		m.rollback(ctx, made)
		return Workspace{}, err
	}
	m.put(w)
	m.log.Info("workspace created", "workspace", w.ID, "name", w.Name, "branch", w.Branch, "members", len(w.Members))
	return withStartPoints(w, made), nil
}

// nameFree refuses a name a workspace in snap has.
func nameFree(snap *Snapshot, name string) error {
	for _, w := range snap.Workspaces {
		if w.Name == name {
			return fmt.Errorf("%w: a workspace named %q exists (%s)", ErrFailedPrecondition, name, w.ID)
		}
	}
	return nil
}

// AddProject implements Store.
func (m *Manager) AddProject(ctx context.Context, o AddProjectOptions) (Workspace, error) {
	if err := validateRef("base ref", o.Member.BaseRef); err != nil {
		return Workspace{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), o.Ref)
	if err != nil {
		return Workspace{}, err
	}
	r, err := ResolveProject(m.opts.Projects.Snapshot(), o.Member.Project)
	if err != nil {
		return Workspace{}, err
	}
	if err := RequireGit(r); err != nil {
		return Workspace{}, err
	}
	if mem, ok := w.Member(r.ID); ok {
		return Workspace{}, fmt.Errorf("%w: %s is already in workspace %s (%s)", ErrFailedPrecondition, r.Name, w.Name, mem.WorktreePath)
	}
	c, err := m.createMember(ctx, r, w.Branch, strings.TrimSpace(o.Member.BaseRef), o.Fetch)
	if err != nil {
		return Workspace{}, err
	}
	if err := insertMember(context.WithoutCancel(ctx), m.opts.DB, w.ID, c.member, m.opts.Now()); err != nil {
		m.rollback(ctx, []created{c})
		return Workspace{}, err
	}
	w.Members = append(slices.Clone(w.Members), c.member)
	m.put(w)
	m.log.Info("workspace project added", "workspace", w.ID, "project", r.ID, "path", c.member.WorktreePath)
	return withStartPoints(w, []created{c}), nil
}

// RemoveProject implements Store.
func (m *Manager) RemoveProject(ctx context.Context, o RemoveProjectOptions) (Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), o.Ref)
	if err != nil {
		return Workspace{}, err
	}
	mem, err := memberFor(w, m.opts.Projects.Snapshot(), o.Project)
	if err != nil {
		return Workspace{}, err
	}
	if ts := threadsIn(m.threads(), mem.WorktreePath); len(ts) > 0 {
		return Workspace{}, fmt.Errorf("%w: %s %s on %s; %s first", ErrFailedPrecondition, describeThreads(ts), isAre(len(ts)), mem.WorktreePath, archiveThem(len(ts)))
	}
	gone, rmErr := m.removeMember(ctx, mem, o.Force, o.DeleteBranch)
	if gone {
		if err := m.dropMembers(ctx, &w, mem); err != nil {
			return Workspace{}, errors.Join(rmErr, err)
		}
	}
	return w, rmErr
}

// Remove implements Store.
func (m *Manager) Remove(ctx context.Context, o RemoveOptions) error {
	if strings.TrimSpace(o.Workspace) == "" {
		return fmt.Errorf("%w: a workspace id or name is required", ErrInvalidArgument)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), Ref{Workspace: o.Workspace})
	if err != nil {
		return err
	}
	threads := m.threads()
	var busy []string
	n := 0
	for _, mem := range w.Members {
		if ts := threadsIn(threads, mem.WorktreePath); len(ts) > 0 {
			busy = append(busy, describeThreads(ts)+" "+isAre(len(ts))+" on "+mem.WorktreePath)
			n += len(ts)
		}
	}
	if len(busy) > 0 {
		return fmt.Errorf("%w: %s; %s first", ErrFailedPrecondition, strings.Join(busy, "; "), archiveThem(n))
	}
	if !o.Force {
		if dirty := m.dirtyMembers(ctx, w); len(dirty) > 0 {
			return classified{kind: ErrFailedPrecondition, err: &project.UncommittedError{Worktrees: dirty}}
		}
	}
	var removed []Member
	var errs []error
	for _, mem := range w.Members {
		gone, err := m.removeMember(ctx, mem, o.Force, o.DeleteBranch)
		if gone {
			removed = append(removed, mem)
		}
		if err != nil {
			errs = append(errs, err)
			if !gone {
				break // stop at the first worktree git refused; the rest stay intact
			}
		}
	}
	if len(removed) < len(w.Members) {
		// Keep the workspace with the members that are still on disk.
		return errors.Join(append(errs, m.dropMembers(ctx, &w, removed...))...)
	}
	if err := deleteWorkspace(context.WithoutCancel(ctx), m.opts.DB, w.ID); err != nil {
		return errors.Join(append(errs, err)...)
	}
	delete(m.byID, w.ID)
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Removed{ID: w.ID})
	m.log.Info("workspace removed", "workspace", w.ID, "name", w.Name)
	return errors.Join(errs...)
}

// Members implements Store.
func (m *Manager) Members(_ context.Context, ref Ref) (Membership, error) {
	w, err := ResolveWorkspace(m.Snapshot(), ref)
	if err != nil {
		return Membership{}, err
	}
	return Join(w, m.opts.Projects.Snapshot(), ref.Cwd), nil
}

// created is a member worktree an operation made, for rollback.
type created struct {
	member Member
	// newBranch: the branch did not exist before, so rollback deletes it too.
	newBranch bool
	// startPoint is the ref the branch was created from (Member.StartPoint).
	startPoint string
}

// withStartPoints is w with made's start points on its members, for Create's and
// AddProject's caller; the stored snapshot keeps none.
func withStartPoints(w Workspace, made []created) Workspace {
	w.Members = slices.Clone(w.Members)
	for i, mem := range w.Members {
		if j := slices.IndexFunc(made, func(c created) bool { return c.member.ProjectID == mem.ProjectID }); j >= 0 {
			w.Members[i].StartPoint = made[j].startPoint
		}
	}
	return w
}

// createMember makes r's worktree on branch (the same path a new thread's worktree
// takes: fetch the base, git worktree add) and pre-trusts it.
func (m *Manager) createMember(ctx context.Context, r project.Project, branch, base string, fetch bool) (created, error) {
	existed := true
	if refs, err := m.opts.Projects.ListRefs(ctx, r.ID); err == nil {
		existed = slices.Contains(refs.Local, branch)
		if base != "" && !existed && slices.Contains(refs.Remote, "origin/"+branch) {
			// An existing branch is checked out (tracking origin's), not made again
			// from the base; a local one already ignores it.
			m.log.Info("branch exists on origin; checking it out and ignoring the base", "project", r.ID, "branch", branch, "base", base)
			base = ""
		}
	}
	wt, err := m.opts.Projects.CreateWorktree(ctx, project.CreateWorktreeOptions{
		ProjectID: r.ID, Branch: branch, BaseRef: base, Fetch: fetch, BaseFromOrigin: m.opts.BaseFromOrigin(),
	})
	if err != nil {
		return created{}, projectError("create worktree "+branch+" in "+r.Name, err)
	}
	if m.opts.Trust != nil {
		if err := m.opts.Trust(wt.Path); err != nil {
			m.log.Warn("pre-trust workspace worktree failed; claude will ask", "path", wt.Path, "err", err)
		}
	}
	m.log.Info("workspace worktree created", "project", r.ID, "branch", branch, "path", wt.Path, "base", base, "start_point", wt.StartPoint)
	return created{member: Member{ProjectID: r.ID, WorktreePath: wt.Path}, newBranch: !existed, startPoint: wt.StartPoint}, nil
}

// rollback removes worktrees an operation made before it failed, newest first. It
// runs even when ctx is cancelled.
func (m *Manager) rollback(ctx context.Context, made []created) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	for i := len(made) - 1; i >= 0; i-- {
		c := made[i]
		if err := m.opts.Projects.RemoveWorktree(ctx, project.RemoveWorktreeOptions{
			ProjectID: c.member.ProjectID, Path: c.member.WorktreePath, Force: true, DeleteBranch: c.newBranch,
		}); err != nil {
			m.log.Warn("workspace rollback: remove worktree", "project", c.member.ProjectID, "path", c.member.WorktreePath, "err", err)
		}
	}
}

// removeMember removes mem's worktree through the project store (git refuses a dirty
// worktree without force). gone reports whether the worktree is no longer there, so
// the member can be dropped: removed now, already deleted by hand, or its project
// is no longer registered (the files are then left alone).
func (m *Manager) removeMember(ctx context.Context, mem Member, force, deleteBranch bool) (gone bool, err error) {
	if _, ok := m.opts.Projects.Snapshot().Project(mem.ProjectID); !ok {
		m.log.Warn("workspace member's project is not registered; leaving its worktree on disk",
			"project", mem.ProjectID, "path", mem.WorktreePath)
		return true, nil
	}
	err = m.opts.Projects.RemoveWorktree(ctx, project.RemoveWorktreeOptions{
		ProjectID: mem.ProjectID, Path: mem.WorktreePath, Force: force, DeleteBranch: deleteBranch,
	})
	gone = !exists(mem.WorktreePath)
	switch {
	case err == nil:
		return true, nil
	case gone && errors.Is(err, project.ErrNotFound):
		m.log.Info("workspace member worktree was already gone", "project", mem.ProjectID, "path", mem.WorktreePath)
		return true, nil
	default:
		return gone, projectError("remove worktree "+mem.WorktreePath, err)
	}
}

// dropMembers removes members from *w, persists, and publishes.
func (m *Manager) dropMembers(ctx context.Context, w *Workspace, drop ...Member) error {
	if len(drop) == 0 {
		return nil
	}
	ctx = context.WithoutCancel(ctx)
	var errs []error
	kept := make([]Member, 0, len(w.Members))
	for _, mem := range w.Members {
		if !slices.Contains(drop, mem) {
			kept = append(kept, mem)
			continue
		}
		if err := deleteMember(ctx, m.opts.DB, w.ID, mem.ProjectID); err != nil {
			errs = append(errs, err)
			kept = append(kept, mem)
		}
	}
	w.Members = kept
	m.put(*w)
	return errors.Join(errs...)
}

// dirtyMembers refreshes each member's project and returns the member worktrees
// with uncommitted changes, with their status.
func (m *Manager) dirtyMembers(ctx context.Context, w Workspace) []project.Worktree {
	var out []project.Worktree
	for _, mem := range w.Members {
		if err := m.opts.Projects.Refresh(ctx, mem.ProjectID); err != nil {
			continue // unregistered or failing: removal reports it
		}
		if wt, ok := m.opts.Projects.Snapshot().Worktree(mem.ProjectID, mem.WorktreePath); ok && wt.Status.HasUncommitted() {
			out = append(out, wt)
		}
	}
	return out
}

// projectError wraps a project store error in the workspace error class with the same
// meaning, so API codes survive.
func projectError(what string, err error) error {
	var kind error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: %w", what, err)
	case errors.Is(err, project.ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, project.ErrInvalidArgument):
		kind = ErrInvalidArgument
	default:
		kind = ErrFailedPrecondition
	}
	return classified{kind: kind, err: fmt.Errorf("%s: %w", what, err)}
}

// classified adds a workspace error class to an error without repeating it in the
// message (project errors already start with "failed precondition: ...").
type classified struct{ kind, err error }

func (c classified) Error() string   { return c.err.Error() }
func (c classified) Unwrap() []error { return []error{c.kind, c.err} }
