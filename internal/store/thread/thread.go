// Package thread is the thread store. A thread is a Claude Code conversation
// run in a worktree as `claude -p` over stream-json (internal/claudestream): a
// connected thread owns one claude process, a disconnected one owns none. The store
// starts the process when a message is sent (`claude --resume`) and stops it when the
// thread has idled past its prompt cache expiry (lifecycle.go): users never manage it.
// Its conversation is recorded as thread items (Store.Items).
//
// The Manager persists threads in SQLite (they survive daemon restarts as
// DISCONNECTED), publishes an immutable Snapshot behind an atomic pointer, and emits
// Updated/Removed events on the bus. Each connected thread has one runner goroutine
// that drives the process over stdio, projects the stream into items, derives the
// status from it, tails the Claude transcript, and runs the graceful close. See
// docs/notes/rendered-threads-1-daemon.md and docs/notes/rendered-only-daemon.md.
package thread

import (
	"context"
	"errors"
	"slices"
	"time"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("thread not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
	ErrClosed             = errors.New("thread store closed")
)

// State is the lifecycle of the Claude process behind a thread. Values mirror
// codefoundry.v1.ThreadState.
type State int

// States.
const (
	StateUnspecified State = iota
	// StateStarting: process spawned, the initialize handshake not answered yet.
	StateStarting
	// StateConnected: Claude is running and answered the handshake.
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

// PermissionMode is the claude --permission-mode a thread runs with. Values mirror
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

// Disconnect reasons recorded in Thread.DisconnectReason.
const (
	ReasonClosed         = "closed"           // closed through Close (archive, snooze, remove)
	ReasonExited         = "exited"           // process exited 0 without a close request (/exit)
	ReasonCrashed        = "crashed"          // process exited non-zero without a close request
	ReasonDaemonStopped  = "daemon stopped"   // daemon shut down while connected
	ReasonDaemonRestarts = "daemon restarted" // row was live when the daemon last died
	ReasonSpawnFailed    = "spawn failed"     // claude could not be started, or never answered its handshake
	// ReasonIdle: the daemon stopped the thread idle at its prompt past its prompt cache
	// expiry (lifecycle.go); the next message starts it again.
	ReasonIdle = "idle"
)

// ReasonInterrupted is the StatusReason of StatusError: the process ended mid-turn.
const ReasonInterrupted = "interrupted"

// Thread is an immutable snapshot of one thread. Field meanings follow
// codefoundry.v1.Thread.
//
// Owner: WorkspaceID when set, else the project RepoID when set, else none (a thread
// without a project, CreateOptions.NoProject, running in Options.Home). RepoID and
// WorktreePath are the cwd (for a workspace thread, the member worktree it runs in),
// never the owner beyond that order.
type Thread struct {
	ID              string
	ClaudeSessionID string // set once the transcript file is discovered
	RepoID          string // repository of the cwd; the owner when WorkspaceID is empty
	WorktreePath    string // the cwd
	Name            string
	AutoNamed       bool
	Model           string
	Effort          string
	State           State
	// Status and StatusReason follow the stream while connected (stream_status.go).
	// Persisted: once disconnected they keep what they were when the process ended
	// (busy becomes StatusError ReasonInterrupted; see disconnectedStatus), across
	// daemon restarts, until a reconnect replaces them.
	Status       Status
	StatusReason string
	// StatusChangedAt is when Status or StatusReason last changed. Persisted; zero if
	// never known.
	StatusChangedAt time.Time
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
	// ArchivedAt is when the user archived the thread (Store.Archive); zero when it is
	// not archived. Reconnect, Pin(true), Send and Snooze clear it. Persisted.
	ArchivedAt time.Time
	// SnoozedUntil is when a snoozed thread wakes (Store.Snooze); zero when it is not
	// snoozed. Waking clears it and sets StatusNeedsAttention ReasonSnoozeEnded.
	// Reconnect, Pin(true), Send and Archive(true) clear it. Persisted.
	SnoozedUntil time.Time
	// LinkedPullRequests are the pull requests Claude linked to the conversation
	// (pr-link transcript records; prlink.go), one per URL, in first-seen order. Never
	// shrinks. Persisted. Copy on write: a new slice replaces the old one, the backing
	// array is never written, so snapshots may share it.
	LinkedPullRequests []LinkedPullRequest
	// Usage is the token counters of the thread (usage.go), one bucket per (model,
	// tier, speed, UTC day), sorted by Day, Model, Tier, Speed: the sum over every
	// transcript in Transcripts and every run in AgentRuns. Only ever replaced by a
	// complete fold, never added to. Persisted. Copy on write like LinkedPullRequests.
	Usage []UsageBucket
	// Transcripts are the Claude session ids (transcript files) the thread's
	// conversation has used, oldest first: /clear moves Claude to a new one. The last is
	// usually ClaudeSessionID. Persisted. Copy on write.
	Transcripts []string
	// AgentRuns are the subagent runs under Transcripts (usage_runs.go), by start time.
	// Persisted. Copy on write.
	AgentRuns []AgentRun
	// EffortPending: an effort change (Store.SetEffort) waits for the
	// running turn to end; Effort is already the new level. Not persisted.
	EffortPending bool
	// ContextTokens is the thread's context size after its last turn: the last
	// top-level API response's input + cache read + cache write + output tokens
	// (context.go). 0 before the first result and after /clear. Persisted.
	ContextTokens int64
	// ContextModel is the model that answered the turn ContextTokens comes from, as
	// Claude names it ("claude-haiku-4-5-20251001"); "" when unknown. Persisted.
	ContextModel string
	// LastResultAt is when the turn ContextTokens comes from ended: the conversation's
	// last API request, which refreshed its prompt cache. Zero with ContextTokens.
	// Persisted.
	LastResultAt time.Time
	// CacheExpiresAt is LastResultAt plus the store's cache TTL (Manager.SetCacheTTL);
	// zero when LastResultAt is. Derived, not persisted.
	CacheExpiresAt time.Time
	// Retry is set while Claude waits to retry a failed API request (system/api_retry:
	// a 429, a 529, a 5xx, a connection error) and nil once any other frame follows or
	// the process ends. Not persisted. See docs/notes/api-retry-note.md.
	Retry *APIRetry
	// BackgroundShellsRunning counts the thread's own background shells running now
	// (bgshells.go): Bash calls with run_in_background and Monitor calls. 0 once the
	// process ended. Not persisted.
	BackgroundShellsRunning int
	// WakePending: a background shell or agent run ended while Claude was at its prompt,
	// and the turn Claude starts by itself to report it has not ended yet (wake.go). Not
	// persisted; Thread.background_wake_pending on the API.
	WakePending bool
	// CreatedBy is the thread whose agent created this one (CreateOptions.CreatedBy);
	// empty when the user did. CreatedByName is that thread's name (its id when unnamed)
	// at creation, kept verbatim. Persisted (metadata.go).
	CreatedBy     string
	CreatedByName string
	// Brief is what the thread was started for, in its creator's words. Persisted.
	Brief string
	// Labels are sorted, distinct label tokens (CleanLabels). Persisted. Copy on write.
	Labels []string
	// Report is the thread's latest report (Store.Report); the zero value when none.
	// Persisted.
	Report Report
	// BudgetUSD is the spending limit (0 = none); BudgetHitUSD the budget value the
	// budget stop last fired for (0 = armed; budget.go). Persisted.
	BudgetUSD    float64
	BudgetHitUSD float64
}

// APIRetry is one api_retry frame of a thread's stream (stream.go): Claude retries a
// failed API request at RetryAt. A value in Thread.Retry: never mutated once set.
type APIRetry struct {
	// Attempt counts from 1 to MaxRetries.
	Attempt, MaxRetries int
	// RetryAt is when the retry is due (the frame's time plus retry_delay_ms).
	RetryAt time.Time
	// Status is the HTTP status of the failed request; 0 for a connection error.
	Status int
	// Error is Claude's category: "rate_limit", "overloaded", "server_error", ...
	Error string
}

// Snapshot is every thread, sorted by creation time then id. Never mutate it.
type Snapshot struct {
	Threads []Thread
	// RetiredUsage is the usage of removed threads summed per (model, tier, speed,
	// day): Store.Remove adds a thread's buckets here as it forgets it, so the total
	// over every thread ever tracked is the threads' Usage plus RetiredUsage. Sorted
	// like Thread.Usage. Persisted (usage_retired).
	RetiredUsage []UsageBucket
}

// Thread returns the thread with id.
func (s *Snapshot) Thread(id string) (Thread, bool) {
	if s == nil {
		return Thread{}, false
	}
	i := slices.IndexFunc(s.Threads, func(x Thread) bool { return x.ID == id })
	if i < 0 {
		return Thread{}, false
	}
	return s.Threads[i], true
}

// Event is published on the bus as bus.Publish[thread.Event]. Subscribe with
// bus.Subscribe[thread.Event] and type-switch. The store publishes only Updated,
// Removed and RetiredUsage; *Snapshot also implements Event so a consumer can merge
// "resync with the current snapshot" into the same stream (the API's Watch does that
// on drops).
type Event interface{ isThreadListEvent() }

// Updated carries a thread's full state after a change.
type Updated struct{ Thread Thread }

// Removed is sent when a thread is forgotten.
type Removed struct{ ID string }

// RetiredUsage follows Removed when the removed thread had usage. It carries the
// whole retired ledger (Snapshot.RetiredUsage) after the thread's buckets were added.
type RetiredUsage struct{ Buckets []UsageBucket }

func (Updated) isThreadListEvent()      {}
func (Removed) isThreadListEvent()      {}
func (RetiredUsage) isThreadListEvent() {}
func (*Snapshot) isThreadListEvent()    {}

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
	// NoProject, when set, starts a thread without a project: it runs in Options.Home
	// with an empty RepoID and WorkspaceID. Exclusive with RepoID, WorktreePath,
	// NewWorktree, WorkspaceID and NewWorkspace.
	NoProject bool
	// Model is a claude --model value (registry id like "claude-opus-4-8[1m]", or any full model name).
	Model string
	// Effort is a claude --effort level: low, medium, high, xhigh, max.
	Effort string
	// Name, if set, is the display name and disables auto-naming.
	Name string
	// InitialPrompt is sent as the thread's first user message once Claude answers the
	// handshake. File references "cf-file://<repoId>/<path>" in it become absolute
	// paths in the thread's worktrees (filerefs.go); the item keeps it as typed.
	InitialPrompt string
	// ComposerPrompt is the GUI composer's text of InitialPrompt (its tags as tokens),
	// kept on the first user message for display.
	ComposerPrompt string
	// PermissionMode selects claude --permission-mode.
	PermissionMode PermissionMode
	// NewWorktree, when set, makes Create branch a new worktree for the thread before
	// claude starts; WorktreePath is then ignored. The branch is cf/<slug>, the slug
	// named from InitialPrompt with a bounded wait (Options.SlugTimeout), else
	// cf/<thread id>.
	NewWorktree *NewWorktree
	// Attachments are paths returned by StageAttachment. Each becomes an
	// "Attached image: <path>" or "Attached PDF: <path> (<N> pages)" line after the
	// prompt (buildPrompt) and is also sent as a base64 image or document block, except
	// a PDF over MaxInlinePDFPages, which Claude reads with its Read tool. Paths outside
	// the attachments directory are rejected, as are attachments sending more than
	// MaxMessageMediaBytes inline.
	Attachments []string
	// CreatedBy is the thread whose agent asks for this one; it must exist. Create
	// records its current name and starts the log with a "Created by" note.
	CreatedBy string
	// Brief, Labels and BudgetUSD are the thread's (metadata.go validates them).
	Brief     string
	Labels    []string
	BudgetUSD float64
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

// Store is the thread store API. *Manager implements it; threadtest.Fake is an
// in-memory fake.
type Store interface {
	Create(ctx context.Context, opts CreateOptions) (Thread, error)
	// Fork starts a new thread continuing id's conversation (claude --fork-session).
	Fork(ctx context.Context, id, name string) (Thread, error)
	Get(ctx context.Context, id string) (Thread, error)
	// Rename sets a user-chosen name and disables auto-naming.
	Rename(ctx context.Context, id, name string) (Thread, error)
	// Close ends the Claude process gracefully and waits until the thread is
	// DISCONNECTED (bounded by the store's close timeout plus the kill grace). No
	// command calls it: archive, snooze and remove close through it.
	Close(ctx context.Context, id string) error
	// Reconnect resumes a DISCONNECTED thread in a new claude process, without a
	// prompt. No command calls it: a message starts a stopped thread (Send).
	Reconnect(ctx context.Context, id string) (Thread, error)
	// Remove closes the thread if needed and forgets it.
	Remove(ctx context.Context, id string) error
	// RunIn moves a workspace thread to another member worktree: set_cwd once the live
	// thread is idle at its prompt (the row's cwd changes when Claude accepts), or the
	// row's cwd at once for a disconnected thread.
	RunIn(ctx context.Context, id string, target RunInTarget) (Thread, error)
	// Pin sets or clears the user's pin, in any state. Pinning unarchives and unsnoozes.
	Pin(ctx context.Context, id string, pinned bool) (Thread, error)
	// Archive archives a thread (archived true): it closes it like Close, kills and
	// removes its shells, unpins and unsnoozes it and sets ArchivedAt (kept when already set). With
	// archived false it only clears ArchivedAt; the thread stays disconnected.
	Archive(ctx context.Context, id string, archived bool) (Thread, error)
	// Label edits a thread's labels: clear removes every label, then remove's go, then
	// add's are added (each validated; a label in both is ErrInvalidArgument). Any state.
	Label(ctx context.Context, id string, add, remove []string, clear bool) (Thread, error)
	// Report replaces the thread's report (status required; summary and data
	// validated), stamped with now. Any state.
	Report(ctx context.Context, id string, r Report) (Thread, error)
	// SetBudget sets the thread's spending limit (0 clears it). A budget above the
	// thread's cost re-arms the budget stop (budget.go). Any state.
	SetBudget(ctx context.Context, id string, usd float64) (Thread, error)
	// Snooze snoozes a thread until a time (after now; ErrInvalidArgument otherwise):
	// it closes it like Close, kills and removes its shells, unpins and unarchives it
	// and sets SnoozedUntil (replacing an earlier one). When the time comes the store
	// clears it and the disconnected thread needs attention (ReasonSnoozeEnded). A zero
	// until only clears SnoozedUntil.
	Snooze(ctx context.Context, id string, until time.Time) (Thread, error)
	// StageAttachment stores an image or PDF for a message and returns its absolute
	// path. mimeType must be one of AttachmentTypes; data at most MaxAttachmentBytes
	// (an image) or MaxPDFAttachmentBytes (a PDF). pages is the client's page count
	// for a PDF (0 when unknown), used when pdfinfo is not installed; the settled
	// count is part of the returned file name. name is the user's file name, used
	// only in logs.
	StageAttachment(ctx context.Context, name, mimeType string, data []byte, pages int) (string, error)
	// ReadAttachment returns a staged attachment's content and MIME type (a thread's
	// user message shows its images and PDFs). ErrNotFound once reaped.
	ReadAttachment(ctx context.Context, path string) ([]byte, string, error)
	// Snapshot returns the current immutable snapshot.
	Snapshot() *Snapshot

	// Thread conversations (conversation.go, items.go).

	// Items returns a thread's conversation: every item, the one streaming
	// included, and the pending permission requests and questions.
	Items(ctx context.Context, id string) (ItemsSnapshot, error)
	// WatchItems is Items for a viewer: until ctx ends the thread counts as looked at,
	// so a finished turn is seen at once. Subscribe to
	// ThreadEvent on the bus first; events with Seq <= the snapshot's are in it.
	WatchItems(ctx context.Context, id string) (ItemsSnapshot, error)
	// Send sends a user message (also while a turn runs: Claude queues or folds it
	// in). A thread that is not running starts with it as its first prompt; its item is
	// returned at once, and a start that fails is told in the timeline (lifecycle.go).
	Send(ctx context.Context, id string, msg Message) (Item, error)
	// Respond answers a pending permission request or question.
	Respond(ctx context.Context, id, requestID string, d Decision) (Item, error)
	// Interrupt stops the running turn; a no-op when the thread is not running.
	Interrupt(ctx context.Context, id string) error
	// SetModel switches the model of a running thread and records it for later
	// spawns; on a thread that is not running it only records it.
	SetModel(ctx context.Context, id, model string) (Thread, error)
	// SetPermissionMode switches the permission mode (supervised, accept edits or auto;
	// Claude's default cannot be restored live) and records it; on a thread that is not
	// running it only records it.
	SetPermissionMode(ctx context.Context, id string, mode PermissionMode) (Thread, error)
	// SetEffort changes a thread's effort and records it. Claude has no live effort
	// switch: a running process restarts with --resume and the new --effort, at once
	// when idle, else after the running turn (EffortPending meanwhile); a thread that is
	// not running only records it.
	SetEffort(ctx context.Context, id, effort string) (Thread, error)
	// McpStatus returns a thread's MCP servers as last checked (mcp.go), also while it
	// is not running. refresh asks Claude again first, starting a stopped thread without
	// a prompt. Without it, a running thread not checked yet is asked once.
	McpStatus(ctx context.Context, id string, refresh bool) (*McpStatus, error)
	// McpReconnect reconnects one of a thread's MCP servers (by name), starting a
	// stopped thread without a prompt, then checks the servers again. Claude refusing the
	// attempt (the server still fails) is the result's Error, not an error; an unknown
	// server is ErrNotFound.
	McpReconnect(ctx context.Context, id, server string) (McpReconnectResult, error)
	// SlashCommands returns the slash commands the thread offers: Claude's list minus
	// the deny table, kept current as Claude pushes changes and kept while it is not
	// running (slashcommands.go). nil when Claude never answered a handshake.
	SlashCommands(ctx context.Context, id string) ([]SlashCommand, error)
}
