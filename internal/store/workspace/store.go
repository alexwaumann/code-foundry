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
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// RepoSource is the part of the repo store workspaces need. *repo.Git implements it.
type RepoSource interface {
	Snapshot() *repo.Snapshot
	CreateWorktree(ctx context.Context, opts repo.CreateWorktreeOptions) (repo.Worktree, error)
	RemoveWorktree(ctx context.Context, opts repo.RemoveWorktreeOptions) error
	ListRefs(ctx context.Context, repoID string) (repo.Refs, error)
	Refresh(ctx context.Context, id string) error
}

// Options configures a Manager. DB and Repos are required.
type Options struct {
	DB    *sql.DB
	Repos RepoSource
	Bus   *bus.Bus     // default: a private bus
	Log   *slog.Logger // default: slog.Default()
	// Threads lists the live threads (sessions with a process). Removing a member
	// worktree a thread runs in is refused. Nil: none.
	Threads func() []Thread
	// Trust pre-trusts a new member worktree for Claude, as a session's worktree is
	// before claude starts. Nil skips it. A failure is logged, not returned.
	Trust func(dir string) error
	// WorktreePath, when set, picks the path of a member worktree for branch in r; ""
	// leaves it to the repo store's default. The daemon applies repos.worktree_dir.
	WorktreePath func(r repo.Repo, branch string) string
	Now          func() time.Time
}

