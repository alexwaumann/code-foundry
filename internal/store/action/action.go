// Package action is the action store. An action is a per-project command line the user
// defines (modelled on T3 Code's Actions): a name, an icon, the command, whether it runs
// in a terminal or in the background, and whether it runs when a new thread creates its
// worktree. Actions are persisted in SQLite (migration 0020); the store publishes an
// immutable Snapshot behind an atomic pointer and emits events on the bus.
//
// The store also runs actions. Every run executes `$SHELL -lc <command>` in a worktree
// with CODE_FOUNDRY_PROJECT_ROOT and CODE_FOUNDRY_WORKTREE (and CODE_FOUNDRY_THREAD for
// a thread's run) added to the daemon's environment, and belongs to an owner: a thread
// or a worktree, like a shell. Two runners:
//
//   - Terminal: a terminal in the terminal store labelled termlabel.ActionRun, so it
//     shows in its owner's bottom panel. It stays EXITED when it ends (the daemon's
//     reaper never removes an exited action terminal); the GUI closes it.
//   - Background: a child process of the daemon in its own process group, with its
//     combined output captured into a bounded buffer (the last 64 KiB).
//
// Runs live in memory only, newest RunHistory per project. Background runs are killed
// when the store closes (daemon shutdown), when their project is unregistered
// (RepoRemoved), and by KillRuns (the daemon calls it when a thread or worktree goes
// away). See docs/notes/actions-1-daemon.md.
package action

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
	ErrClosed             = errors.New("action store closed")
)

// Icons an action can show with. The first is the default.
const (
	IconPlay      = "play"
	IconTest      = "test"
	IconLint      = "lint"
	IconConfigure = "configure"
	IconBuild     = "build"
	IconDebug     = "debug"
)

// Icons lists every icon, the default first.
var Icons = []string{IconPlay, IconTest, IconLint, IconConfigure, IconBuild, IconDebug}

// Action is an immutable snapshot of one action.
type Action struct {
	ID               string // "a-" + 12 hex digits
	RepoID           string
	Name             string // unique within RepoID, ignoring case
	Command          string
	Icon             string // one of Icons
	InTerminal       bool
	OnWorktreeCreate bool
	Position         int // 0-based within RepoID
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Mode is how a run executes.
type Mode int

const (
	// ModeDefault (RunOptions only) is the action's own choice: InTerminal.
	ModeDefault Mode = iota
	// ModeTerminal runs in a terminal in the owner's bottom panel.
	ModeTerminal
	// ModeBackground runs as a child process with captured output.
	ModeBackground
)

func (m Mode) String() string {
	switch m {
	case ModeTerminal:
		return "terminal"
	case ModeBackground:
		return "background"
	default:
		return "default"
	}
}

// RunState is a run's lifecycle state.
type RunState int

const (
	RunRunning RunState = iota + 1
	RunExited
)

// Trigger is what started a run.
type Trigger int

const (
	// TriggerUser is ActionService.Run / action.run.
	TriggerUser Trigger = iota + 1
	// TriggerWorktreeCreate is a new thread's worktree (Action.OnWorktreeCreate).
	TriggerWorktreeCreate
)

// ExitUnknown is a terminal run's exit code when its terminal went away before its exit
// was seen.
const ExitUnknown = -1

// Run is one execution of an action.
type Run struct {
	ID         string // "r-" + 12 hex digits
	ActionID   string
	ActionName string // when it started
	Command    string // when it started
	RepoID     string
	ThreadID   string // empty for a worktree's run
	Worktree   string // cwd and CODE_FOUNDRY_WORKTREE
	Mode       Mode   // ModeTerminal or ModeBackground
	TerminalID string // ModeTerminal
	Trigger    Trigger
	State      RunState
	ExitCode   int // valid when State == RunExited; 128+signal when signalled
	StartedAt  time.Time
	FinishedAt time.Time
	// Output is a background run's combined output, its last OutputLimit bytes. Only
	// GetRun, Wait and Run fill it; snapshots and events never carry it.
	Output string
	// Truncated: the output began earlier than Output.
	Truncated bool
}

// Finished reports whether the run has ended.
func (r Run) Finished() bool { return r.State == RunExited }

// Snapshot is every action, by project then position, and the remembered runs, newest
// first, without their output. Never mutate it.
type Snapshot struct {
	Actions []Action
	Runs    []Run
}

// Action returns the action with id.
func (s *Snapshot) Action(id string) (Action, bool) {
	if s == nil {
		return Action{}, false
	}
	i := slices.IndexFunc(s.Actions, func(a Action) bool { return a.ID == id })
	if i < 0 {
		return Action{}, false
	}
	return s.Actions[i], true
}

// ForRepo returns repoID's actions in order (all actions when repoID is empty).
func (s *Snapshot) ForRepo(repoID string) []Action {
	if s == nil {
		return nil
	}
	if repoID == "" {
		return s.Actions
	}
	var out []Action
	for _, a := range s.Actions {
		if a.RepoID == repoID {
			out = append(out, a)
		}
	}
	return out
}

// Run returns the run with id (without output).
func (s *Snapshot) Run(id string) (Run, bool) {
	if s == nil {
		return Run{}, false
	}
	i := slices.IndexFunc(s.Runs, func(r Run) bool { return r.ID == id })
	if i < 0 {
		return Run{}, false
	}
	return s.Runs[i], true
}

// Resolve finds an action by id, else by name (ignoring case) within repoID.
func (s *Snapshot) Resolve(repoID, ref string) (Action, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return Action{}, &resolveError{kind: ErrInvalidArgument, msg: "an action id or name is required"}
	}
	if a, ok := s.Action(ref); ok {
		if repoID != "" && a.RepoID != repoID {
			return Action{}, &resolveError{kind: ErrFailedPrecondition, msg: "action " + a.Name + " (" + a.ID + ") belongs to another project"}
		}
		return a, nil
	}
	if repoID == "" {
		return Action{}, &resolveError{kind: ErrInvalidArgument, msg: "action " + ref + ": name a project to find it by name"}
	}
	for _, a := range s.ForRepo(repoID) {
		if strings.EqualFold(a.Name, ref) {
			return a, nil
		}
	}
	return Action{}, &resolveError{kind: ErrNotFound, msg: "no action " + quote(ref) + " in this project"}
}

