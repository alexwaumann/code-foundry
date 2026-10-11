package session

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Workspace threads (docs/notes/workspaces-2-launch.md).
//
// A thread's owner is one field: Session.WorkspaceID when set, else the project
// RepoID. The cwd (RepoID, WorktreePath) is a separate fact: the member worktree the
// thread runs in. The session store reads workspaces from the workspace store (never
// the other way round: the workspace store learns about live threads from a function
// the daemon hands it).

// AdditionalDirsClaudeMDEnv makes claude load CLAUDE.md and .claude/rules from
// --add-dir directories too (without it, added directories give file access and
// skills/commands/agents only). Set for every workspace thread.
const AdditionalDirsClaudeMDEnv = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1"

// workspacePrompt is the one line a workspace thread's system prompt gets. It must stay
// small and static: claude records the system prompt on the first request and reuses
// it until compaction, so the member list itself is looked up with the CLI instead.
func workspacePrompt(name string) string {
	return "This thread belongs to workspace " + name + ". Run `code-foundry workspace members` for the current worktrees."
}

// wsLaunch is what a workspace thread's spawn adds to claude's.
type wsLaunch struct {
	addDirs []string // the other members' worktrees, in member order
	missing []string // other members' worktrees that do not exist (claude refuses them)
	env     []string
	prompt  string
}

// workspaceLaunch reads workspace id's current members from snap for a thread running
// in cwd: --add-dir for every other member whose worktree exists, the CLAUDE.md env,
// and the prompt line. ok is false when the workspace is gone.
func workspaceLaunch(snap *workspace.Snapshot, id, cwd string, exists func(string) bool) (l wsLaunch, ok bool) {
	w, ok := snap.Workspace(id)
	if !ok {
		return l, false
	}
	for _, mem := range w.Members {
		switch {
		case samePath(mem.WorktreePath, cwd):
		case exists(mem.WorktreePath):
			l.addDirs = append(l.addDirs, mem.WorktreePath)
		default:
			l.missing = append(l.missing, mem.WorktreePath)
		}
	}
	l.env = []string{AdditionalDirsClaudeMDEnv}
	l.prompt = workspacePrompt(w.Name)
	return l, true
}

// isDir reports whether path is an existing directory.
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// WorkspaceSource is the part of the workspace store sessions need: the current
// members at every spawn, and making a workspace for a new workspace thread.
// *workspace.Manager implements it.
type WorkspaceSource interface {
	Snapshot() *workspace.Snapshot
	Create(ctx context.Context, opts workspace.CreateOptions) (workspace.Workspace, error)
}

// NewWorkspace configures the workspace Create makes for a new workspace thread.
type NewWorkspace struct {
	// Repos are repository refs (id, name when unique, or an absolute path inside
	// one), in member order, each optionally followed by ":<base ref>" for that member
	// (as `workspace new --repos`). CreateOptions.RepoID picks the member the thread
	// runs in (default: the first).
	Repos []string
	// BaseRef every member without its own base branches from. Empty: each
	// repository's default.
	BaseRef string
	// Name of the workspace. Empty: the branch slug (cf/<slug> without "cf/").
	Name string
}

// createdWorkspace is what newWorkspace made.
type createdWorkspace struct {
	workspaceID, repoID, path, baseRef string
	// members of the new workspace, in member order.
	members []workspace.Member
	// name, namerCalled, late: as createdWorktree.
	name        string
	namerCalled bool
	late        <-chan namingResult
}

