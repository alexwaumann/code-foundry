package thread

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Derived checkouts (docs/notes/workspaces-v2-handoff.md §3,
// docs/notes/workspaces-v2-1-threads.md). A thread has a project set (Thread.ProjectIDs)
// and every member has one checkout, derived from the thread's row and the project
// store, never stored:
//
//   - the primary (Thread.ProjectID): the cwd, Thread.WorktreePath;
//   - worktree mode (Thread.CreatedWorktree with a Branch): a git member's worktree on
//     the branch, at project.Git.DefaultWorktreePath, which every thread computes alike,
//     so threads on one branch share it; a plain folder is the folder itself;
//   - checkout mode: the member's own checkout (its main worktree, or the folder).
//
// Missing worktrees are made at spawn (ensureCheckouts) and given to Claude as --add-dir
// (claudeCommand); an archive removes the ones nobody else has (the daemon's
// cleanupArchived).

// Checkout is one member's checkout for a thread.
type Checkout struct {
	ProjectID string
	// ProjectName is the project's name; "" when it is no longer registered.
	ProjectName string
	Path        string
	// Branch is what the checkout has checked out now (the project snapshot), else the
	// thread's branch for a derived worktree; "" for a plain folder or when unknown.
	Branch string
	// Primary: the thread's cwd.
	Primary bool
	// Git: the project has git; false for a plain folder and for a project that is no
	// longer registered (Registered false).
	Git        bool
	Registered bool
	// Derived: a worktree-mode git member's (project, branch) worktree, which the app
	// makes when missing and an archive may remove.
	Derived bool
	// Missing: Path does not exist (a derived worktree not made yet, or removed).
	Missing bool
	// Instructions is Path/CLAUDE.md when that file exists.
	Instructions string
	// FromWorkspace: Path is the member worktree of the v1 workspace (a branch set) the
	// thread references, as the workspace store has it. A missing one is skipped at
	// spawn, as before. Goes with the workspace store's reshape.
	FromWorkspace bool
}

// CleanProjectIDs is ids sorted, without blanks and duplicates, with primary added when
// it is set: the shape of Thread.ProjectIDs.
func CleanProjectIDs(primary string, ids []string) []string {
	out := make([]string, 0, len(ids)+1)
	for _, id := range append(slices.Clone(ids), primary) {
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) == 0 {
		return nil
	}
	return out
}

// Projects is t's project set (Thread.ProjectIDs, with ProjectID for rows that predate
// it).
func (t Thread) Projects() []string { return CleanProjectIDs(t.ProjectID, t.ProjectIDs) }

// worktreeMode: t's git members work in worktrees on t.Branch.
func (t Thread) worktreeMode() bool { return t.CreatedWorktree && t.Branch != "" }

// CheckoutsOf derives t's checkouts, in project id order, from the project snapshot.
// pathFor is where the project store puts a project's worktree for a branch
// (project.Git.DefaultWorktreePath); exists reports whether a path is a directory. Pure
// apart from what those two read.
func CheckoutsOf(t Thread, snap *project.Snapshot, pathFor func(projectID, branch string) string, exists func(string) bool) []Checkout {
	ids := t.Projects()
	out := make([]Checkout, 0, len(ids))
	for _, id := range ids {
		c := Checkout{ProjectID: id, Primary: id == t.ProjectID}
		r, ok := snap.Project(id)
		if ok {
			c.ProjectName, c.Registered, c.Git = r.Name, true, r.Git
		}
		switch {
		case c.Primary:
			c.Path = t.WorktreePath
			c.Derived = c.Git && t.worktreeMode()
			c.Branch = branchAt(snap, id, c.Path, t.Branch, c.Derived)
		case !ok:
			// Nothing to derive from: the checkout is unknown.
		case !r.Git:
			c.Path = r.Path
		case t.worktreeMode():
			c.Derived = true
			if w, ok := derivedWorktree(r, t.Branch, pathFor(id, t.Branch)); ok {
				c.Path = w.Path
			} else {
				c.Path = pathFor(id, t.Branch)
			}
			c.Branch = branchAt(snap, id, c.Path, t.Branch, true)
		default:
			c.Path = mainCheckout(r)
			c.Branch = branchAt(snap, id, c.Path, "", false)
		}
		c.Missing = c.Path == "" || !exists(c.Path)
		if !c.Missing {
			if p := filepath.Join(c.Path, "CLAUDE.md"); fileExists(p) {
				c.Instructions = p
			}
		}
		out = append(out, c)
	}
	return out
}

// branchAt is the branch the worktree at path has checked out, else fallback (when
// derived).
func branchAt(snap *project.Snapshot, projectID, path, fallback string, derived bool) string {
	if w, ok := snap.Worktree(projectID, path); ok && w.Branch != "" {
		return w.Branch
	}
	if derived {
		return fallback
	}
	return ""
}

// derivedWorktree is r's worktree for branch: the one at want (the default path) when
// listed, else another worktree with the branch checked out (one made before the path
// rule, or by hand), the main checkout last.
func derivedWorktree(r project.Project, branch, want string) (project.Worktree, bool) {
	var found *project.Worktree
	for i, w := range r.Worktrees {
		switch {
		case want != "" && samePath(w.Path, want):
			return w, true
		case w.Branch != branch || w.Detached:
		case found == nil || found.IsMain:
			found = &r.Worktrees[i]
		}
	}
	if found == nil {
		return project.Worktree{}, false
	}
	return *found, true
}

// mainCheckout is r's own checkout: its main worktree, else its path.
func mainCheckout(r project.Project) string {
	for _, w := range r.Worktrees {
		if w.IsMain {
			return w.Path
		}
	}
	if len(r.Worktrees) > 0 {
		return r.Worktrees[0].Path
	}
	return r.Path
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

// checkouts is CheckoutsOf over the project store; with none (tests), only the primary.
// A member of the v1 workspace t references (until the workspace store's reshape) has
// the member worktree the workspace store records, which is the derived path for the
// workspace's branch anyway.
func (m *Manager) checkouts(t Thread) []Checkout {
	var snap *project.Snapshot
	pathFor := func(string, string) string { return "" }
	if m.opts.Projects != nil {
		snap, pathFor = m.opts.Projects.Snapshot(), m.opts.Projects.DefaultWorktreePath
	}
	cos := CheckoutsOf(t, snap, pathFor, isDir)
	if t.WorkspaceID == "" || m.opts.Workspaces == nil {
		return cos
	}
	w, ok := m.opts.Workspaces.Snapshot().Workspace(t.WorkspaceID)
	if !ok {
		return cos
	}
	for i, c := range cos {
		mem, ok := w.Member(c.ProjectID)
		if !ok || c.Primary || mem.WorktreePath == "" {
			continue
		}
		c.Path, c.FromWorkspace, c.Missing, c.Instructions = mem.WorktreePath, true, !isDir(mem.WorktreePath), ""
		c.Branch = branchAt(snap, c.ProjectID, c.Path, w.Branch, true)
		if p := filepath.Join(c.Path, "CLAUDE.md"); !c.Missing && fileExists(p) {
			c.Instructions = p
		}
		cos[i] = c
	}
	return cos
}

// CheckoutsOf implements the daemon's view of a thread's checkouts over the store's
// project source (the cleanup and branch-link rules use it).
func (m *Manager) CheckoutsOf(t Thread) []Checkout { return m.checkouts(t) }

// memberDirs are t's other checkouts that exist, for --add-dir, and the registered
// members whose checkout does not.
func (m *Manager) memberDirs(t Thread) (dirs []string, missing []Checkout) {
	for _, c := range m.checkouts(t) {
		switch {
		case c.Primary || !c.Registered:
		case c.Missing:
			missing = append(missing, c)
		case !samePath(c.Path, t.WorktreePath) && !slices.ContainsFunc(dirs, func(d string) bool { return samePath(d, c.Path) }):
			dirs = append(dirs, c.Path)
		}
	}
	return dirs, missing
}

// requireCheckouts refuses a spawn of t while one of its members' checkouts is missing
// (claude refuses a missing --add-dir, and the thread would silently lose a project). A
// member whose project is no longer registered is skipped (logged): nothing can be
// derived for it.
func (m *Manager) requireCheckouts(t Thread) error {
	for _, c := range m.checkouts(t) {
		if c.Primary {
			continue
		}
		if !c.Registered {
			m.log.Warn("project of a thread is no longer registered; starting without it", "thread", t.ID, "project", c.ProjectID)
			continue
		}
		if c.Missing && !c.FromWorkspace {
			return fmt.Errorf("%w: the checkout of project %s (%s) is missing: %s", ErrFailedPrecondition,
				cmp.Or(c.ProjectName, c.ProjectID), c.ProjectID, cmp.Or(c.Path, "no path"))
		}
	}
	return nil
}

// CheckoutsRef selects a thread for Checkouts: by ID, else the cwd.
type CheckoutsRef struct {
	ID  string
	Cwd string
}

// ThreadCheckouts is Checkouts' answer.
type ThreadCheckouts struct {
	Thread    Thread
	Checkouts []Checkout
	// Workspace is the thread's workspace reference's id and name; empty without one
	// (or when it is gone: the name is then "").
	WorkspaceID, WorkspaceName string
	// Current is the index in Checkouts of the checkout holding the ref's cwd (the
	// deepest), else of the primary; -1 when neither.
	Current int
}

// Checkouts implements Store.
func (m *Manager) Checkouts(_ context.Context, ref CheckoutsRef) (ThreadCheckouts, error) {
	var t Thread
	switch {
	case strings.TrimSpace(ref.ID) != "":
		s, ok := m.Snapshot().Thread(strings.TrimSpace(ref.ID))
		if !ok {
			return ThreadCheckouts{}, m.notFound(ref.ID)
		}
		t = s
	case ref.Cwd != "":
		if !filepath.IsAbs(ref.Cwd) {
			return ThreadCheckouts{}, fmt.Errorf("%w: path %q must be absolute", ErrInvalidArgument, ref.Cwd)
		}
		s, ok := m.threadAt(ref.Cwd)
		if !ok {
			return ThreadCheckouts{}, fmt.Errorf("%w: no thread has a checkout holding %s", ErrNotFound, ref.Cwd)
		}
		t = s
	default:
		return ThreadCheckouts{}, fmt.Errorf("%w: a thread id or a path inside one of its checkouts is required", ErrInvalidArgument)
	}
	out := ThreadCheckouts{Thread: t, Checkouts: m.checkouts(t), WorkspaceID: t.WorkspaceID, Current: -1}
	if t.WorkspaceID != "" && m.opts.Workspaces != nil {
		if w, ok := m.opts.Workspaces.Snapshot().Workspace(t.WorkspaceID); ok {
			out.WorkspaceName = w.Name
		}
	}
	depth := -1
	for i, c := range out.Checkouts {
		if ref.Cwd != "" && c.Path != "" && within(ref.Cwd, c.Path) && len(c.Path) > depth {
			out.Current, depth = i, len(c.Path)
		}
	}
	if out.Current < 0 && ref.Cwd == "" {
		out.Current = slices.IndexFunc(out.Checkouts, func(c Checkout) bool { return c.Primary })
	}
	return out, nil
}

// threadAt is the thread one of whose checkouts holds path, the deepest checkout
// winning; among threads sharing it, its primary's thread, then one that is not
// archived, then the most recently active.
func (m *Manager) threadAt(path string) (Thread, bool) {
	var best Thread
	bestDepth, found := -1, false
	better := func(t Thread, primary bool, bestPrimary bool) bool {
		if primary != bestPrimary {
			return primary
		}
		if t.ArchivedAt.IsZero() != best.ArchivedAt.IsZero() {
			return t.ArchivedAt.IsZero()
		}
		return t.LastActivityAt.After(best.LastActivityAt)
	}
	bestPrimary := false
	for _, t := range m.Snapshot().Threads {
		for _, c := range m.checkouts(t) {
			if c.Path == "" || !within(path, c.Path) {
				continue
			}
			d := len(c.Path)
			if d > bestDepth || (d == bestDepth && better(t, c.Primary, bestPrimary)) {
				best, bestDepth, bestPrimary, found = t, d, c.Primary, true
			}
		}
	}
	return best, found
}

// within reports whether path is root or below it, compared cleaned and with symlinks
// resolved (/tmp is /private/tmp).
func within(path, root string) bool {
	if path == "" || root == "" {
		return false
	}
	for _, p := range []string{filepath.Clean(path), realPath(path)} {
		for _, r := range []string{filepath.Clean(root), realPath(root)} {
			if p == r || strings.HasPrefix(p, strings.TrimSuffix(r, "/")+"/") {
				return true
			}
		}
	}
	return false
}

// CheckoutHints implements Store: for each of t's members whose checkout another thread
// that is not archived also has (the same path), one line: in worktree mode a plain
// folder cannot be isolated ("<name> is a folder, not a repo: thread <other> also works
// there"), and in any mode "<name> @ <branch> is also open in <other>".
func (m *Manager) CheckoutHints(t Thread) []string {
	mine := m.checkouts(t)
	var hints []string
	for _, c := range mine {
		if c.Path == "" || !c.Registered {
			continue
		}
		other, ok := m.otherHolder(t.ID, c.Path)
		if !ok {
			continue
		}
		name := cmp.Or(c.ProjectName, c.ProjectID)
		if !c.Git && t.worktreeMode() {
			hints = append(hints, name+" is a folder, not a repo: thread "+holderLabel(other)+" also works there")
			continue
		}
		at := name
		if c.Branch != "" {
			at += " @ " + c.Branch
		}
		hints = append(hints, at+" is also open in "+holderLabel(other))
	}
	return hints
}

// otherHolder is a thread other than id, not archived, with a checkout at path.
func (m *Manager) otherHolder(id, path string) (Thread, bool) {
	for _, o := range m.Snapshot().Threads {
		if o.ID == id || !o.ArchivedAt.IsZero() || o.Removing {
			continue
		}
		for _, c := range m.checkouts(o) {
			if c.Path != "" && samePath(c.Path, path) {
				return o, true
			}
		}
	}
	return Thread{}, false
}

// holderLabel is "<name> (<id>)", or the id.
func holderLabel(t Thread) string {
	if t.Name != "" {
		return t.Name + " (" + t.ID + ")"
	}
	return t.ID
}
