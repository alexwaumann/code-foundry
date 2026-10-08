package repo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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

// Run implements Runner.
func (r ExecRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
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
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = gitEnv(os.Environ())
	cmd.Stdin = nil // /dev/null
	// A new session has no controlling terminal, so neither git nor ssh can open
	// /dev/tty to prompt for a password or host key, even when the daemon runs in a
	// terminal with --dev.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// Children such as ssh can outlive a killed git and hold the pipes open.
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), nil
	}
	ge := &GitError{Dir: dir, Args: args, ExitCode: -1, Stderr: stderr.String(), Err: err}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		ge.ExitCode = exitErr.ExitCode()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		ge.Err = fmt.Errorf("%w: %w", ctxErr, err)
	}
	return stdout.Bytes(), ge
}