// workspaceMember resolves the member a thread of workspace ref (id or name) runs in;
// see pickMember. repoID may also be a repository name.
func (m *Manager) workspaceMember(ref, repoID, path string) (workspace.Workspace, workspace.Member, error) {
	if m.opts.Workspaces == nil {
		return workspace.Workspace{}, workspace.Member{}, fmt.Errorf("%w: workspace threads need the workspace store", ErrFailedPrecondition)
	}
	if path != "" && !filepath.IsAbs(path) {
		return workspace.Workspace{}, workspace.Member{}, fmt.Errorf("%w: worktree path %q must be absolute", ErrInvalidArgument, path)
	}
	w, err := workspace.ResolveWorkspace(m.opts.Workspaces.Snapshot(), workspace.Ref{Workspace: ref})
	if err != nil {
		return workspace.Workspace{}, workspace.Member{}, workspaceError("workspace", err)
	}
	if _, ok := w.Member(repoID); repoID != "" && !ok && m.opts.Repos != nil {
		// A repository name (or path) instead of the id.
		if r, err := workspace.ResolveRepo(m.opts.Repos.Snapshot(), repoID); err == nil {
			repoID = r.ID
		}
	}
	mem, err := pickMember(w, repoID, path)
	return w, mem, err
}

// pickMember chooses the member of w a thread runs in: the one whose worktree is path,
// else the one for repoID, else the first. When both are given they must name the same
// member. A path inside a member worktree but not the worktree itself is not a member.
func pickMember(w workspace.Workspace, repoID, path string) (workspace.Member, error) {
	if len(w.Members) == 0 {
		return workspace.Member{}, fmt.Errorf("%w: workspace %s has no members", ErrFailedPrecondition, w.Name)
	}
	if path != "" {
		i := slices.IndexFunc(w.Members, func(mem workspace.Member) bool { return samePath(mem.WorktreePath, path) })
		if i < 0 {
			return workspace.Member{}, fmt.Errorf("%w: %s is not a member worktree of workspace %s (members: %s)",
				ErrFailedPrecondition, path, w.Name, memberPaths(w))
		}
		if repoID != "" && w.Members[i].RepoID != repoID {
			return workspace.Member{}, fmt.Errorf("%w: worktree %s belongs to repo %s, not %s", ErrInvalidArgument, path, w.Members[i].RepoID, repoID)
		}
		return w.Members[i], nil
	}
	if repoID != "" {
		mem, ok := w.Member(repoID)
		if !ok {
			return workspace.Member{}, fmt.Errorf("%w: repo %s is not a member of workspace %s (members: %s)",
				ErrFailedPrecondition, repoID, w.Name, memberPaths(w))
		}
		return mem, nil
	}
	return w.Members[0], nil
}

// samePath compares two absolute paths cleaned and with symlinks resolved.
func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b) || realPath(a) == realPath(b)
}

func memberPaths(w workspace.Workspace) string {
	out := make([]string, len(w.Members))
	for i, mem := range w.Members {
		out[i] = mem.RepoID + " " + mem.WorktreePath
	}
	return strings.Join(out, ", ")
}