func quote(s string) string { return `"` + s + `"` }

// resolveError carries an error class without repeating it in the message.
type resolveError struct {
	kind error
	msg  string
}

func (e *resolveError) Error() string { return e.msg }
func (e *resolveError) Unwrap() error { return e.kind }

// Event is published on the bus as bus.Publish[action.Event]. *Snapshot also implements
// Event so a consumer can merge a resync into the same stream.
type Event interface{ isActionEvent() }

// Updated carries an action's full state after a change.
type Updated struct{ Action Action }

// Removed is sent when an action is forgotten.
type Removed struct{ ID string }

// RunUpdated carries a run (without output) when it starts and when it finishes.
type RunUpdated struct{ Run Run }

// RunRemoved is sent when a run is forgotten (history cap, project unregistered).
type RunRemoved struct{ ID string }

// RunFinished follows a finished run's RunUpdated, once per run.
type RunFinished struct {
	RunID, ActionID, ActionName string
	RepoID, ThreadID            string
	TerminalID                  string
	Mode                        Mode
	Trigger                     Trigger
	ExitCode                    int
}

func (Updated) isActionEvent()     {}
func (Removed) isActionEvent()     {}
func (RunUpdated) isActionEvent()  {}
func (RunRemoved) isActionEvent()  {}
func (RunFinished) isActionEvent() {}
func (*Snapshot) isActionEvent()   {}

// CreateOptions configures Store.Create.
type CreateOptions struct {
	RepoID           string
	Name             string
	Command          string
	Icon             string // "": IconPlay
	InTerminal       bool
	OnWorktreeCreate bool
}

// UpdateOptions configures Store.Update; nil fields stay as they are.
type UpdateOptions struct {
	ID               string
	Name             *string
	Command          *string
	Icon             *string
	InTerminal       *bool
	OnWorktreeCreate *bool
	// Position moves the action to this 0-based index in its project (clamped).
	Position *int
}

// Owner is who a run belongs to: a thread (ThreadID set; RepoID and Worktree are the
// thread's) or a worktree.
type Owner struct {
	ThreadID string
	RepoID   string
	Worktree string
}

// RunOptions configures Store.Run.
type RunOptions struct {
	// Action is an action id, or its name within RepoID (default: the owner's project).
	Action string
	// ThreadID makes the thread the owner; it wins over Worktree.
	ThreadID string
	// Worktree is the owner when there is no thread: a registered worktree of the
	// action's project.
	Worktree string
	RepoID   string
	Mode     Mode
}

// Store is the action store API. *Manager implements it; actiontest.Fake is an
// in-memory fake.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	Create(ctx context.Context, o CreateOptions) (Action, error)
	Update(ctx context.Context, o UpdateOptions) (Action, error)
	Delete(ctx context.Context, id string) error
	// Run starts an action and returns the run once it has started.
	Run(ctx context.Context, o RunOptions) (Run, error)
	// GetRun returns a run with its output so far.
	GetRun(ctx context.Context, id string) (Run, error)
	// Wait returns a run with its output once it has finished, or ctx's error.
	Wait(ctx context.Context, id string) (Run, error)
}
