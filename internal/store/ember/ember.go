// Package ember is the store of Ember, the daemon's resident agent
// (docs/notes/ember-2-store.md): one resident thread (thread.Manager.EnsureResident,
// name "ember") that plans the user's work, creates worker threads with the orchestrate
// protocol, follows them through wakes and reports in its own chat. It never edits
// files: it runs only the code-foundry CLI and reads.
//
// The store owns:
//
//   - Ember's home, <home>/residents/ember: SOUL.md (who it is; user-editable), MEMORY.md
//     (long-lived facts, rewritten by consolidation), seed/ (BOARD.md, PROJECTS.md,
//     RECENT.md, rebuilt before every epoch), skills/ (the code-foundry-ember skill,
//     passed as --add-dir) and consolidation/ (the last inputs and outputs, for
//     debugging), with state.json (epoch start, consolidation, the worker counter);
//   - the resident thread's lifecycle: made and configured while ember.enabled is on
//     (model, effort and the permission rules from the settings), stopped when it goes
//     off;
//   - epochs: once Ember is idle after a turn and its context passed
//     ember.epoch_context_tokens, or its epoch is older than ember.epoch_max_hours, the
//     store consolidates its memory with a one-shot claude -p, rebuilds the seed and
//     reseeds the thread (thread.Manager.Reseed): the next message starts a fresh
//     session that begins with the seed, while the conversation stays in thread_items;
//   - the task board (ember_tasks): Ember's units of work, each optionally owned by a
//     worker thread whose status and report are derived when the board is read;
//   - the worker defaults: a thread Ember (or a thread below it) creates without a model
//     runs on the next of ember.worker_models (round robin) at ember.worker_effort.
//
// It publishes a Snapshot behind an atomic pointer and Changed on the bus. It never
// imports internal/api.
package ember

import (
	"errors"
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Name is Ember's resident name (Thread.ResidentName).
const Name = "ember"

// DisplayName is the resident thread's name.
const DisplayName = "Ember"

// Errors returned by Store methods, wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
	ErrClosed             = errors.New("ember store closed")
)

// State is a task's state on the board.
type State int

// Task states. Values mirror codefoundry.v1.EmberTaskState.
const (
	StateUnspecified State = iota
	StateTodo
	StateDoing
	// StateBlocked: waiting on something. The store sets it when the task's worker
	// reports failed or blocked while the task is doing.
	StateBlocked
	StateDone
	StateCancelled
)

// stateNames are the states' names, as stored and as the CLI takes them.
var stateNames = map[State]string{
	StateTodo: "todo", StateDoing: "doing", StateBlocked: "blocked", StateDone: "done", StateCancelled: "cancelled",
}

// StateNames are the states' names in board order.
var StateNames = []string{"todo", "doing", "blocked", "done", "cancelled"}

func (s State) String() string {
	if n, ok := stateNames[s]; ok {
		return n
	}
	return "unspecified"
}

// ParseState is the state named name.
func ParseState(name string) (State, error) {
	for s, n := range stateNames {
		if n == name {
			return s, nil
		}
	}
	return StateUnspecified, fmt.Errorf("%w: task state %q: want todo, doing, blocked, done or cancelled", ErrInvalidArgument, name)
}

// Open reports whether a task in s still needs something: todo, doing or blocked.
func (s State) Open() bool { return s == StateTodo || s == StateDoing || s == StateBlocked }

// Task is one unit of Ember's work. Values: never mutate one from a snapshot.
type Task struct {
	// ID is "t-" and 8 hex digits.
	ID     string
	Title  string
	Detail string
	State  State
	// ParentID is the task this one is part of; one level only (a parent has none).
	ParentID string
	// ThreadID is the worker thread that owns the task; "" for none.
	ThreadID string
	// Outcome is what came of it (done) or why it stopped (blocked, cancelled).
	Outcome   string
	Position  int
	CreatedAt time.Time
	UpdatedAt time.Time
	// DoneAt is when it became done; zero otherwise.
	DoneAt time.Time
	// Thread is the worker thread's progress, derived when the snapshot is built; nil
	// without ThreadID.
	Thread *TaskThread
}

// TaskThread is a task's worker thread as the board shows it.
type TaskThread struct {
	ID string
	// Name is the thread's name now; "" once it was removed.
	Name           string
	State          thread.State
	Status         thread.Status
	StatusReason   string
	Report         thread.Report
	CreatedAt      time.Time
	LastActivityAt time.Time
	Archived       bool
	// Removed: the thread is gone; the task keeps its id.
	Removed bool
	// Team is the threads below it (team.go), for an open task only; zero otherwise.
	Team Team
}

// Counts are the tasks per state.
type Counts struct {
	Todo, Doing, Blocked, Done, Cancelled int
}

// Status is Ember's state.
type Status struct {
	// Enabled is ember.enabled.
	Enabled bool
	// ThreadID is the resident thread; "" until Ember was first enabled.
	ThreadID string
	// Epoch is the resident thread's epoch (Thread.Epoch); EpochStartedAt when it began.
	Epoch          int
	EpochStartedAt time.Time
	// ContextTokens is the current session's context size (Thread.ContextTokens);
	// EpochContextTokens the ember.epoch_context_tokens limit.
	ContextTokens      int64
	EpochContextTokens int64
	// Consolidating: an epoch boundary runs (consolidation, then the reseed).
	Consolidating bool
	// LastConsolidatedAt is when the last consolidation finished; LastConsolidationError
	// its error ("" when it went well: MEMORY.md was replaced).
	LastConsolidatedAt     time.Time
	LastConsolidationError string
	// LastConsolidationUsage is the last consolidation call's usage and cost (zero
	// before one); ConsolidationUsageTotal sums every call's (consolidate.go).
	LastConsolidationUsage  ConsolidationUsage
	ConsolidationUsageTotal ConsolidationUsage
	Counts                  Counts
}

// Snapshot is the published state: Ember's status and every task in board order
// (position, then creation). Never mutate it.
type Snapshot struct {
	Status Status
	Tasks  []Task
}

// Task returns the task with id.
func (s *Snapshot) Task(id string) (Task, bool) {
	if s == nil {
		return Task{}, false
	}
	for _, t := range s.Tasks {
		if t.ID == id {
			return t, true
		}
	}
	return Task{}, false
}

// Changed is published on the bus after every change to the snapshot: a task, Ember's
// status, or a task's worker thread.
type Changed struct {
	Snapshot *Snapshot
}
