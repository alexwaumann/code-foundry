// Package session is the Claude session store. A session is Claude Code running in a
// worktree, layered on the terminal store: a connected session owns exactly one
// terminal, a disconnected one owns none and can be reconnected with
// `claude --resume`.
//
// The Manager persists sessions in SQLite (they survive daemon restarts as
// DISCONNECTED), publishes an immutable Snapshot behind an atomic pointer, and emits
// Updated/Removed events on the bus. Each connected session has one runner goroutine
// that consumes the terminal's Observer feed, tails the Claude transcript, drives the
// StatusDetector, accepts the folder-trust dialog if it appears, and runs the graceful
// close sequence. See docs/notes/phase2a-session.md.
package session

import (
	"context"
	"errors"
	"slices"
	"time"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("session not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
	ErrClosed             = errors.New("session store closed")
)

// State is the lifecycle of the Claude process behind a session. Values mirror
// codefoundry.v1.SessionState.
type State int

// States.
const (
	StateUnspecified State = iota
	// StateStarting: process spawned, Claude's UI not yet confirmed.
	StateStarting
	// StateConnected: Claude is running and the session owns a terminal.
	StateConnected
	// StateClosing: close requested, waiting for the process to exit.
	StateClosing
	// StateDisconnected: no process.
	StateDisconnected
)

func (s State) String() string {
	switch s {
	case StateStarting:
		return "starting"
	case StateConnected:
		return "connected"
	case StateClosing:
		return "closing"
	case StateDisconnected:
		return "disconnected"
	default:
		return "unspecified"
	}
}

// PermissionMode is the claude --permission-mode a session runs with. Values mirror
// codefoundry.v1.PermissionMode. Full access (bypassPermissions) is deliberately not
// representable.
type PermissionMode int

// Permission modes.
const (
	// PermissionDefault passes no flag: Claude's own default (manual).
	PermissionDefault PermissionMode = iota
	// PermissionSupervised: --permission-mode manual, every tool call is confirmed.
	PermissionSupervised
	// PermissionAcceptEdits: --permission-mode acceptEdits.
	PermissionAcceptEdits
	// PermissionAuto: --permission-mode auto, Claude's auto-mode classifier decides.
	PermissionAuto
)

// Flag is the --permission-mode value, or "" for PermissionDefault.
func (p PermissionMode) Flag() string {
	switch p {
	case PermissionSupervised:
		return "manual"
	case PermissionAcceptEdits:
		return "acceptEdits"
	case PermissionAuto:
		return "auto"
	default:
		return ""
	}
}

func (p PermissionMode) valid() bool { return p >= PermissionDefault && p <= PermissionAuto }

// Disconnect reasons recorded in Session.DisconnectReason.
const (
	ReasonClosed         = "closed"           // closed through Close/Remove
	ReasonExited         = "exited"           // process exited 0 without a close request (/exit)
	ReasonCrashed        = "crashed"          // process exited non-zero without a close request
	ReasonDaemonStopped  = "daemon stopped"   // daemon shut down while connected
	ReasonDaemonRestarts = "daemon restarted" // row was live when the daemon last died
	ReasonSpawnFailed    = "spawn failed"     // the terminal could not be created
)

// Session is an immutable snapshot of one session. Field meanings follow
// codefoundry.v1.Session.
//
// Owner: WorkspaceID when set, else the project RepoID. RepoID and WorktreePath are
// the cwd (for a workspace thread, the member worktree it runs in), never the owner.
type Session struct {
	ID              string
	ClaudeSessionID string // set once the transcript file is discovered
	RepoID          string // repository of the cwd; the owner when WorkspaceID is empty
	WorktreePath    string // the cwd
	Name            string
	AutoNamed       bool
	Model           string
	Effort          string
	TerminalID      string // empty when disconnected
	State           State
	Status          Status
	StatusReason    string
	CreatedAt       time.Time
	LastActivityAt  time.Time
	ExitCode        int
	// DisconnectReason is one of the Reason* constants, or empty.
	DisconnectReason string
	LastError        string
	ParentID         string
	// PermissionMode is passed to claude on every spawn (Create, Reconnect, Fork).
	PermissionMode PermissionMode
	// BaseRef is the ref the worktree's branch was created from, when Create made the
	// worktree (CreatedWorktree).
	BaseRef         string
	CreatedWorktree bool
	// WorkspaceID is the owner workspace; empty for a project thread. Each spawn reads
	// the workspace's current members from the workspace store.
	WorkspaceID string
	// PendingWorktreePath is the member a queued RunIn moves the thread to once it is
	// idle at its prompt; empty when nothing is queued. Not persisted.
	PendingWorktreePath string
	// Pinned is the user's pin (Store.Pin). Persisted.
	Pinned bool
}

// Snapshot is every session, sorted by creation time then id. Never mutate it.
type Snapshot struct {
	Sessions []Session
}

// Session returns the session with id.
func (s *Snapshot) Session(id string) (Session, bool) {
	if s == nil {
		return Session{}, false
	}
	i := slices.IndexFunc(s.Sessions, func(x Session) bool { return x.ID == id })
	if i < 0 {
		return Session{}, false
	}
	return s.Sessions[i], true
}

// Event is published on the bus as bus.Publish[session.Event]. Subscribe with
// bus.Subscribe[session.Event] and type-switch. The store publishes only Updated and
// Removed; *Snapshot also implements Event so a consumer can merge "resync with the
// current snapshot" into the same stream (the API's Watch does that on drops).
type Event interface{ isSessionEvent() }

// Updated carries a session's full state after a change.
type Updated struct{ Session Session }

// Removed is sent when a session is forgotten.
type Removed struct{ ID string }

func (Updated) isSessionEvent()   {}
func (Removed) isSessionEvent()   {}
func (*Snapshot) isSessionEvent() {}

// CreateOptions configures Store.Create.
type CreateOptions struct {
	// RepoID and WorktreePath select the worktree. Either may be empty: a repo alone
	// means its main worktree; a path alone is looked up among registered repos. With
	// WorkspaceID or NewWorkspace they pick the member worktree instead.
	RepoID       string
	WorktreePath string
	// WorkspaceID (an id or a name), when set, makes the workspace the thread's owner.
	// The thread runs in the member WorktreePath or RepoID names, else the first
	// member. Exclusive with NewWorktree and NewWorkspace.
	WorkspaceID string
	// NewWorkspace, when set, makes Create make a workspace (a worktree on cf/<slug>
	// in every repository, the slug as for NewWorktree) and run the thread in the
	// member RepoID names, else the first. Exclusive with NewWorktree and WorkspaceID.
	NewWorkspace *NewWorkspace
	// Model is a claude --model value (alias like "opus" or a full model name).
	Model string
	// Effort is a claude --effort level: low, medium, high, xhigh, max.
	Effort string
	// Name, if set, is the display name and disables auto-naming.
	Name string
	// InitialPrompt is passed to claude as its positional prompt argument (after
	// "--", so a prompt starting with "-" is not read as a flag).
	InitialPrompt string
	// PermissionMode selects claude --permission-mode.
	PermissionMode PermissionMode
	// NewWorktree, when set, makes Create branch a new worktree for the session before
	// claude starts; WorktreePath is then ignored. The branch is cf/<slug>, the slug
	// named from InitialPrompt with a bounded wait (Options.SlugTimeout), else
	// cf/<session id>.
	NewWorktree *NewWorktree
	// Attachments are paths returned by StageAttachment. Each becomes an
	// "Attached image: <path>" line after the prompt; Claude reads them with its Read
	// tool. Paths outside the attachments directory are rejected.
	Attachments []string
}

// RunInTarget names the member a workspace thread should run in: its repository id or
// its worktree path (both, if given, must agree).
type RunInTarget struct {
	RepoID       string
	WorktreePath string
}

// NewWorktree configures the worktree Create makes.
type NewWorktree struct {
	// BaseRef to branch from. Empty means origin/<default branch>, else <default
	// branch>.
	BaseRef string
}

// Store is the session store API. *Manager implements it; sessiontest.Fake is an
// in-memory fake.
type Store interface {
	Create(ctx context.Context, opts CreateOptions) (Session, error)
	// Fork starts a new session continuing id's conversation (claude --fork-session).
	Fork(ctx context.Context, id, name string) (Session, error)
	Get(ctx context.Context, id string) (Session, error)
	// Rename sets a user-chosen name and disables auto-naming.
	Rename(ctx context.Context, id, name string) (Session, error)
	// Close ends the Claude process gracefully and waits until the session is
	// DISCONNECTED (bounded by the store's close timeout plus the kill grace).
	Close(ctx context.Context, id string) error
	// Reconnect resumes a DISCONNECTED session in a new terminal.
	Reconnect(ctx context.Context, id string) (Session, error)
	// Remove closes the session if needed and forgets it.
	Remove(ctx context.Context, id string) error
	// RunIn moves a workspace thread to another member worktree: `/cd <path>` typed
	// once the live thread is idle at its prompt (the row's cwd changes when it is
	// sent), or the row's cwd at once for a disconnected thread.
	RunIn(ctx context.Context, id string, target RunInTarget) (Session, error)
	// Pin sets or clears the user's pin, in any state.
	Pin(ctx context.Context, id string, pinned bool) (Session, error)
	// StageAttachment stores an image for a first prompt and returns its absolute
	// path. mimeType must be one of AttachmentTypes; data at most MaxAttachmentBytes.
	// name is the user's file name, used only in logs.
	StageAttachment(ctx context.Context, name, mimeType string, data []byte) (string, error)
	// Snapshot returns the current immutable snapshot.
	Snapshot() *Snapshot
}
