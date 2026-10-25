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
	// PermissionSupervised: --permission-mode manual, edits and commands are confirmed;
	// reads, searches and read-only commands run unconfirmed (Claude's own rules).
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
	ReasonClosed = "closed" // closed through Close (archive, snooze, remove)
	ReasonExited = "exited" // process exited 0 without a close request (/exit)
	// ReasonCrashed: the process exited non-zero without a close request. Also the
	// StatusReason, with StatusError, of a turn whose process died on its own mid-turn
	// (disconnectedStatus): "crashed", not "interrupted", since no one stopped it.
	ReasonCrashed        = "crashed"
	ReasonDaemonStopped  = "daemon stopped"   // daemon shut down while connected
	ReasonDaemonRestarts = "daemon restarted" // row was live when the daemon last died
	ReasonSpawnFailed    = "spawn failed"     // claude could not be started, or never answered its handshake
	// ReasonIdle: the daemon stopped the thread idle at its prompt past its prompt cache
	// expiry (lifecycle.go); the next message starts it again.
	ReasonIdle = "idle"
)

// ReasonInterrupted is the StatusReason of StatusError: the process ended mid-turn.
const ReasonInterrupted = "interrupted"

// ReasonArchived is the StatusReason, with StatusIdle, of a thread whose turn (or
// pending request) an archive cut off: stopped on purpose, not interrupted (Archive).
const ReasonArchived = "archived"