// newWorkspace makes the workspace of a new workspace thread: after the single slug
// wait (as for a new worktree), a worktree on cf/<slug> in every repository through
// the workspace store, which creates all or none.
func (m *Manager) newWorkspace(ctx context.Context, id, name string, o CreateOptions) (createdWorkspace, error) {
	var cw createdWorkspace
	nw := o.NewWorkspace
	switch {
	case m.opts.Workspaces == nil:
		return cw, fmt.Errorf("%w: creating a workspace needs the workspace store", ErrFailedPrecondition)
	case m.opts.Repos == nil:
		return cw, fmt.Errorf("%w: creating a workspace needs the repo store", ErrFailedPrecondition)
	case len(nw.Repos) == 0:
		return cw, fmt.Errorf("%w: a new workspace needs at least one repository", ErrInvalidArgument)
	}
	base := strings.TrimSpace(nw.BaseRef)
	if err := validateRef(base); err != nil {
		return cw, err
	}
	// Resolve every repository before waiting for a name, so a typo fails fast.
	snap := m.opts.Repos.Snapshot()
	var ids, paths, bases []string
	for _, item := range nw.Repos {
		ref, own, _ := strings.Cut(item, ":")
		ref, own = strings.TrimSpace(ref), strings.TrimSpace(own)
		if err := validateRef(own); err != nil {
			return cw, err
		}
		r, err := workspace.ResolveRepo(snap, ref)
		if err != nil {
			return cw, workspaceError("repository", err)
		}
		if err := workspace.RequireGit(r); err != nil {
			return cw, workspaceError("repository", err)
		}
		if slices.Contains(ids, r.ID) {
			return cw, fmt.Errorf("%w: repository %s is listed twice", ErrInvalidArgument, r.Name)
		}
		ids, paths, bases = append(ids, r.ID), append(paths, r.Path), append(bases, own)
	}
	cwdRepo := ids[0]
	if o.RepoID != "" {
		// An id, or a name or path like the repository refs.
		cwdRepo = o.RepoID
		if r, err := workspace.ResolveRepo(snap, o.RepoID); err == nil {
			cwdRepo = r.ID
		}
	}
	if !slices.Contains(ids, cwdRepo) {
		return cw, fmt.Errorf("%w: repo %s is not among the new workspace's repositories", ErrInvalidArgument, cwdRepo)
	}
	wsName := strings.TrimSpace(nw.Name)

	sl, err := m.waitSlug(ctx, id, name, o.InitialPrompt)
	if err != nil {
		return cw, err
	}
	cw.name, cw.namerCalled, cw.late = sl.name, sl.namerCalled, sl.late
	var nameTaken func(string) bool
	if wsName == "" {
		// The workspace is named after its branch, so a suffix that frees the branch
		// must also free the name.
		existing := m.opts.Workspaces.Snapshot()
		nameTaken = func(n string) bool {
			_, err := workspace.ResolveWorkspace(existing, workspace.Ref{Workspace: n})
			return err == nil
		}
	}
	branch := m.pickBranch(ctx, paths, sl.slug, id, nameTaken)
	if wsName == "" {
		wsName = strings.TrimPrefix(branch, branchPrefix)
	}
	specs := make([]workspace.MemberSpec, len(ids))
	cwdBase := base
	for i, rid := range ids {
		specs[i] = workspace.MemberSpec{Repo: rid, BaseRef: bases[i]}
		if rid == cwdRepo && bases[i] != "" {
			cwdBase = bases[i]
		}
	}
	w, err := m.opts.Workspaces.Create(ctx, workspace.CreateOptions{
		Name: wsName, Branch: branch, Members: specs, BaseRef: base, Fetch: true,
	})
	if err != nil {
		return cw, workspaceError("create workspace "+wsName, err)
	}
	mem, ok := w.Member(cwdRepo)
	if !ok { // the store made every member or failed; this is a broken fake
		return cw, fmt.Errorf("%w: workspace %s has no member for repo %s", ErrFailedPrecondition, w.ID, cwdRepo)
	}
	cw.workspaceID, cw.repoID, cw.path, cw.members = w.ID, mem.RepoID, mem.WorktreePath, w.Members
	cw.baseRef = cwdBase
	if cw.baseRef == "" {
		if r, ok := m.opts.Repos.Snapshot().Repo(cwdRepo); ok {
			cw.baseRef = r.DefaultBranch
			if wt, ok := m.opts.Repos.Snapshot().Worktree(cwdRepo, mem.WorktreePath); ok {
				cw.baseRef = cmp.Or(wt.Status.BaseRef, cw.baseRef)
			}
		}
	}
	m.log.Info("workspace created for session", "session", id, "workspace", w.ID, "name", w.Name,
		"branch", branch, "members", len(w.Members), "cwd", mem.WorktreePath)
	return cw, nil
}

// workspaceError wraps a workspace store error in the session error class with the
// same meaning, so API codes survive.
func workspaceError(what string, err error) error {
	var kind error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: %w", what, err)
	case errors.Is(err, workspace.ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, workspace.ErrInvalidArgument):
		kind = ErrInvalidArgument
	default:
		kind = ErrFailedPrecondition
	}
	return classified{kind: kind, err: fmt.Errorf("%s: %w", what, err)}
}
