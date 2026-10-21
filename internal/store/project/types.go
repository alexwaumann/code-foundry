// Package project is the project store: the persisted set of registered git
// repositories, their worktrees, and per-worktree git status.
//
// The store shells out to git through a single Runner. One FSEvents stream (for every
// registered project and worktree) feeds debounced refresh jobs into a bounded worker
// pool. A job owns one slot: a project reconcile job owns that project's metadata and
// worktree set, a status job owns one worktree. No two workers run the same job at
// once, so each slot has exactly one writer. Every slot write is followed by
// rebuilding the immutable Snapshot (atomic.Pointer) and publishing ordered Events on
// the bus. See docs/notes/fsevents-watcher.md for exactly what triggers a refresh.
package project

import (
	"context"
	"errors"
	"time"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
)

// Project is a registered project: a git repository, or (Git false) a plain directory.
type Project struct {
	ID            string
	Path          string // main worktree path, symlinks resolved
	Name          string
	RegisteredAt  time.Time
	DefaultBranch string
	GitHubSlug    string // "owner/name" when origin is on GitHub
	// Remotes are the configured git remote names, sorted; empty for a local-only
	// repository (and until the first reconcile).
	Remotes []string
	// Git is false for a project that is not a git repository (no .git at Path). Such
	// a project has exactly one synthetic main Worktree at Path with empty Branch and
	// Head and a zero Status, no remotes and no DefaultBranch. No git command runs for
	// it; it becomes a git project when .git appears (InitGit, or `git init` outside
	// the app, seen on the next refresh or poll).
	Git       bool
	Error     string // last reconcile error, if any
	Worktrees []Worktree
}

// Worktree is one checkout of a repository. The main worktree comes first.
type Worktree struct {
	ProjectID string
	Path      string
	Branch    string // short name; empty when detached
	Head      string // commit sha; empty on an unborn branch
	IsMain    bool
	Detached  bool
	Status    Status
	// Managed: the app made this worktree (CreateWorktree recorded it; made.go), and
	// only managed worktrees can be cleaned up. Being under Options.WorktreeRoot is not
	// enough: an agent's own `git worktree add` there is not managed. Set when the
	// snapshot is built.
	Managed bool
	// CreatedAt and CreatedHead are when the app made the worktree and its HEAD right
	// after (managed worktrees only; CreatedHead is "" for one made before the app
	// recorded heads). Cleanup keeps a worktree made moments ago with no commits yet.
	CreatedAt   time.Time
	CreatedHead string
	// StartPoint is the ref CreateWorktree created the branch from, after
	// CreateWorktreeOptions.BaseFromOrigin ("origin/main" for a base typed as "main").
	// Set only on CreateWorktree's return value, never in a snapshot; "" when it
	// checked out an existing branch.
	StartPoint string
}

// Status is the git status of a worktree.
type Status struct {
	Upstream string // e.g. "origin/main"; empty when the branch has none
	Ahead    int    // commits on HEAD not on Upstream
	Behind   int    // commits on Upstream not on HEAD
	Staged   int
	Modified int
	// Untracked counts untracked, non-ignored files; an untracked directory counts
	// each file in it (git status --untracked-files=all).
	Untracked  int
	Conflicted int
	Dirty      bool
	// BaseRef is the remote-tracking default branch ("origin/main") that BaseAhead and
	// BaseBehind compare HEAD against. Empty when it does not exist.
	BaseRef    string
	BaseAhead  int
	BaseBehind int
	// BaseMerged: HEAD has commits not in BaseRef, yet merging HEAD into BaseRef would
	// change nothing, so its changes landed another way (a rebased or squash-merged
	// copy). Checked only when HEAD is both ahead of and behind BaseRef (base.go).
	BaseMerged bool
	// Operation is the git operation in progress (OpRebase, OpAm, OpMerge,
	// OpCherryPick, OpRevert, OpBisect) or "", read from marker files in the
	// worktree's admin dir (operation.go). OperationStep and OperationTotal are a
	// rebase's (or am's) current and last patch, 1-based; 0 when not recorded.
	Operation      string
	OperationStep  int
	OperationTotal int
	Error          string // last refresh error; other fields are stale when set
	// RefreshedAt is zero until the first refresh. After that, in a Snapshot it is the
	// last refresh that changed something (refreshes that change nothing do not
	// rebuild the snapshot), so it is not a "last checked" time.
	RefreshedAt time.Time
}

