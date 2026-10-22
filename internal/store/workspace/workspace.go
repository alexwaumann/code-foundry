// Package workspace is the workspace store. A workspace is a branch set: one branch
// checked out as a worktree in each of several registered projects, for a change
// that spans them. The store persists workspaces in SQLite, publishes an immutable
// Snapshot behind an atomic pointer, and emits Updated/Removed events on the bus.
//
// Worktrees are made and removed through the project store (the same fetch-then-`git
// worktree add` path a new thread's worktree takes) and pre-trusted for Claude like a
// thread's worktree. The store never looks at threads directly: the daemon hands it
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

// Member is one project's worktree in a workspace.
type Member struct {
	ProjectID    string
	WorktreePath string
	// StartPoint is the ref the member's branch was created from
	// (project.Worktree.StartPoint). Set only in the Workspace that Create and
	// AddProject return, never in a snapshot or the database; "" when the branch
	// existed.
	StartPoint string
}

// Member returns the member for projectID.
func (w Workspace) Member(projectID string) (Member, bool) {
	i := slices.IndexFunc(w.Members, func(m Member) bool { return m.ProjectID == projectID })
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

// MemberSpec names a project to add.
type MemberSpec struct {
	// Project is a project id, its name when unique, or a path inside it.
	Project string
	// BaseRef is where the branch starts when it does not exist yet. Empty: the
	// operation's default base, else the project store's default (origin/<default>,
	// or the local default branch with projects.base_from_origin off).
	BaseRef string
}

// CreateOptions configures Store.Create.
type CreateOptions struct {
	Name string
	// Branch for every member. Empty: Options.DefaultBranch's for Name, else
	// cf/<Name as a slug>.
	Branch  string
	Members []MemberSpec
	// BaseRef is the default base for members without their own.
	BaseRef string
	// Fetch refreshes each remote-tracking base first (see project.CreateWorktreeOptions).
	Fetch bool
	// BaseFromOrigin, when set, overrides Options.BaseFromOrigin (projects.base_from_origin)
	// for every member (project.CreateWorktreeOptions.BaseFromOrigin).
	BaseFromOrigin *bool
}

// AddProjectOptions configures Store.AddProject.
type AddProjectOptions struct {
	Ref
	Member MemberSpec
	Fetch  bool
}

// RemoveProjectOptions configures Store.RemoveProject.
type RemoveProjectOptions struct {
	Ref
	// Project is a project id, name, or a path inside it (the member worktree path
	// works too).
	Project string
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

// Membership is a workspace with its members joined to the project store's state.
type Membership struct {
	Workspace Workspace
	Members   []MemberInfo
}

// MemberInfo is a member with what the project store knows about it now.
type MemberInfo struct {
	Member
	ProjectName string // empty when the project is no longer registered
	// Branch checked out in the worktree now; the workspace branch when unknown.
	Branch string
	// Missing: the worktree is not among its project's worktrees.
	Missing bool
	// Current: the Ref's Cwd is inside this worktree.
	Current bool
}

// Thread is a live thread as the removal guard sees it.
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
	// AddProject creates a worktree on the workspace branch in another project.
	AddProject(ctx context.Context, opts AddProjectOptions) (Workspace, error)
	// RemoveProject removes a member's worktree and drops the member. It refuses while a
	// live thread runs in the worktree, and (without Force) when git refuses because
	// of uncommitted changes (the error wraps *project.UncommittedError).
	RemoveProject(ctx context.Context, opts RemoveProjectOptions) (Workspace, error)
	// Remove removes every member worktree and forgets the workspace, with the same
	// guards across all members, checked before anything is removed (uncommitted
	// changes: an error wrapping *project.UncommittedError naming every dirty member).
	Remove(ctx context.Context, opts RemoveOptions) error
	// Members resolves ref and joins its members with the project store's state.
	Members(ctx context.Context, ref Ref) (Membership, error)
}
