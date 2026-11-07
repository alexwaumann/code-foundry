package project

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Runner runs git. Every git invocation in this package goes through a Runner.
type Runner interface {
	// Run runs `git <args>` in dir and returns stdout. A non-zero exit returns a
	// *GitError carrying stderr.
	Run(ctx context.Context, dir string, args ...string) ([]byte, error)
}

// InputRunner is a Runner that can feed git's stdin. ExecRunner is one.
type InputRunner interface {
	RunInput(ctx context.Context, dir string, stdin []byte, args ...string) ([]byte, error)
}

// StreamRunner is a Runner that hands git's stdout to a writer as it arrives, for output too
// big to hold. ExecRunner is one; runFields takes any Runner.
type StreamRunner interface {
	RunStream(ctx context.Context, dir string, stdout io.Writer, args ...string) error
}

// fieldWriter keeps the first max bytes of each NUL-ended field of what it is given, and the
// NULs. What it holds is bounded by the number of fields, however long one is.
type fieldWriter struct {
	buf bytes.Buffer
	max int
	n   int // bytes kept of the field being written
}

// Write implements io.Writer.
func (w *fieldWriter) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		field, rest, ended := bytes.Cut(p, []byte{0})
		keep := min(len(field), w.max-w.n)
		w.buf.Write(field[:keep])
		w.n += keep
		if ended {
			w.buf.WriteByte(0)
			w.n = 0
		}
		p = rest
	}
	return total, nil
}

// runFields runs `git <args>` in dir through r and returns stdout, each NUL-ended field cut at
// max bytes as it arrives, so one huge field never sits in the daemon's memory.
func runFields(ctx context.Context, r Runner, dir string, limit int, args ...string) ([]byte, error) {
	w := &fieldWriter{max: limit}
	if sr, ok := r.(StreamRunner); ok {
		err := sr.RunStream(ctx, dir, w, args...)
		return w.buf.Bytes(), err
	}
	out, err := r.Run(ctx, dir, args...)
	_, _ = w.Write(out)
	return w.buf.Bytes(), err
}

// runInput runs `git <args>` in dir with stdin through r, which must be an InputRunner.
func runInput(ctx context.Context, r Runner, dir string, stdin []byte, args ...string) ([]byte, error) {
	ir, ok := r.(InputRunner)
	if !ok {
		return nil, fmt.Errorf("git %s: the runner cannot feed stdin", strings.Join(args, " "))
	}
	return ir.RunInput(ctx, dir, stdin, args...)
}

// GitError is a failed git invocation.
type GitError struct {
	Dir      string
	Args     []string
	ExitCode int // -1 if git did not exit normally (timeout, signal, not found)
	Stderr   string
	Err      error
}

func (e *GitError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" && e.Err != nil {
		msg = e.Err.Error()
	}
	return fmt.Sprintf("git %s (in %s): exit %d: %s", strings.Join(e.Args, " "), e.Dir, e.ExitCode, msg)
}

func (e *GitError) Unwrap() error { return e.Err }

// GitText is what git itself said in err (its stderr, trimmed), for showing a user; err's
// message when git said nothing or err is not git's.
func GitText(err error) string {
	var ge *GitError
	if errors.As(err, &ge) {
		if msg := strings.TrimSpace(ge.Stderr); msg != "" {
			return msg
		}
	}
	return err.Error()
}

// ExecRunner runs the git binary.
type ExecRunner struct {
	// Git is the binary; "git" (from PATH) when empty.
	Git string
	// Timeout bounds each invocation whose context has no deadline. Zero means
	// DefaultGitTimeout. Long operations (fetch, worktree add) pass their own deadline.
	Timeout time.Duration
}

// DefaultGitTimeout bounds a single git command that is not a fetch.
const DefaultGitTimeout = 30 * time.Second

// scrubbedEnv lists variables that would redirect git away from the directory we
// point it at. A daemon started from inside a git hook would inherit them.
var scrubbedEnv = []string{
	"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
}