// equalIgnoringTime reports whether two statuses differ only in RefreshedAt.
func (s Status) equalIgnoringTime(o Status) bool {
	s.RefreshedAt, o.RefreshedAt = time.Time{}, time.Time{}
	return s == o
}

// Snapshot is an immutable view of every registered project, sorted by name then path.
// Never mutate a Snapshot or the slices it holds.
type Snapshot struct {
	Projects []Project
}

// Project returns the project with id.
func (s *Snapshot) Project(id string) (Project, bool) {
	if s == nil {
		return Project{}, false
	}
	for _, r := range s.Projects {
		if r.ID == id {
			return r, true
		}
	}
	return Project{}, false
}

// Worktree returns the worktree at path in project id.
func (s *Snapshot) Worktree(projectID, path string) (Worktree, bool) {
	r, ok := s.Project(projectID)
	if !ok {
		return Worktree{}, false
	}
	for _, w := range r.Worktrees {
		if w.Path == path {
			return w, true
		}
	}
	return Worktree{}, false
}

// Owner returns the project with a worktree at worktreePath, else the project with id
// projectID. It is how commands find the project a UI context points at.
func (s *Snapshot) Owner(projectID, worktreePath string) (Project, bool) {
	if s == nil {
		return Project{}, false
	}
	if worktreePath != "" {
		for _, r := range s.Projects {
			for _, w := range r.Worktrees {
				if w.Path == worktreePath {
					return r, true
				}
			}
		}
	}
	if projectID == "" {
		return Project{}, false
	}
	return s.Project(projectID)
}

// Event is published on the bus as bus.Publish[project.Event]. Subscribe with
// bus.Subscribe[project.Event] and type-switch on the concrete types below. All project
// events share one topic so subscribers see them in publish order.
type Event interface{ isProjectEvent() }

// ProjectUpdated carries a project's full state, including its worktree list. It is sent on
// register and whenever project metadata or the set of worktrees changes.
type ProjectUpdated struct{ Project Project }

// ProjectRemoved is sent when a project is unregistered.
type ProjectRemoved struct{ ID string }

// WorktreeUpdated is sent when one worktree's branch, head, or status changes.
type WorktreeUpdated struct{ Worktree Worktree }

// WorktreeRemoved is sent when a worktree disappears from its project.
type WorktreeRemoved struct{ ProjectID, Path string }

func (ProjectUpdated) isProjectEvent()  {}
func (ProjectRemoved) isProjectEvent()  {}
func (WorktreeUpdated) isProjectEvent() {}
func (WorktreeRemoved) isProjectEvent() {}

// CreateWorktreeOptions configures Store.CreateWorktree. The path is always the app's:
// <Options.WorktreeRoot>/<owner>/<repo>/<branch, "/" -> "-">, with _local/<repo name>
// in place of owner/repo when origin is not on GitHub.
type CreateWorktreeOptions struct {
	ProjectID string
	// Branch to check out. If neither a local branch nor origin/<Branch> exists (or
	// BaseRef is set and the local branch does not exist), it is created from BaseRef.
	Branch string
	// BaseRef to branch from. Empty is the default branch; BaseFromOrigin says which
	// copy of it, and of a base typed as a bare branch name.
	BaseRef string
	// BaseFromOrigin is projects.base_from_origin (startpoint.go). On: no BaseRef, or a
	// bare branch name ("main", "release/2.3"), starts from origin's copy of that branch
	// when origin has it (fetched first with Fetch), else from the local branch. A
	// remote-tracking ref ("origin/x", "upstream/x"), a tag, a sha or an expression
	// ("HEAD~2") is used as typed. Off: no BaseRef is the local default branch, a
	// BaseRef is used as typed, and the base is never fetched.
	BaseFromOrigin bool
	// Fetch refreshes the start point before branching from it: when the new branch
	// starts at a remote branch (origin's copy of a bare name with BaseFromOrigin, a
	// remote-tracking BaseRef with it, or origin/<Branch> for git's DWIM), that one
	// remote branch is fetched first. The fetch is bounded; on failure it is logged and
	// the existing (possibly stale) ref is used. Ignored when Branch already exists
	// locally.
	Fetch bool
}

// Refs lists the refs a new branch can start from (Store.ListRefs).
type Refs struct {
	// Local holds local branch names, sorted.
	Local []string
	// Remote holds remote-tracking refs as "<remote>/<branch>", sorted, without the
	// symbolic "<remote>/HEAD".
	Remote []string
	// DefaultRef is "origin/<default branch>" when that ref exists, else
	// "<default branch>": what CreateWorktree branches from without a BaseRef when
	// BaseFromOrigin is on (Default gives either).
	DefaultRef string
	// DefaultBranch is the local default branch ("main").
	DefaultBranch string
}

