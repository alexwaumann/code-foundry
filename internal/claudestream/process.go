package claudestream

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// StderrTail is how much of the process's stderr is kept for LastError.
const StderrTail = 16 << 10

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

// Process is a started CLI with its Conn. Stdout and stderr are read through os
// pipes the package owns, so the exit is noticed even if a grandchild keeps one open.
type Process struct {
	cmd  *exec.Cmd
	conn *Conn
	pr   *os.File // stdout read end

	done     chan struct{}
	exitCode int
	waitErr  error

	errMu  sync.Mutex
	stderr []byte
}

// Start starts the process in its own process group and returns once it runs.
func Start(spec Spec) (*Process, error) {
	if len(spec.Argv) == 0 || spec.Argv[0] == "" {
		return nil, errors.New("claudestream: empty argv")
	}
	env := mergeEnv(os.Environ(), spec.Env)
	path, err := lookPath(spec.Argv[0], env)
	if err != nil {
		return nil, err
	}
	cmd := &exec.Cmd{Path: path, Args: append([]string(nil), spec.Argv...), Env: env, Dir: spec.Dir}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("claudestream: stdin: %w", err)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("claudestream: stdout pipe: %w", err)
	}
	er, ew, err := os.Pipe()
	if err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return nil, fmt.Errorf("claudestream: stderr pipe: %w", err)
	}
	cmd.Stdout, cmd.Stderr = pw, ew
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{pr, pw, er, ew} {
			_ = f.Close()
		}
		return nil, fmt.Errorf("claudestream: start %s: %w", spec.Argv[0], err)
	}
	_ = pw.Close()
	_ = ew.Close()
	p := &Process{cmd: cmd, pr: pr, done: make(chan struct{})}
	p.conn = NewConn(pr, stdin, spec.Conn)
	go p.readStderr(er)
	go func() {
		err := cmd.Wait()
		p.waitErr = err
		p.exitCode = exitCode(cmd, err)
		close(p.done)
	}()
	return p, nil
}

func exitCode(cmd *exec.Cmd, err error) int {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode() // -1 when killed by a signal
	}
	if err != nil {
		return -1
	}
	return 0
}

func (p *Process) readStderr(r *os.File) {
	defer func() { _ = r.Close() }()
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			p.errMu.Lock()
			p.stderr = append(p.stderr, buf[:n]...)
			if over := len(p.stderr) - StderrTail; over > 0 {
				p.stderr = append(p.stderr[:0], p.stderr[over:]...)
			}
			p.errMu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// Conn is the protocol connection.
func (p *Process) Conn() *Conn { return p.conn }

// Pid is the CLI's process id.
func (p *Process) Pid() int { return p.cmd.Process.Pid }

// Done is closed when the process has exited.
func (p *Process) Done() <-chan struct{} { return p.done }

// ExitCode is the exit status (-1 when killed by a signal). Valid after Done.
func (p *Process) ExitCode() int { return p.exitCode }

// Stderr returns the tail of what the process wrote to stderr.
func (p *Process) Stderr() string {
	p.errMu.Lock()
	defer p.errMu.Unlock()
	return string(p.stderr)
}

// LastStderrLine is the last non-empty stderr line, for a thread's LastError.
func (p *Process) LastStderrLine() string {
	lines := strings.Split(strings.TrimSpace(p.Stderr()), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l
		}
	}
	return ""
}

// Signal sends sig to the process group (the CLI and the tools it started).
func (p *Process) Signal(sig syscall.Signal) error {
	select {
	case <-p.done:
		return nil
	default:
	}
	if err := syscall.Kill(-p.cmd.Process.Pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("claudestream: signal %v: %w", sig, err)
	}
	return nil
}

// CloseOutput closes the read end of stdout, ending Events if a grandchild kept the
// pipe open after the process exited.
func (p *Process) CloseOutput() { _ = p.pr.Close() }

// mergeEnv applies overrides to base in order. "KEY=VALUE" sets KEY; a bare "KEY"
// removes it. Later entries win. (Same rule as the terminal store's.)
func mergeEnv(base []string, overrides []string) []string {
	idx := map[string]int{}
	out := make([]string, 0, len(base)+len(overrides))
	set := func(kv string) {
		key, _, hasEq := strings.Cut(kv, "=")
		if key == "" {
			return
		}
		i, seen := idx[key]
		switch {
		case !hasEq && seen:
			out[i] = ""
			delete(idx, key)
		case !hasEq:
		case seen:
			out[i] = kv
		default:
			idx[key] = len(out)
			out = append(out, kv)
		}
	}
	for _, kv := range base {
		set(kv)
	}
	for _, kv := range overrides {
		set(kv)
	}
	res := out[:0]
	for _, kv := range out {
		if kv != "" {
			res = append(res, kv)
		}
	}
	return res
}

// lookPath resolves name against env's PATH (a Finder-launched daemon's own PATH may
// be minimal). Names with a slash are returned as is.
func lookPath(name string, env []string) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	path := ""
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == "PATH" {
			path = v
			break
		}
	}
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			dir = "."
		}
		p := filepath.Join(dir, name)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("claudestream: %q not found in PATH", name)
}