// Manager is the Store backed by SQLite and the repo store.
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
	if opts.DB == nil || opts.Repos == nil {
		return nil, errors.New("workspace: Options.DB and Options.Repos are required")
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
	branch, err := branchFor(name, o.Branch)
	if err != nil {
		return Workspace{}, err
	}
	if err := validateRef("base ref", o.BaseRef); err != nil {
		return Workspace{}, err
	}
	if len(o.Members) == 0 {
		return Workspace{}, fmt.Errorf("%w: a workspace needs at least one repository", ErrInvalidArgument)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, w := range m.byID {
		if w.Name == name {
			return Workspace{}, fmt.Errorf("%w: a workspace named %q exists (%s)", ErrFailedPrecondition, name, w.ID)
		}
	}
	repos := m.opts.Repos.Snapshot()
	type plan struct {
		r    repo.Repo
		base string
	}
	plans := make([]plan, 0, len(o.Members))
	for _, spec := range o.Members {
		r, err := ResolveRepo(repos, spec.Repo)
		if err != nil {
			return Workspace{}, err
		}
		if err := RequireGit(r); err != nil {
			return Workspace{}, err
		}
		if slices.ContainsFunc(plans, func(p plan) bool { return p.r.ID == r.ID }) {
			return Workspace{}, fmt.Errorf("%w: repository %s is listed twice", ErrInvalidArgument, r.Name)
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
	return w, nil
}

// AddRepo implements Store.
func (m *Manager) AddRepo(ctx context.Context, o AddRepoOptions) (Workspace, error) {
	if err := validateRef("base ref", o.Member.BaseRef); err != nil {
		return Workspace{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), o.Ref)
	if err != nil {
		return Workspace{}, err
	}
	r, err := ResolveRepo(m.opts.Repos.Snapshot(), o.Member.Repo)
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
	m.log.Info("workspace repo added", "workspace", w.ID, "repo", r.ID, "path", c.member.WorktreePath)
	return w, nil
}

// RemoveRepo implements Store.
func (m *Manager) RemoveRepo(ctx context.Context, o RemoveRepoOptions) (Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := ResolveWorkspace(m.Snapshot(), o.Ref)
	if err != nil {
		return Workspace{}, err
	}
	mem, err := memberFor(w, m.opts.Repos.Snapshot(), o.Repo)
	if err != nil {
		return Workspace{}, err
	}
	if ts := threadsIn(m.threads(), mem.WorktreePath); len(ts) > 0 {
		return Workspace{}, fmt.Errorf("%w: %s running in %s; close it first", ErrFailedPrecondition, describeThreads(ts), mem.WorktreePath)
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
	for _, mem := range w.Members {
		if ts := threadsIn(threads, mem.WorktreePath); len(ts) > 0 {
			busy = append(busy, describeThreads(ts)+" in "+mem.WorktreePath)
		}
	}
	if len(busy) > 0 {
		return fmt.Errorf("%w: %s; close them first", ErrFailedPrecondition, strings.Join(busy, "; "))
	}
	if !o.Force {
		if dirty := m.dirtyMembers(ctx, w); len(dirty) > 0 {
			return fmt.Errorf("%w: uncommitted changes in %s; commit them or remove with --force",
				ErrFailedPrecondition, strings.Join(dirty, ", "))
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
	return Join(w, m.opts.Repos.Snapshot(), ref.Cwd), nil
}

// created is a member worktree an operation made, for rollback.
type created struct {
	member Member
	// newBranch: the branch did not exist before, so rollback deletes it too.
	newBranch bool
}

// createMember makes r's worktree on branch (the same path a new thread's worktree
// takes: fetch the base, git worktree add) and pre-trusts it.
func (m *Manager) createMember(ctx context.Context, r repo.Repo, branch, base string, fetch bool) (created, error) {
	existed := true
	if refs, err := m.opts.Repos.ListRefs(ctx, r.ID); err == nil {
		existed = slices.Contains(refs.Local, branch)
	}
	path := ""
	if m.opts.WorktreePath != nil {
		path = m.opts.WorktreePath(r, branch)
	}
	wt, err := m.opts.Repos.CreateWorktree(ctx, repo.CreateWorktreeOptions{
		RepoID: r.ID, Branch: branch, BaseRef: base, Path: path, Fetch: fetch,
	})
	if err != nil {
		return created{}, repoError("create worktree "+branch+" in "+r.Name, err)
	}
	if m.opts.Trust != nil {
		if err := m.opts.Trust(wt.Path); err != nil {
			m.log.Warn("pre-trust workspace worktree failed; claude will ask", "path", wt.Path, "err", err)
		}
	}
	m.log.Info("workspace worktree created", "repo", r.ID, "branch", branch, "path", wt.Path, "base", base)
	return created{member: Member{RepoID: r.ID, WorktreePath: wt.Path}, newBranch: !existed}, nil
}

// rollback removes worktrees an operation made before it failed, newest first. It
// runs even when ctx is cancelled.
func (m *Manager) rollback(ctx context.Context, made []created) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	for i := len(made) - 1; i >= 0; i-- {
		c := made[i]
		if err := m.opts.Repos.RemoveWorktree(ctx, repo.RemoveWorktreeOptions{
			RepoID: c.member.RepoID, Path: c.member.WorktreePath, Force: true, DeleteBranch: c.newBranch,
		}); err != nil {
			m.log.Warn("workspace rollback: remove worktree", "repo", c.member.RepoID, "path", c.member.WorktreePath, "err", err)
		}
	}
}

// removeMember removes mem's worktree through the repo store (git refuses a dirty
// worktree without force). gone reports whether the worktree is no longer there, so
// the member can be dropped: removed now, already deleted by hand, or its repository
// is no longer registered (the files are then left alone).
func (m *Manager) removeMember(ctx context.Context, mem Member, force, deleteBranch bool) (gone bool, err error) {
	if _, ok := m.opts.Repos.Snapshot().Repo(mem.RepoID); !ok {
		m.log.Warn("workspace member's repository is not registered; leaving its worktree on disk",
			"repo", mem.RepoID, "path", mem.WorktreePath)
		return true, nil
	}
	err = m.opts.Repos.RemoveWorktree(ctx, repo.RemoveWorktreeOptions{
		RepoID: mem.RepoID, Path: mem.WorktreePath, Force: force, DeleteBranch: deleteBranch,
	})
	gone = !exists(mem.WorktreePath)
	switch {
	case err == nil:
		return true, nil
	case gone && errors.Is(err, repo.ErrNotFound):
		m.log.Info("workspace member worktree was already gone", "repo", mem.RepoID, "path", mem.WorktreePath)
		return true, nil
	default:
		return gone, repoError("remove worktree "+mem.WorktreePath, err)
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
		if err := deleteMember(ctx, m.opts.DB, w.ID, mem.RepoID); err != nil {
			errs = append(errs, err)
			kept = append(kept, mem)
		}
	}
	w.Members = kept
	m.put(*w)
	return errors.Join(errs...)
}

// dirtyMembers refreshes each member's repository and names the members whose
// worktree has uncommitted changes.
func (m *Manager) dirtyMembers(ctx context.Context, w Workspace) []string {
	var out []string
	for _, mem := range w.Members {
		if err := m.opts.Repos.Refresh(ctx, mem.RepoID); err != nil {
			continue // unregistered or failing: removal reports it
		}
		snap := m.opts.Repos.Snapshot()
		if wt, ok := snap.Worktree(mem.RepoID, mem.WorktreePath); ok && wt.Status.Dirty {
			name := mem.RepoID
			if r, ok := snap.Repo(mem.RepoID); ok {
				name = r.Name
			}
			out = append(out, name+" ("+mem.WorktreePath+")")
		}
	}
	return out
}

// repoError wraps a repo store error in the workspace error class with the same
// meaning, so API codes survive.
func repoError(what string, err error) error {
	var kind error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: %w", what, err)
	case errors.Is(err, repo.ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, repo.ErrInvalidArgument):
		kind = ErrInvalidArgument
	default:
		kind = ErrFailedPrecondition
	}
	return classified{kind: kind, err: fmt.Errorf("%s: %w", what, err)}
}

// classified adds a workspace error class to an error without repeating it in the
// message (repo errors already start with "failed precondition: ...").
type classified struct{ kind, err error }

func (c classified) Error() string   { return c.err.Error() }
func (c classified) Unwrap() []error { return []error{c.kind, c.err} }