// Default is the ref CreateWorktree branches from without a BaseRef: DefaultRef with
// fromOrigin (CreateWorktreeOptions.BaseFromOrigin), else the local default branch.
func (r Refs) Default(fromOrigin bool) string {
	if fromOrigin || r.DefaultBranch == "" {
		return r.DefaultRef
	}
	return r.DefaultBranch
}

// RemoveWorktreeOptions configures Store.RemoveWorktree.
type RemoveWorktreeOptions struct {
	ProjectID string
	Path      string
	// DeleteBranch also deletes the worktree's branch after removing it: only when it
	// is merged into the default branch (as DeleteBranch decides) unless Force. A
	// branch kept is an ErrFailedPrecondition returned after the worktree is gone.
	DeleteBranch bool
	// Force passes --force to `git worktree remove` (discarding local changes) and
	// deletes the branch (DeleteBranch) whatever it holds. Without it, a worktree git
	// refuses for its uncommitted changes fails with *UncommittedError (its status
	// read again). It also overrides Hold.
	Force bool
	// Hold returns why something outside git keeps w (CleanupOptions.Hold), or "";
	// without Force a held worktree is refused before git runs (fuzz finding git 6).
	// Nil: nothing holds it.
	Hold func(w Worktree) string
}

// Store is the project store. The daemon's implementation is *Git; a fake lives in
// project/projecttest.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	// Register adds the repository containing path, or, when path is a directory
	// outside any git repository, that directory as a project without git. It is
	// idempotent: registering a path inside an already registered project returns that
	// project.
	Register(ctx context.Context, path string) (Project, error)
	// Unregister forgets a project. Nothing on disk is touched.
	Unregister(ctx context.Context, id string) error
	// CreateWorktree, RemoveWorktree, ListRefs and WorktreeDetail fail with
	// ErrFailedPrecondition for a project without git.
	CreateWorktree(ctx context.Context, opts CreateWorktreeOptions) (Worktree, error)
	RemoveWorktree(ctx context.Context, opts RemoveWorktreeOptions) error
	// DeleteBranch deletes a branch no worktree has checked out (branch_delete.go).
	DeleteBranch(ctx context.Context, opts DeleteBranchOptions) (DeleteBranchResult, error)
	// ListRefs lists the project's local branches and remote-tracking refs, read from git
	// on each call (not from the snapshot).
	ListRefs(ctx context.Context, projectID string) (Refs, error)
	// Refresh reconciles one project (or all when id is empty) and waits for its status.
	Refresh(ctx context.Context, id string) error
	// WorktreeDetail returns the files changed and commits on a worktree against its
	// base (detail.go), computing them if needed.
	WorktreeDetail(ctx context.Context, projectID, path string) (WorktreeDetail, error)
	// WorktreeFileDiff returns both sides of one file of a worktree against the
	// detail's base (filediff.go), read now. ErrInvalidArgument for a file path that
	// leaves the worktree, ErrFailedPrecondition for a project without git.
	WorktreeFileDiff(ctx context.Context, req FileDiffRequest) (WorktreeFileDiff, error)
	// InitGit makes a project without git a git repository (`git init -b <default>`
	// and an empty "chore: initial commit") and refreshes it, returning the git project.
	// ErrFailedPrecondition when it already is one.
	InitGit(ctx context.Context, id string) (Project, error)
	// SetLiveWorktrees replaces the set of worktree paths that have a live thread (not
	// archived, not snoozed). A project with one of them is polled and fetched on the
	// live tier (activity.go); one that turns live is fetched now if its last fetch is
	// older than the live interval. Paths are symlink-resolved; unknown ones are kept
	// and match once the worktree appears.
	SetLiveWorktrees(paths []string)
	// Touch asks for a status refresh of the worktree at path after a short trailing
	// debounce (a thread's tool edited files there). Unknown paths are ignored.
	Touch(path string)
	// TouchNow asks for a status refresh of the worktree at path at once (a thread's
	// turn ended there), replacing a pending Touch. Unknown paths are ignored.
	TouchNow(path string)
}

// ErrNotGit is wrapped (with ErrFailedPrecondition) by operations that need git on a
// project without it.
var ErrNotGit = errors.New("not a git repository")