// gitEnv returns the environment for git: the daemon's, minus scrubbedEnv, plus
// settings that keep git non-interactive, side-effect free, and parseable.
func gitEnv(base []string) []string {
	out := make([]string, 0, len(base)+4)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		drop := false
		for _, s := range scrubbedEnv {
			if name == s {
				drop = true
				break
			}
		}
		switch name {
		case "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS", "LC_ALL", "GIT_PAGER":
			drop = true
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return append(out,
		"GIT_TERMINAL_PROMPT=0", // never prompt for credentials
		// `git status` otherwise takes index.lock and rewrites the index to refresh
		// stat info. That write fires our own watcher and would loop forever.
		"GIT_OPTIONAL_LOCKS=0",
		"LC_ALL=C", // stable, untranslated output and messages
		"GIT_PAGER=cat",
	)
}

// guardedKey marks a context for guarded.
type guardedKey struct{}

// guarded makes every git command run under ctx start less of what a repository's config
// names: no fsmonitor hook; no lazy fetch, which would run core.sshCommand and reach the
// network from a read; and no index write from `git diff`, which GIT_OPTIONAL_LOCKS does
// not stop and which runs a post-index-change hook. For a read a caller asked for, of a
// checkout that may not be trusted. A context rather than arguments so that it holds for
// the commands shared with the rest of the store. Without the refresh `git diff` lists a
// file whose stat alone changed; parseCompareZ has that case. Filters are not covered;
// docs/notes/diff-viewer-1.md says why.
func guarded(ctx context.Context) context.Context {
	return context.WithValue(ctx, guardedKey{}, true)
}

// killGroup kills process group pgid. A group that is gone is os.ErrProcessDone, which
// tells exec.Cmd the process ended by itself. So is EPERM: macOS answers that for a group
// of zombies, and a group git started is the daemon's own to signal.
func killGroup(pgid int) error {
	err := syscall.Kill(-pgid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.EPERM) {
		return os.ErrProcessDone
	}
	return err
}

// Run implements Runner.
func (r ExecRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return r.RunInput(ctx, dir, nil, args...)
}

// RunInput implements InputRunner: Run with stdin (nil means /dev/null).
func (r ExecRunner) RunInput(ctx context.Context, dir string, stdin []byte, args ...string) ([]byte, error) {
	var stdout bytes.Buffer
	err := r.exec(ctx, dir, stdin, &stdout, args...)
	if err == nil {
		return stdout.Bytes(), nil
	}
	return stdout.Bytes(), err
}

// RunStream implements StreamRunner.
func (r ExecRunner) RunStream(ctx context.Context, dir string, stdout io.Writer, args ...string) error {
	return r.exec(ctx, dir, nil, stdout, args...)
}

// exec runs `git <args>` in dir, stdout going to stdout as it arrives.
func (r ExecRunner) exec(ctx context.Context, dir string, stdin []byte, stdout io.Writer, args ...string) error {
	if _, ok := ctx.Deadline(); !ok {
		timeout := r.Timeout
		if timeout <= 0 {
			timeout = DefaultGitTimeout
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	bin := r.Git
	if bin == "" {
		bin = "git"
	}
	env := gitEnv(os.Environ())
	if ctx.Value(guardedKey{}) != nil {
		args = append([]string{"-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"}, args...)
		env = append(env, "GIT_NO_LAZY_FETCH=1")
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = env
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	} // else /dev/null
	// A new thread has no controlling terminal, so neither git nor ssh can open
	// /dev/tty to prompt for a password or host key, even when the daemon runs in a
	// terminal with --dev.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// A cancelled git goes with what it started (ssh, a remote helper, a filter): Setsid
	// made it the leader of its own group, and they would outlive it otherwise.
	cmd.Cancel = func() error { return killGroup(cmd.Process.Pid) }
	// Children that left the group can still hold the pipes open.
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stdout = stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return nil
	}
	ge := &GitError{Dir: dir, Args: args, ExitCode: -1, Stderr: stderr.String(), Err: err}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		ge.ExitCode = exitErr.ExitCode()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		ge.Err = fmt.Errorf("%w: %w", ctxErr, err)
	}
	return ge
}
