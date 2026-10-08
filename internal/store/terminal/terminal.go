// Package terminal owns PTY-backed terminals. Each terminal is an actor goroutine that
// owns the PTY master, a libghostty-vt emulator, and the attached subscribers. Output is
// fed to the emulator and fanned out to subscribers; Attach starts with a VT snapshot
// of the emulator (see snapshot.go) followed by live output.
//
// The package is program-agnostic: it spawns argv/env/cwd. Knowing that a terminal runs
// Claude is the session store's job.
package terminal

import (
	"context"
	"errors"
	"time"
)

// Errors returned by Store methods. Match with errors.Is.
var (
	ErrNotFound       = errors.New("terminal not found")
	ErrInvalidSpec    = errors.New("invalid terminal spec")
	ErrRunning        = errors.New("terminal is still running")
	ErrExited         = errors.New("terminal has exited")
	ErrInputBacklog   = errors.New("terminal input backlog full")
	ErrClosed         = errors.New("terminal store closed")
	ErrSlowSubscriber = errors.New("attach subscriber too slow; re-attach for a fresh snapshot")
)

// State is a terminal's lifecycle state.
type State int

// States.
const (
	StateRunning State = iota + 1
	StateExited
)

func (s State) String() string {
	switch s {
	case StateRunning:
		return "running"
	case StateExited:
		return "exited"
	default:
		return "unknown"
	}
}

// Spec describes a terminal to create.
type Spec struct {
	// Argv is the program and its arguments. Argv[0] without a slash is resolved
	// against PATH from the merged environment.
	Argv []string
	// Cwd is the working directory. Empty means the daemon user's home directory.
	Cwd string
	// Env entries "KEY=VALUE" are merged over the daemon's environment. A bare "KEY"
	// (no '=') removes KEY from the inherited environment.
	Env []string
	// Cols and Rows are the initial size; zero means 80x24.
	Cols, Rows uint16
	// Labels are opaque to this package (e.g. the session store's session id).
	Labels map[string]string
}

// Terminal is an immutable snapshot of a terminal's metadata. Do not mutate Argv or
// Labels; they are shared between snapshots.
type Terminal struct {
	ID        string
	Argv      []string
	Cwd       string
	Pid       int
	Cols      uint16
	Rows      uint16
	Title     string
	State     State
	ExitCode  int // valid when State == StateExited; 128+signal if killed by a signal
	StartedAt time.Time
	ExitedAt  time.Time
	AltScreen bool
	Labels    map[string]string
}

// Snapshot reproduces a terminal's screen when written to a freshly reset emulator of
// size Cols x Rows. See snapshot.go for the exact format.
type Snapshot struct {
	Data      []byte
	Cols      uint16
	Rows      uint16
	AltScreen bool
}

// AttachEvent is one event on an Attach channel. Exactly one field is set.
//
// The first event is always Snapshot. Output chunks follow in PTY order, interleaved
// with Resized at the exact stream position the resize took effect. Exited is sent once
// when the process ends; the channel then stays open (the final screen remains
// attachable) until the terminal is removed or the caller's context ends, at which
// point the channel is closed. Dropped is sent, and the channel closed, when the
// subscriber fell too far behind; re-attach to resynchronize.
type AttachEvent struct {
	Snapshot *Snapshot
	Output   []byte // shared, read-only
	Resized  *Size
	Exited   *Exit
	Dropped  bool
}

// Size is a terminal size in cells.
type Size struct{ Cols, Rows uint16 }

// Exit describes how a process ended.
type Exit struct{ Code int }

// Bus events published by the store.

// TerminalUpdated is published on create and whenever title, size, alt screen, or
// state change. Title and alt-screen changes are throttled per terminal.
type TerminalUpdated struct{ Terminal Terminal }

// TerminalRemoved is published when a terminal is removed.
type TerminalRemoved struct{ ID string }

// Event is one item on a Watch channel. Exactly one field is set.
type Event struct {
	Updated   *Terminal
	RemovedID string
}

// Store is the terminal store API. *Manager implements it; terminaltest.Fake is an
// in-memory fake.
type Store interface {
	Create(ctx context.Context, spec Spec) (Terminal, error)
	List(ctx context.Context) []Terminal
	Get(ctx context.Context, id string) (Terminal, error)
	Write(ctx context.Context, id string, data []byte) error
	Resize(ctx context.Context, id string, cols, rows uint16) error
	// Kill sends SIGHUP to the process group, then SIGKILL after a grace period. It
	// returns once the first signal is sent. Killing an exited terminal is a no-op.
	Kill(ctx context.Context, id string) error
	// Remove forgets an exited terminal, closing its Attach channels. It fails with
	// ErrRunning if the process is still running.
	Remove(ctx context.Context, id string) error
	// Attach subscribes to one terminal. The channel is closed when ctx ends, the
	// terminal is removed, or the subscriber is dropped (see AttachEvent).
	Attach(ctx context.Context, id string) (<-chan AttachEvent, error)
	// Watch streams TerminalUpdated/TerminalRemoved for all terminals until ctx ends.
	// It does not replay current state; call List after subscribing.
	Watch(ctx context.Context) (<-chan Event, error)
}
