// Package workspace is the workspace store. A workspace is a saved set of projects (its
// members, project ids) plus a place for the instructions and skills that span them: its
// managed dir, <config home>/workspaces/<id>/. A synthetic workspace's managed dir holds
// the files themselves (a thread writes CLAUDE.md, AGENTS.md and .claude/skills there);
// a rooted one came from a real folder (root_path) and its managed dir holds symlinks
// CLAUDE.md, AGENTS.md and .claude to the same names under the root. A workspace has no
// branch and no worktrees: those are a thread's (its project set and branch; the thread
// store's derived checkouts).
//
// The store persists workspaces in SQLite, publishes an immutable Snapshot behind an
// atomic pointer and emits Updated/Removed events on the bus. It never looks at threads.
// See docs/notes/workspaces-v2-handoff.md and docs/notes/workspaces-v2-2-workspaces.md.
package workspace

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
)

// PrimaryWorkspace is the DefaultPrimary (and a thread's primary choice) that runs a
// thread in the workspace itself: its root when it has one, else its managed dir.
const PrimaryWorkspace = "workspace"

// Workspace is an immutable snapshot of one workspace.
type Workspace struct {
	ID   string // "w-" + 12 hex digits
	Name string // unique, case-insensitively
	// RootPath is the real folder a rooted workspace came from; "" for a synthetic one.
	RootPath string
	// Members are project ids, sorted. Copy on write.
	Members []string
	// DefaultPrimary is where new threads start: a member, or PrimaryWorkspace.
	DefaultPrimary string
	// ManagedDir is <Options.Dir>/<ID>.
	ManagedDir string
	CreatedAt  time.Time
	// Instructions and Skills are what the managed dir holds (contents.go), read from
	// disk, never persisted: refreshed when the workspace is saved and at every
	// EnsureDirs. Skills is copy on write.
	Instructions string
	Skills       []string
}

// Member reports whether projectID is a member.
func (w Workspace) Member(projectID string) bool { return slices.Contains(w.Members, projectID) }

// Dir is where a thread whose primary is the workspace runs: RootPath when set, else
// ManagedDir.
func (w Workspace) Dir() string {
	if w.RootPath != "" {
		return w.RootPath
	}
	return w.ManagedDir
}

// Synthetic: no root; the managed dir holds the instructions and skills themselves.
func (w Workspace) Synthetic() bool { return w.RootPath == "" }

// Snapshot is every workspace, sorted by name (case-insensitively), then id. Never
// mutate it.
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

// Named returns the workspace named name, compared case-insensitively.
func (s *Snapshot) Named(name string) (Workspace, bool) {
	if s == nil {
		return Workspace{}, false
	}
	i := slices.IndexFunc(s.Workspaces, func(w Workspace) bool { return strings.EqualFold(w.Name, strings.TrimSpace(name)) })
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

// CreateOptions configures Store.Create.
type CreateOptions struct {
	Name string
	// Members are project refs: an id, a name when unique, or an absolute path inside
	// one. At least one unless RootPath is set.
	Members []string
	// RootPath is an absolute folder (under Options.Home when that is set); "" for a
	// synthetic workspace.
	RootPath string
	// DefaultPrimary is a member ref or PrimaryWorkspace. "": PrimaryWorkspace for a
	// rooted workspace, else the first member given.
	DefaultPrimary string
}

// Store is the workspace store API. *Manager implements it; workspacetest.Fake is an
// in-memory fake.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	// Create saves a workspace and makes its managed dir (EnsureDirs).
	Create(ctx context.Context, opts CreateOptions) (Workspace, error)
	// AddProject adds a member (ref as CreateOptions.Members).
	AddProject(ctx context.Context, workspace, project string) (Workspace, error)
	// RemoveProject drops a member; nothing on disk changes. A default primary that was
	// the member becomes PrimaryWorkspace.
	RemoveProject(ctx context.Context, workspace, project string) (Workspace, error)
	// Rename renames a workspace; the name must be free (case-insensitively).
	Rename(ctx context.Context, workspace, name string) (Workspace, error)
	// SetDefaultPrimary sets a member (ref) or PrimaryWorkspace as the default primary.
	SetDefaultPrimary(ctx context.Context, workspace, primary string) (Workspace, error)
	// Remove forgets a workspace: a synthetic one's managed dir goes with it, a rooted
	// one's symlinks only.
	Remove(ctx context.Context, workspace string) error
	// EnsureDirs makes the managed dir of workspace id (every workspace when id is "")
	// and, for a rooted one, re-checks its symlinks: missing ones added, dangling ones
	// removed. The thread store calls it at every spawn of a thread that references the
	// workspace; the daemon at start and when such a thread ends a turn. It also reads
	// the managed dir's instructions file and skills again and publishes Updated when
	// they changed.
	EnsureDirs(ctx context.Context, id string) error
}
