package claudestream

import (
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/childproc"
)

// StderrTail is how much of the process's stderr is kept for LastError.
const StderrTail = childproc.StderrTail

// Spec describes a CLI process to start.
type Spec struct {
	// Argv[0] is resolved against the PATH of the process's environment.
	Argv []string
	// Env entries ("KEY=VALUE") are merged over the daemon's environment; a bare
	// "KEY" removes it.
	Env []string
	Dir string
	// Conn configures the protocol connection.
	Conn Options
}

// Process is a started CLI with its Conn. The process itself (process group, pipes,
// stderr tail) is internal/childproc's.
type Process struct {
	proc *childproc.Process
	conn *Conn
}

// Start starts the process in its own process group and returns once it runs.
func Start(spec Spec) (*Process, error) {
	proc, err := childproc.Start(childproc.Spec{Argv: spec.Argv, Env: spec.Env, Dir: spec.Dir, Name: "claudestream"})
	if err != nil {
		return nil, err
	}
	return &Process{proc: proc, conn: NewConn(proc.Stdout(), proc.Stdin(), spec.Conn)}, nil
}

// Conn is the protocol connection.
func (p *Process) Conn() *Conn { return p.conn }

// Pid is the CLI's process id.
func (p *Process) Pid() int { return p.proc.Pid() }

// Done is closed when the process has exited.
func (p *Process) Done() <-chan struct{} { return p.proc.Done() }

// ExitCode is the exit status (-1 when killed by a signal). Valid after Done.
func (p *Process) ExitCode() int { return p.proc.ExitCode() }

// Stderr returns the tail of what the process wrote to stderr.
func (p *Process) Stderr() string { return p.proc.Stderr() }

// LastStderrLine is the last non-empty stderr line, for a thread's LastError.
func (p *Process) LastStderrLine() string { return p.proc.LastStderrLine() }

// Signal sends sig to the process group (the CLI and the tools it started).
func (p *Process) Signal(sig syscall.Signal) error { return p.proc.Signal(sig) }

// CloseOutput closes the read end of stdout, ending Events if a grandchild kept the
// pipe open after the process exited.
func (p *Process) CloseOutput() { p.proc.CloseOutput() }
