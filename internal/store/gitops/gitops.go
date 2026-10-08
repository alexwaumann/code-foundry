// Package gitops runs git and gh operations on worktrees (fetch, pull, push, pull
// request create/open) and hands worktrees or URLs to other apps (editor, Finder,
// browser).
//
// Operations on one worktree run one at a time, in request order; different worktrees
// run in parallel on a bounded number of workers. Each operation has a deadline, runs
// with GIT_TERMINAL_PROMPT=0 and without a controlling terminal, and records every
// command it ran with its output. Queued, Started and Finished events are published on
// the bus (one topic, gitops.Event) and an immutable Snapshot holds the running and
// recent operations. After fetch, pull, push and PR create the repo store is asked to
// Refresh, so ahead/behind updates without waiting for its poll.
//
// A failed operation is a result, not an error: methods return the finished Op with
// State Failed. Errors are reserved for bad requests (ErrInvalidArgument) and a closed
// store (ErrClosed).
package gitops

import (
	"context"
	"errors"
	"time"

	"github.com/awaumann/code-foundry/internal/store/repo"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrInvalidArgument = errors.New("invalid argument")
	ErrClosed          = errors.New("gitops store closed")
)

// Kind is the kind of operation.
type Kind int

// Operation kinds. Values match codefoundry.v1.GitOpKind.
const (
	KindUnspecified Kind = iota
	KindFetch
	KindPull
	KindPush
	KindPRCreate
	KindPROpen
	KindOpenEditor
	KindReveal
	KindOpenURL
)

var kindNames = map[Kind]string{
	KindFetch: "fetch", KindPull: "pull", KindPush: "push", KindPRCreate: "pr-create",
	KindPROpen: "pr-open", KindOpenEditor: "open-editor", KindReveal: "reveal", KindOpenURL: "open-url",
}

func (k Kind) String() string {
	if n, ok := kindNames[k]; ok {
		return n
	}
	return "unspecified"
}

// State is an operation's lifecycle state. Values match codefoundry.v1.GitOpState.
type State int

// Operation states.
const (
	StateUnspecified State = iota
	StateQueued
	StateRunning
	StateSucceeded
	StateFailed
)

// Finished reports whether s is a terminal state.
func (s State) Finished() bool { return s == StateSucceeded || s == StateFailed }

// Op is one operation and, once finished, its result. Ops are values: every event and
// snapshot carries a copy.
type Op struct {
	ID    string
	Kind  Kind
	State State
	// Title is a short display title, e.g. "Push alex/feature".
	Title string
	// WorktreePath is where the operation runs (symlinks resolved). Empty for open-url.
	WorktreePath string
	// RepoID is the registered repo containing WorktreePath, or empty.
	RepoID string
	// Branch when the operation was requested, if known.
	Branch     string
	QueuedAt   time.Time
	StartedAt  time.Time
	FinishedAt time.Time
	Duration   time.Duration
	// Summary is one line describing the outcome.
	Summary string
	// Output is every command run ("$ git ..."), with its output, capped at MaxOutput.
	Output string
	// URL is a URL the operation produced or opened (pull request).
	URL string
}

// OK reports whether the operation succeeded.
func (o Op) OK() bool { return o.State == StateSucceeded }

// EventType says what happened to an Op.
type EventType int

// Event types.
const (
	// Queued: the op waits behind another op on the same worktree.
	Queued EventType = iota + 1
	// Started: the op is running.
	Started
	// Finished: the op succeeded or failed.
	Finished
)

// Event is published on the bus as bus.Publish[gitops.Event] whenever an op changes
// state. One topic keeps an op's events in order for every subscriber.
type Event struct {
	Type EventType
	Op   Op
}

// Snapshot is the store's current state. It is immutable once published.
type Snapshot struct {
	// Ops are queued and running ops first (oldest first), then up to KeepFinished
	// finished ops, newest first.
	Ops []Op
}

// FetchOptions configures Store.Fetch.
type FetchOptions struct {
	WorktreePath string
}

// PullOptions configures Store.Pull.
type PullOptions struct {
	WorktreePath string
	// Rebase runs `git pull --rebase` instead of `--ff-only`.
	Rebase bool
}

// PushOptions configures Store.Push.
type PushOptions struct {
	WorktreePath string
	// ForceWithLease passes --force-with-lease.
	ForceWithLease bool
}

// CreatePROptions configures Store.CreatePR.
type CreatePROptions struct {
	WorktreePath string
	// Title defaults to the subject of HEAD's commit.
	Title string
	Body  string
	Draft bool
	// Base defaults to the GitHub repository's default branch (gh's default).
	Base string
}

// Store runs operations. The daemon's implementation is *Manager; a fake lives in
// gitops/gitopstest.
type Store interface {
	// Snapshot returns the current snapshot. It never returns nil.
	Snapshot() *Snapshot
	Fetch(ctx context.Context, o FetchOptions) (Op, error)
	Pull(ctx context.Context, o PullOptions) (Op, error)
	Push(ctx context.Context, o PushOptions) (Op, error)
	CreatePR(ctx context.Context, o CreatePROptions) (Op, error)
	OpenPR(ctx context.Context, worktreePath string) (Op, error)
	OpenEditor(ctx context.Context, worktreePath string) (Op, error)
	Reveal(ctx context.Context, worktreePath string) (Op, error)
	OpenURL(ctx context.Context, url string) (Op, error)
	// GitHubSlug returns the GitHub "owner/name" of the registered repo containing
	// worktreePath, else of repo repoID, else "".
	GitHubSlug(repoID, worktreePath string) string
}

// Repos is the part of the repo store gitops uses: the snapshot to map a path to its
// repo (id, slug, branch) and Refresh after operations that move refs. repo.Store
// satisfies it.
type Repos interface {
	Snapshot() *repo.Snapshot
	Refresh(ctx context.Context, id string) error
}

var _ Repos = repo.Store(nil)