// Thread is an immutable snapshot of one thread. Field meanings follow
// codefoundry.v1.Thread.
//
// Projects: a thread has a set of projects (ProjectIDs, sorted by id), one of which is
// the primary (ProjectID and WorktreePath: the cwd). Every member has a checkout,
// derived and never stored (checkouts.go, docs/notes/workspaces-v2-1-threads.md): in
// worktree mode (CreatedWorktree) a git member's is the worktree for (project, Branch),
// a plain folder's the folder; otherwise each member's own checkout. A thread without a
// project (CreateOptions.NoProject) has an empty set and runs in Options.Home.
// WorkspaceID is an optional reference to a workspace, independent of the set.
type Thread struct {
	ID              string
	ClaudeSessionID string // set once the transcript file is discovered
	ProjectID       string // the primary: the project of the cwd; "" without a project
	// ProjectIDs is the thread's project set, sorted by id and without duplicates; it
	// holds ProjectID when that is set (CleanProjectIDs), and is empty for a thread
	// without a project. Persisted (threads.project_ids). Copy on write.
	ProjectIDs   []string
	WorktreePath string // the cwd
	Name         string
	AutoNamed    bool
	// NameProvisional: Name was derived from the first prompt (provisional.go) and the
	// namer still replaces it; a rename or the namer's title clears it. Persisted.
	NameProvisional bool
	Model           string
	Effort          string
	State           State
	// Status and StatusReason follow the stream while connected (stream_status.go).
	// Persisted: once disconnected they keep what they were when the process ended
	// (busy becomes StatusError ReasonInterrupted; see disconnectedStatus), across
	// daemon restarts, until a reconnect replaces them.
	Status       Status
	StatusReason string
	// PendingRequestID is the can_use_tool request a "permission: …" or "question: …"
	// StatusReason describes (the oldest pending one), published with the status; ""
	// otherwise and once the process is gone. Two requests in a row can read the same
	// reason: wake subscriptions tell them apart by it (subscriptions.go). Not persisted.
	PendingRequestID string
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
	BaseRef string
	// CreatedWorktree is worktree mode: every git member works in its worktree for
	// Branch, made at spawn when missing (checkouts.go). False: checkout mode, every
	// member in its own checkout.
	CreatedWorktree bool
	// Branch is the branch of a worktree-mode thread (CreatedWorktree; copied by Fork):
	// its members' worktrees are on it, and one a cleanup removed is made again on it, at
	// the same path, when the thread starts (recreate.go). It is what the thread was
	// created for, not what the worktree has checked out now. Persisted; rows from before
	// it are filled in from the project store at startup while their worktree exists
	// (backfillBranches).
	Branch string
	// WorkspaceID is an optional reference to a workspace (its managed dir and
	// instructions reach every spawn; workspace.go), independent of ProjectIDs. A thread
	// whose primary is the workspace has an empty ProjectID and runs in its root, or its
	// managed dir.
	WorkspaceID string
	// PendingWorktreePath is the checkout a queued RunIn moves the thread to once it is
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
	// (pr-link transcript records; prlink.go) and those of the threads it created,
	// transitively (prlink_children.go), and the pull requests whose head is a branch
	// the thread works on (prlink_branch.go), one per URL, in first-seen order. Never
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
	// Removing: Store.Remove is closing the thread to forget it (tombstones.go). The
	// thread meets no wait or wake condition meanwhile (Meets). Not persisted, not on
	// the API.
	Removing bool
	// CreatedBy is the thread whose agent created this one (CreateOptions.CreatedBy);
	// empty when the user did. CreatedByName is that thread's name (its id when unnamed)
	// at creation, kept verbatim. Persisted (metadata.go).
	CreatedBy     string
	CreatedByName string
	// SidebarOverride shows (true) or hides (false) a thread with a CreatedBy in the
	// sidebar whatever the threads.show_created_threads setting says; nil follows it,
	// and is always nil on the user's own threads (sidebar.go, InSidebar). Set by
	// CreateOptions.InSidebar and Store.SetSidebar. Persisted (in_sidebar). Copy on
	// write: replaced, never written through.
	SidebarOverride *bool
	// Depth is how far below ListOptions.DescendantsOf the thread is (0: that thread),
	// set on List's answer with that option only; never in a snapshot.
	Depth int
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
	// ResumeNote is the note the next message to Claude starts with, after something
	// other than the user stopped its turn (resumenote.go); the zero value when none.
	// Persisted.
	ResumeNote ResumeNote
	// PendingFirst is the thread's first message until Claude has it (firstprompt.go):
	// a daemon stop before the handshake keeps it for the next start. nil when none.
	// Persisted; not on the API. Copy on write: replaced, never written through.
	PendingFirst *PendingFirst
	// Flags are the plugins' flags on the thread (flags.go): one per source, errors
	// first, then newest first. Persisted (thread_flags). Copy on write.
	Flags []Flag
	// Owner is who owns a thread the user does not (CreateOptions.Owner; owner.go):
	// "plugin:<name>". Owned threads are hidden from the user's lists (ListOptions).
	// Persisted; set once at Create.
	Owner string
	// SpawnEnv ("KEY=VALUE") and SpawnAddDirs are the thread's own additions to every
	// spawn of it (CreateOptions.Env, AddDirs; spawnextras.go), after the spawn extras'.
	// Persisted; set once at Create. Copy on write.
	SpawnEnv     []string
	SpawnAddDirs []string
	// PluginEnvStale: the spawn extras (plugins' session environment) for the thread's
	// scope changed since its running process started (envstale.go); PluginEnvChange
	// says what, by source name and variable names, never values. Cleared by a spawn, a
	// restart and the process's end. Not persisted.
	PluginEnvStale  bool
	PluginEnvChange string
	// Kind is KindResident for a resident thread (resident.go), whose ResidentName names
	// it ("ember"). Persisted; set once.
	Kind         ThreadKind
	ResidentName string
	// Epoch counts the thread's Claude sessions: 1, plus one per Reseed (reseed.go).
	// Persisted.
	Epoch int
	// SystemPromptAppend is appended to Claude's system prompt on every spawn (after the
	// app's line and a workspace's); set by Reseed and EnsureResident. Persisted.
	SystemPromptAppend string
	// FreshStart: the next spawn starts a new conversation instead of resuming (Reseed);
	// cleared by that spawn. SeedPrefix is prepended to the first message of a fresh
	// conversation and cleared once it went out. Both persisted.
	FreshStart bool
	SeedPrefix string
	// MemoryHash identifies the app memory's entries the thread's conversation last got:
	// in its system prompt (a fresh spawn) or as a refresh before a message after a
	// resumed one (memory.go). "" for none. A fork starts with its parent's. Persisted.
	MemoryHash string
	// ReseedPending: a Reseed waits for the running turn and background work to end
	// before Claude stops (reseed.go). Never set on a stopped thread. Not persisted.
	ReseedPending bool
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

// CreateReport is what a Create's placement did with the primary (CreateOptions.Report),
// for the summary a caller prints.
type CreateReport struct {
	// MadeWorktree: this Create made the primary's worktree (from Thread.BaseRef when
	// its branch was new). ExistingWorktree: the primary's worktree existed and is
	// reused; SharedWith then names another thread that is not archived with it as a
	// checkout ("<name> (<id>)"), "" when none. Both false: the primary is not a worktree
	// (a folder, a workspace's folder, an own checkout).
	MadeWorktree, ExistingWorktree bool
	SharedWith                     string
	// MadeBranch: with MadeWorktree, its branch was new too; false: an existing branch
	// (local or origin's) was checked out.
	MadeBranch bool
	// DroppedWorktreeMode: the copied thread works in worktrees, but the projects given
	// have no git, so this one runs in their folders (checkout mode).
	DroppedWorktreeMode bool
}

// CreateOptions configures Store.Create.
type CreateOptions struct {
	// ProjectID and WorktreePath select the primary (placement.go). Either may be empty:
	// a project alone means its checkout (in worktree mode its worktree on the branch); a
	// path alone is looked up among registered projects. With WorkspaceID, ProjectID may be
	// workspace.PrimaryWorkspace: the thread runs in the workspace's folder.
	ProjectID    string
	WorktreePath string
	// ProjectIDs is the project set (refs: an id, a name when unique, or an absolute
	// path inside one; "<ref>:<base ref>" gives that member its own base for a new
	// branch). Empty: ProjectID's alone, or the inherited thread's. ProjectID, when set,
	// must be in it; otherwise the first is the primary.
	ProjectIDs []string
	// Like copies the project set, branch, primary, workspace reference and mode from
	// another thread (thread new --like); the other options narrow or override them
	// (placement.go). Without Like, a thread with CreatedBy inherits the same from its
	// creator unless the options place it elsewhere.
	Like string
	// NewBranch, with Like or an inherited thread: a new branch for the same set, in
	// worktree mode (as NewWorktree without options).
	NewBranch bool
	// CheckoutMode runs every member in its own checkout even when Like or the inherited
	// thread is in worktree mode (thread new --new-worktree=false).
	CheckoutMode bool
	// Report, when set, is filled in by Create with what the placement did (the CLI's
	// summary); untouched when Create fails or a request id repeats.
	Report *CreateReport
	// WorkspaceID (an id or a name) is the workspace the thread references. Without
	// ProjectIDs its members are the set; the primary is ProjectID, else the workspace's
	// default primary, else the first member (placement.go).
	WorkspaceID string
	// NoProject, when set, starts a thread without a project: it runs in Options.Home
	// with an empty ProjectID and WorkspaceID. Exclusive with ProjectID, WorktreePath,
	// NewWorktree and WorkspaceID.
	NoProject bool
	// Model is a claude --model value (registry id like "claude-opus-4-8[1m]", or any full model name).
	Model string
	// Effort is a claude --effort level: low, medium, high, xhigh, max.
	Effort string
	// ModelDefaulted and EffortDefaulted: Model and Effort were filled from the user's
	// settings, not chosen (the CLI's thread.new without --model or --effort), so a
	// creator's defaults (Manager.SetCreateDefaults) may replace them, as they replace
	// an empty one.
	ModelDefaulted, EffortDefaulted bool
	// Name, if set, is the display name and disables auto-naming.
	Name string
	// InitialPrompt is sent as the thread's first user message once Claude answers the
	// handshake. File references "cf-file://<projectId>/<path>" in it become absolute
	// paths in the thread's worktrees (filerefs.go); the item keeps it as typed.
	InitialPrompt string
	// ComposerPrompt is the GUI composer's text of InitialPrompt (its tags as tokens),
	// kept on the first user message for display.
	ComposerPrompt string
	// PermissionMode selects claude --permission-mode.
	PermissionMode PermissionMode
	// NewWorktree, when set, makes Create branch a new worktree for the thread before
	// claude starts; WorktreePath is then ignored. The branch follows the
	// projects.branch_naming mode (branchname.go), named from InitialPrompt with a
	// bounded wait (Options.SlugTimeout), else cf/<thread id>.
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
	// Notify, with CreatedBy, also subscribes the creator to the new thread: condition
	// settled, repeat (subscriptions.go). ErrInvalidArgument without CreatedBy.
	Notify bool
	// Owner makes the thread someone else's than the user's ("plugin:<name>"; owner.go):
	// hidden from the user's lists. Exclusive with CreatedBy.
	Owner string
	// InSidebar is Thread.SidebarOverride at creation (nil: follow the setting). Only
	// with CreatedBy (ErrInvalidArgument otherwise).
	InSidebar *bool
	// Cwd, with NoProject, is where claude runs instead of Options.Home: an existing
	// directory inside it (owner.go).
	Cwd string
	// Env ("KEY=VALUE") and AddDirs are added to every spawn of the thread, after the
	// spawn extras' (a plugin's thread/create; the caller validated them).
	Env     []string
	AddDirs []string
	// SystemPromptAppend is Thread.SystemPromptAppend from the start: context for the
	// model that is not the user's words (theme.ask's), on every spawn. At most 64 KiB, no
	// NUL.
	SystemPromptAppend string
}

// RunInTarget names the checkout a thread should run in: a member's project id (or
// name) or its checkout path (both, if given, must agree).
type RunInTarget struct {
	ProjectID    string
	WorktreePath string
}

// NewWorktree configures the worktree Create makes.
type NewWorktree struct {
	// BaseRef to branch from. Empty is the default branch; the project store resolves
	// either by projects.base_from_origin (project.CreateWorktreeOptions). Ignored
	// when Branch names an existing branch.
	BaseRef string
	// Branch steers the branch (`thread new --branch`): with a slash it is the branch,
	// else the slug the projects.branch_naming mode wraps. An existing one is checked
	// out. Empty: generated (branchname.go).
	Branch string
	// BaseFromOrigin, when set, overrides projects.base_from_origin
	// (Options.BaseFromOrigin) for this worktree: thread new --base-from-origin yes|no.
	BaseFromOrigin *bool
}

// Store is the thread store API. *Manager implements it; threadtest.Fake is an
// in-memory fake.
type Store interface {
	Create(ctx context.Context, opts CreateOptions) (Thread, error)
	// CreateOnce is Create keyed by an idempotency key (requests.go): a key its creator
	// used within RequestIDTTL returns that thread with reused set and makes nothing.
	// An empty key is a plain Create.
	CreateOnce(ctx context.Context, requestID string, opts CreateOptions) (t Thread, reused bool, err error)
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
	// RunIn moves a thread to another of its checkouts (another member becomes the
	// primary): set_cwd once the live thread is idle at its prompt (the row's cwd changes
	// when Claude accepts), or the row's cwd at once for a disconnected thread.
	RunIn(ctx context.Context, id string, target RunInTarget) (Thread, error)
	// Checkouts resolves a thread (by id, else the thread one of whose checkouts holds
	// the cwd, the deepest winning) and lists its checkouts (checkouts.go).
	Checkouts(ctx context.Context, ref CheckoutsRef) (ThreadCheckouts, error)
	// CheckoutHints are the collision hints for t's checkouts: members another thread
	// that is not archived also has (checkouts.go). Never an error; nil when none.
	CheckoutHints(t Thread) []string
	// Pin sets or clears the user's pin, in any state. Pinning unarchives and unsnoozes.
	Pin(ctx context.Context, id string, pinned bool) (Thread, error)
	// Archive archives a thread (archived true): it closes it like Close, kills and
	// removes its shells, unpins and unsnoozes it and sets ArchivedAt (kept when already set). With
	// archived false it only clears ArchivedAt; the thread stays disconnected.
	//
	// Archiving also archives, first and the same way, the threads below it that are
	// not shown in the sidebar, through hidden threads only (ArchiveCascade); one that
	// fails is skipped, and the thread is still archived but the error (a
	// *CascadeError) names the failures. Unarchiving does not cascade.
	Archive(ctx context.Context, id string, archived bool) (Thread, error)
	// SetSidebar shows or hides a thread another thread created in the sidebar
	// (Thread.SidebarOverride); ErrInvalidArgument for the user's own thread. Any state.
	SetSidebar(ctx context.Context, id string, shown bool) (Thread, error)
	// SetWorkspace sets the thread's workspace reference (Thread.WorkspaceID) to the
	// workspace ref names (an id or a name), or clears it for "". The project set stays.
	// ErrNotFound for an unknown workspace; ErrFailedPrecondition to clear or change it
	// on a thread that runs in its workspace's folder. Any state; it applies from the
	// next spawn.
	SetWorkspace(ctx context.Context, id, ref string) (Thread, error)
	// Label edits a thread's labels: clear removes every label, then remove's go, then
	// add's are added (each validated; a label in both is ErrInvalidArgument). Any state.
	Label(ctx context.Context, id string, add, remove []string, clear bool) (Thread, error)
	// Report replaces the thread's report (status required; summary and data
	// validated), stamped with now. Any state.
	Report(ctx context.Context, id string, r Report) (Thread, error)
	// SetBudget sets the thread's spending limit (0 clears it). A budget above the
	// thread's cost re-arms the budget stop (budget.go). Any state.
	SetBudget(ctx context.Context, id string, usd float64) (Thread, error)
	// SetFlag raises (or with FlagNone clears) a source's flag on a thread; changed is
	// false when nothing changed (flags.go).
	SetFlag(ctx context.Context, id string, f Flag) (t Thread, changed bool, err error)
	// ClearFlags removes a source's flag from a thread, every flag with source "", and
	// returns how many went.
	ClearFlags(ctx context.Context, id, source string) (Thread, int, error)
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
	// StageAttachmentFile stages the file at an absolute path the same way, reading
	// it as the daemon's user: the type is sniffed from the content (mimeType may be
	// empty; when set it is checked like StageAttachment's) and the name taken from the
	// path. A relative path or a directory is ErrInvalidArgument, a missing file
	// ErrNotFound; unsupported content fails like an unsupported mimeType.
	StageAttachmentFile(ctx context.Context, path, mimeType string, pages int) (string, error)
	// ReadAttachment returns a staged attachment's content and MIME type (a thread's
	// user message shows its images and PDFs). ErrNotFound once reaped.
	ReadAttachment(ctx context.Context, path string) ([]byte, string, error)
	// Snapshot returns the current immutable snapshot.
	Snapshot() *Snapshot
	// List returns the threads o selects, the most recently active first (filter.go).
	// A Project or Workspace that names nothing is ErrInvalidArgument.
	List(ctx context.Context, o ListOptions) ([]Thread, error)
	// Removed returns what is kept of a thread removed within RemovedTTL
	// (tombstones.go). A look-up of such an id is a *RemovedError.
	Removed(id string) (RemovedThread, bool)
	// ListRemoved returns the threads removed within RemovedTTL that o selects
	// (FilterRemoved), the most recently removed first.
	ListRemoved(ctx context.Context, o ListOptions) ([]RemovedThread, error)

	// Thread conversations (conversation.go, items.go).

	// Items returns a thread's conversation: every item, the one streaming
	// included, and the pending permission requests and questions.
	Items(ctx context.Context, id string) (ItemsSnapshot, error)
	// WatchItems is Items for a viewer: until ctx ends the thread counts as looked at,
	// so a finished turn is seen at once. Subscribe to
	// ThreadEvent on the bus first; events with Seq <= the snapshot's are in it.
	WatchItems(ctx context.Context, id string) (ItemsSnapshot, error)
	// Send sends a user message (also while a turn runs: Claude picks it up mid-turn,
	// inside the running turn). A thread that is not running starts with it as its first prompt; its item is
	// returned at once, and a start that fails is told in the timeline (lifecycle.go).
	Send(ctx context.Context, id string, msg Message) (Item, error)
	// Respond answers a pending permission request or question.
	Respond(ctx context.Context, id, requestID string, d Decision) (Item, error)
	// Interrupt stops the running turn; a no-op when the thread is not running. by is
	// the thread that asked for it (the CLI's $CODE_FOUNDRY_THREAD), empty for the user:
	// a turn another thread stopped leaves a resume note for the next message
	// (resumenote.go).
	Interrupt(ctx context.Context, id, by string) error
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
	// Restart restarts a running thread's Claude with the same conversation (the effort
	// restart's path: --resume), interrupting a running turn first; restarted is false,
	// and nothing happens, when Claude is not running (restart.go).
	Restart(ctx context.Context, id string) (t Thread, restarted bool, err error)
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
	// ShowHTML shows an HTML page inline in the conversation (html.go): an html item at
	// the thread's current position, inside the running turn when one is live. path must
	// be an absolute path to a regular .html or .htm file under home
	// (ErrInvalidArgument; ErrNotFound when missing). A page shown since the thread's
	// last user message is not added twice (ShowHTMLOptions): Reused, and the item is
	// that card's.
	ShowHTML(ctx context.Context, id, path, title string, o ShowHTMLOptions) (ShowHTMLResult, error)
	// ShowTheme puts a theme card in the conversation (theme.go), where ShowHTML puts a
	// page: the file as the thread saved it (ErrInvalidArgument when it does not
	// validate), whether the save applied it, and the slot's theme before.
	ShowTheme(ctx context.Context, id string, card ThemeCard) (Item, error)
	// PageStorage returns what the thread's pages keep with the bridge's cf.storage
	// (pagestorage.go): key → the value's JSON text.
	PageStorage(ctx context.Context, id string) (map[string]string, error)
	// SetPageStorage sets one key of the thread's page storage to a value's JSON text,
	// or removes it (value nil), and returns the storage after. ErrInvalidArgument for a
	// bad key or value, or when the storage would grow over PageStorageMax.
	SetPageStorage(ctx context.Context, id, key string, value *string) (map[string]string, error)

	// Wake subscriptions (subscriptions.go, docs/notes/agents-4-wake.md).

	// Subscribe makes a subscription: the subscriber is sent a wake message when the
	// target thread meets the condition (on each transition into it, and at once when it
	// already does), or when the target action run finishes.
	Subscribe(ctx context.Context, o SubscribeOptions) (SubscribeResult, error)
	// Unsubscribe removes a subscription by id, or every subscription of a subscriber to
	// a target, and returns what it removed (ErrNotFound when nothing matched).
	Unsubscribe(ctx context.Context, o UnsubscribeOptions) ([]Subscription, error)
	// Subscriptions lists a subscriber's subscriptions, or every thread's ("").
	Subscriptions(ctx context.Context, subscriber string) ([]Subscription, error)

	// Resident threads and reseeds (resident.go, reseed.go; docs/notes/ember-1-primitives.md).

	// EnsureResident returns the resident thread named name, making it (stopped) when
	// there is none; created says whether it did.
	EnsureResident(ctx context.Context, name string, o ResidentOptions) (t Thread, created bool, err error)
	// Reseed gives a thread a fresh Claude session with a seed (reseed.go): its next
	// process starts a new conversation with o's system prompt append and add-dirs (they
	// replace the thread's) and o.Prefix before its first message. Epoch goes up by one.
	// A running Claude stops at once when idle (stopped), else once its turn ends
	// (ReseedPending); a stopped thread only records it.
	Reseed(ctx context.Context, id string, o ReseedOptions) (t Thread, stopped bool, err error)
}
