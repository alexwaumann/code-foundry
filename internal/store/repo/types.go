// Package repo is the repository store: the persisted set of registered git
// repositories, their worktrees, and per-worktree git status.
//
// The store shells out to git through a single Runner. A filesystem watcher (one
// fsnotify watcher for every registered repo) feeds debounced refresh jobs into a
// bounded worker pool. A job owns one slot: a repo reconcile job owns that repo's
// metadata and worktree set, a status job owns one worktree. No two workers run the
// same job at once, so each slot has exactly one writer. Every slot write is followed
// by rebuilding the immutable Snapshot (atomic.Pointer) and publishing ordered Events
// on the bus. See docs/notes/phase1b-repo.md for exactly what triggers a refresh.
package repo

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

// Repo is a registered project: a git repository, or (Git false) a plain directory.
type Repo struct {
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
	RepoID   string
	Path     string
	Branch   string // short name; empty when detached
	Head     string // commit sha; empty on an unborn branch
	IsMain   bool
	Detached bool
	Status   Status
}

// Status is the git status of a worktree.
type Status struct {
	Upstream   string // e.g. "origin/main"; empty when the branch has none
	Ahead      int    // commits on HEAD not on Upstream
	Behind     int    // commits on Upstream not on HEAD
	Staged     int
	Modified   int
	Untracked  int
	Conflicted int
	Dirty      bool
	// BaseRef is the remote-tracking default branch ("origin/main") that BaseAhead and
	// BaseBehind compare HEAD against. Empty when it does not exist.
	BaseRef    string
	BaseAhead  int
	BaseBehind int
	Error      string // last refresh error; other fields are stale when set
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

// Snapshot is an immutable view of every registered repo, sorted by name then path.
// Never mutate a Snapshot or the slices it holds.
type Snapshot struct {
	Repos []Repo
}

// Repo returns the repo with id.
func (s *Snapshot) Repo(id string) (Repo, bool) {
	if s == nil {
		return Repo{}, false
	}
	for _, r := range s.Repos {
		if r.ID == id {
			return r, true
		}
	}
	return Repo{}, false
}

// Worktree returns the worktree at path in repo id.
func (s *Snapshot) Worktree(repoID, path string) (Worktree, bool) {
	r, ok := s.Repo(repoID)
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

// Event is published on the bus as bus.Publish[repo.Event]. Subscribe with
// bus.Subscribe[repo.Event] and type-switch on the concrete types below. All repo
// events share one topic so subscribers see them in publish order.
type Event interface{ isRepoEvent() }

// RepoUpdated carries a repo's full state, including its worktree list. It is sent on
// register and whenever repo metadata or the set of worktrees changes.
type RepoUpdated struct{ Repo Repo }

// RepoRemoved is sent when a repo is unregistered.
type RepoRemoved struct{ ID string }

// WorktreeUpdated is sent when one worktree's branch, head, or status changes.
type WorktreeUpdated struct{ Worktree Worktree }

// WorktreeRemoved is sent when a worktree disappears from its repo.
type WorktreeRemoved struct{ RepoID, Path string }

func (RepoUpdated) isRepoEvent()     {}
func (RepoRemoved) isRepoEvent()     {}
func (WorktreeUpdated) isRepoEvent() {}
func (WorktreeRemoved) isRepoEvent() {}

// CreateWorktreeOptions configures Store.CreateWorktree.
type CreateWorktreeOptions struct {
	RepoID string
	// Branch to check out. If neither a local branch nor origin/<Branch> exists (or
	// BaseRef is set and the local branch does not exist), it is created from BaseRef.
	Branch string
	// BaseRef to branch from. Defaults to origin/<default branch>, else <default branch>.
	BaseRef string
	// Path defaults to <Options.WorktreeRoot>/<owner>/<repo>/<branch, "/" -> "-">, with
	// _local/<repo name> in place of owner/repo when origin is not on GitHub.
	Path string
	// Fetch refreshes the start point before branching from it: when the new branch
	// starts at a remote-tracking ref ("<remote>/<branch>": BaseRef, the default base
	// origin/<default>, or origin/<Branch> for git's DWIM), that one remote branch is
	// fetched first. The fetch is bounded; on failure it is logged and the existing
	// (possibly stale) ref is used. Ignored when Branch already exists locally.
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
	// "<default branch>". It is what CreateWorktree branches from without a BaseRef.
	DefaultRef string
}

// RemoveWorktreeOptions configures Store.RemoveWorktree.
type RemoveWorktreeOptions struct {
	RepoID string
	Path   string
	// DeleteBranch also runs `git branch -D <branch>` after removing the worktree.
	DeleteBranch bool
	// Force passes --force to `git worktree remove` (discarding local changes).
	Force bool
}

// Store is the repository store. The daemon's implementation is *Git; a fake lives in
// repo/repotest.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	// Register adds the repository containing path, or, when path is a directory
	// outside any git repository, that directory as a project without git. It is
	// idempotent: registering a path inside an already registered repo returns that
	// repo.
	Register(ctx context.Context, path string) (Repo, error)
	// Unregister forgets a repo. Nothing on disk is touched.
	Unregister(ctx context.Context, id string) error
	// CreateWorktree, RemoveWorktree, ListRefs and WorktreeDetail fail with
	// ErrFailedPrecondition for a project without git.
	CreateWorktree(ctx context.Context, opts CreateWorktreeOptions) (Worktree, error)
	RemoveWorktree(ctx context.Context, opts RemoveWorktreeOptions) error
	// ListRefs lists the repo's local branches and remote-tracking refs, read from git
	// on each call (not from the snapshot).
	ListRefs(ctx context.Context, repoID string) (Refs, error)
	// Refresh reconciles one repo (or all when id is empty) and waits for its status.
	Refresh(ctx context.Context, id string) error
	// WorktreeDetail returns the files changed and commits on a worktree against its
	// base (detail.go), computing them if needed.
	WorktreeDetail(ctx context.Context, repoID, path string) (WorktreeDetail, error)
	// InitGit makes a project without git a git repository (`git init -b <default>`
	// and an empty "Initial commit") and refreshes it, returning the git project.
	// ErrFailedPrecondition when it already is one.
	InitGit(ctx context.Context, id string) (Repo, error)
}

// ErrNotGit is wrapped (with ErrFailedPrecondition) by operations that need git on a
// project without it.
var ErrNotGit = errors.New("not a git repository")
