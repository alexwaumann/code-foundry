// Package childproc starts a long-lived child process the daemon talks to over its
// stdin and stdout: Claude (internal/claudestream) and plugins (internal/store/plugin).
//
// The child runs in its own process group, so Signal reaches the tools it started.
// stdout and stderr are os pipes the package owns, so the exit is noticed even when a
// grandchild keeps one open. The tail of stderr is kept for error messages; StderrLine
// also hands each line over as it arrives.
package childproc

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// StderrTail is how much of the process's stderr is kept.
const StderrTail = 16 << 10

// stderrSettle is how long Done waits for stderr to reach EOF after the process exited.
const stderrSettle = 200 * time.Millisecond

// maxStderrLine bounds one line handed to Spec.StderrLine; longer lines are cut.
const maxStderrLine = 16 << 10

// Spec describes a process to start.
type Spec struct {
	// Argv[0] is resolved against the PATH of the process's environment unless it has
	// a slash.
	Argv []string
	// BaseEnv is the environment Env is merged over; nil means the daemon's own
	// (os.Environ()).
	BaseEnv []string
	// Env entries ("KEY=VALUE") are merged over BaseEnv; a bare "KEY" removes it.
	Env []string
	Dir string
	// StderrLine, when set, receives every stderr line (without its newline) on the
	// stderr reader's goroutine. It must not block for long.
	StderrLine func(line string)
	// Name prefixes errors (default "childproc").
	Name string
}

// Process is a started child.
type Process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *os.File // read end

	done     chan struct{}
	exitCode int

	errMu      sync.Mutex
	stderr     []byte
	stderrDone chan struct{} // closed when the stderr reader saw EOF
}

// Start starts the process in its own process group and returns once it runs.
func Start(spec Spec) (*Process, error) {
	name := spec.Name
	if name == "" {
		name = "childproc"
	}
	if len(spec.Argv) == 0 || spec.Argv[0] == "" {
		return nil, fmt.Errorf("%s: empty argv", name)
	}
	base := spec.BaseEnv
	if base == nil {
		base = os.Environ()
	}
	env := MergeEnv(base, spec.Env)
	path, err := LookPath(spec.Argv[0], env)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	cmd := &exec.Cmd{Path: path, Args: append([]string(nil), spec.Argv...), Env: env, Dir: spec.Dir}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("%s: stdin: %w", name, err)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("%s: stdout pipe: %w", name, err)
	}
	er, ew, err := os.Pipe()
	if err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return nil, fmt.Errorf("%s: stderr pipe: %w", name, err)
	}
	cmd.Stdout, cmd.Stderr = pw, ew
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{pr, pw, er, ew} {
			_ = f.Close()
		}
		return nil, fmt.Errorf("%s: start %s: %w", name, spec.Argv[0], err)
	}
	_ = pw.Close()
	_ = ew.Close()
	p := &Process{cmd: cmd, stdin: stdin, stdout: pr, done: make(chan struct{}), stderrDone: make(chan struct{})}
	go p.readStderr(er, spec.StderrLine)
	go func() {
		err := cmd.Wait()
		p.exitCode = exitCode(cmd, err)
		// Let the stderr reader catch up first, so LastStderrLine after Done has the
		// line a crashing process wrote on its way out. Bounded: a grandchild holding
		// the pipe open must not delay the exit.
		select {
		case <-p.stderrDone:
		case <-time.After(stderrSettle):
		}
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

func (p *Process) readStderr(r *os.File, line func(string)) {
	defer close(p.stderrDone)
	defer func() { _ = r.Close() }()
	buf := make([]byte, 4096)
	var partial []byte
	emit := func(b []byte) {
		if line == nil {
			return
		}
		if len(b) > maxStderrLine {
			b = b[:maxStderrLine]
		}
		line(strings.TrimRight(string(b), "\r"))
	}
	for {
		n, err := r.Read(buf)
		if n > 0 {
			p.errMu.Lock()
			p.stderr = append(p.stderr, buf[:n]...)
			if over := len(p.stderr) - StderrTail; over > 0 {
				p.stderr = append(p.stderr[:0], p.stderr[over:]...)
			}
			p.errMu.Unlock()
			if line != nil {
				data := buf[:n]
				for {
					i := bytes.IndexByte(data, '\n')
					if i < 0 {
						if len(partial) < maxStderrLine {
							partial = append(partial, data...)
						}
						break
					}
					emit(append(partial, data[:i]...))
					partial = partial[:0]
					data = data[i+1:]
				}
			}
		}
		if err != nil {
			if len(partial) > 0 {
				emit(partial)
			}
			return
		}
	}
}

// Stdin is the process's stdin.
func (p *Process) Stdin() io.WriteCloser { return p.stdin }

// Stdout is the read end of the process's stdout.
func (p *Process) Stdout() *os.File { return p.stdout }

// Pid is the process id (and its process group's).
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

// LastStderrLine is the last non-empty stderr line.
func (p *Process) LastStderrLine() string {
	lines := strings.Split(strings.TrimSpace(p.Stderr()), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l
		}
	}
	return ""
}

// Signal sends sig to the process group (the process and the tools it started).
func (p *Process) Signal(sig syscall.Signal) error {
	select {
	case <-p.done:
		return nil
	default:
	}
	if err := syscall.Kill(-p.cmd.Process.Pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("childproc: signal %v: %w", sig, err)
	}
	return nil
}

// CloseOutput closes the read end of stdout, ending a reader if a grandchild kept the
// pipe open after the process exited.
func (p *Process) CloseOutput() { _ = p.stdout.Close() }

// MergeEnv applies overrides to base in order. "KEY=VALUE" sets KEY; a bare "KEY"
// removes it. Later entries win. (Same rule as the terminal store's.)
func MergeEnv(base []string, overrides []string) []string {
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

// LookPath resolves name against env's PATH (a Finder-launched daemon's own PATH may
// be minimal). Names with a slash are returned as is.
func LookPath(name string, env []string) (string, error) {
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
	return "", fmt.Errorf("%q not found in PATH", name)
}
