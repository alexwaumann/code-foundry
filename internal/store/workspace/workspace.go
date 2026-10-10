// Package workspace is the workspace store. A workspace is a branch set: one branch
// checked out as a worktree in each of several registered repositories, for a change
// that spans them. The store persists workspaces in SQLite, publishes an immutable
// Snapshot behind an atomic pointer, and emits Updated/Removed events on the bus.
//
// Worktrees are made and removed through the repo store (the same fetch-then-`git
// worktree add` path a new thread's worktree takes) and pre-trusted for Claude like a
// session's worktree. The store never looks at sessions directly: the daemon hands it
// a function listing live threads, so a member worktree a thread runs in is not
// removed from under it. See docs/notes/workspaces-1-store.md.
package workspace

import (
	"context"
	"errors"
	"slices"
	"time"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
)

// Workspace is an immutable snapshot of one workspace.
type Workspace struct {
	ID        string // "w-" + 12 hex digits
	Name      string // unique
	Branch    string // every member worktree was created on it
	CreatedAt time.Time
	Members   []Member // in the order they were added
}

// Member is one repository's worktree in a workspace.
type Member struct {
	RepoID       string
	WorktreePath string
}

// Member returns the member for repoID.
func (w Workspace) Member(repoID string) (Member, bool) {
	i := slices.IndexFunc(w.Members, func(m Member) bool { return m.RepoID == repoID })
	if i < 0 {
		return Member{}, false
	}
	return w.Members[i], true
}

// Snapshot is every workspace, sorted by name. Never mutate it.
type Snapshot struct {
	Workspaces []Workspace
}

// Workspace returns the workspace with id.
func (s *Snapshot) Workspace(id string) (Workspace, bool) {
	if s == nil {
		return Workspace{}, false
	}
	i := slices.IndexFunc(s.Workspaces, func(w Workspace) bool { return w.ID == id })
	if i < 0 {
		return Workspace{}, false
	}
	return s.Workspaces[i], true
}

// Event is published on the bus as bus.Publish[workspace.Event]. The store publishes
// Updated and Removed; *Snapshot also implements Event so a consumer can merge a
// resync into the same stream (the API's Watch does on drops).
type Event interface{ isWorkspaceEvent() }

// Updated carries a workspace's full state after a change.
type Updated struct{ Workspace Workspace }

// Removed is sent when a workspace is forgotten.
type Removed struct{ ID string }

func (Updated) isWorkspaceEvent()   {}
func (Removed) isWorkspaceEvent()   {}
func (*Snapshot) isWorkspaceEvent() {}

// Ref selects a workspace: by id or name, else the workspace one of whose member
// worktrees contains Cwd.
type Ref struct {
	Workspace string // id or name
	Cwd       string // absolute path
}

// MemberSpec names a repository to add.
type MemberSpec struct {
	// Repo is a repository id, its name when unique, or a path inside it.
	Repo string
	// BaseRef is where the branch starts when it does not exist yet. Empty: the
	// operation's default base, else the repo store's default (origin/<default>).
	BaseRef string
}

// CreateOptions configures Store.Create.
type CreateOptions struct {
	Name string
	// Branch for every member. Empty: cf/<Name as a slug>.
	Branch  string
	Members []MemberSpec
	// BaseRef is the default base for members without their own.
	BaseRef string
	// Fetch refreshes each remote-tracking base first (see repo.CreateWorktreeOptions).
	Fetch bool
}

// AddRepoOptions configures Store.AddRepo.
type AddRepoOptions struct {
	Ref
	Member MemberSpec
	Fetch  bool
}

// RemoveRepoOptions configures Store.RemoveRepo.
type RemoveRepoOptions struct {
	Ref
	// Repo is a repository id, name, or a path inside it (the member worktree path
	// works too).
	Repo string
	// Force removes the worktree even with uncommitted changes.
	Force bool
	// DeleteBranch also deletes the member's branch.
	DeleteBranch bool
}

// RemoveOptions configures Store.Remove.
type RemoveOptions struct {
	Workspace    string // id or name
	Force        bool
	DeleteBranch bool
}

// Membership is a workspace with its members joined to the repo store's state.
type Membership struct {
	Workspace Workspace
	Members   []MemberInfo
}

// MemberInfo is a member with what the repo store knows about it now.
type MemberInfo struct {
	Member
	RepoName string // empty when the repo is no longer registered
	// Branch checked out in the worktree now; the workspace branch when unknown.
	Branch string
	// Missing: the worktree is not among its repository's worktrees.
	Missing bool
	// Current: the Ref's Cwd is inside this worktree.
	Current bool
}

// Thread is a live session as the removal guard sees it.
type Thread struct {
	ID, Name string
	Cwd      string // the worktree it runs in
}

// Store is the workspace store API. *Manager implements it; workspacetest.Fake is an
// in-memory fake.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	// Create makes a workspace and a worktree on its branch in every member
	// repository. On failure, worktrees it made are removed again.
	Create(ctx context.Context, opts CreateOptions) (Workspace, error)
	// AddRepo creates a worktree on the workspace branch in another repository.
	AddRepo(ctx context.Context, opts AddRepoOptions) (Workspace, error)
	// RemoveRepo removes a member's worktree and drops the member. It refuses while a
	// live thread runs in the worktree, and (without Force) when git refuses because
	// of uncommitted changes.
	RemoveRepo(ctx context.Context, opts RemoveRepoOptions) (Workspace, error)
	// Remove removes every member worktree and forgets the workspace, with the same
	// guards across all members, checked before anything is removed.
	Remove(ctx context.Context, opts RemoveOptions) error
	// Members resolves ref and joins its members with the repo store's state.
	Members(ctx context.Context, ref Ref) (Membership, error)
}
