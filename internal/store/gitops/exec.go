package gitops

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Cmd is one process to run.
type Cmd struct {
	Dir  string
	Name string // executable: a path or a name looked up on PATH
	Args []string
	// Env is added to the scrubbed daemon environment (see childEnv).
	Env []string
}

// String renders the command for the op transcript ("git push -u origin x").
func (c Cmd) String() string {
	parts := make([]string, 0, 1+len(c.Args))
	parts = append(parts, displayName(c.Name))
	for _, a := range c.Args {
		parts = append(parts, quoteArg(a))
	}
	return strings.Join(parts, " ")
}

func displayName(name string) string {
	if i := strings.LastIndexByte(name, '/'); i >= 0 && !strings.Contains(name, " ") {
		return name[i+1:]
	}
	return quoteArg(name)
}

// quoteArg single-quotes a for display when it is empty or has shell metacharacters.
func quoteArg(a string) string {
	if a != "" && !strings.ContainsAny(a, " \t\n'\"\\$`!*?[]{}()<>|&;#~") {
		return a
	}
	return "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
}

// Result is what a process did.
type Result struct {
	Stdout string
	// Combined is stdout and stderr in the order they were written.
	Combined string
	// ExitCode is -1 when the process did not exit normally (not found, killed, timeout).
	ExitCode int
	// Err is nil on exit 0.
	Err error
}

// Runner runs processes. ExecRunner runs real ones; tests substitute fakes.
type Runner interface {
	Run(ctx context.Context, c Cmd) Result
}

// ExecRunner runs real processes: stdin is /dev/null, the child gets its own session
// (Setsid) so neither git nor ssh has a terminal to prompt on, and the environment is
// scrubbed and pinned (see childEnv).
type ExecRunner struct {
	// WaitDelay bounds how long Wait waits for output pipes held open by a grandchild
	// (ssh, or an editor the launcher forked) after the child exits. Default 2s.
	WaitDelay time.Duration
}

// scrubbedEnv redirect git away from the directory we point it at; a daemon started
// from inside a git hook would inherit them.
var scrubbedEnv = map[string]bool{
	"GIT_DIR": true, "GIT_WORK_TREE": true, "GIT_INDEX_FILE": true, "GIT_COMMON_DIR": true,
	"GIT_OBJECT_DIRECTORY": true, "GIT_ALTERNATE_OBJECT_DIRECTORIES": true,
	"GIT_NAMESPACE": true, "GIT_PREFIX": true,
}

// pinnedEnv keeps git and gh non-interactive and their output parseable. They replace
// any inherited value.
var pinnedEnv = []string{
	"GIT_TERMINAL_PROMPT=0", // never prompt for credentials
	"GIT_EDITOR=true",       // never open an editor (merge messages, rebase todo)
	"GIT_SEQUENCE_EDITOR=true",
	"GIT_MERGE_AUTOEDIT=no",
	"GIT_PAGER=cat",
	"LC_ALL=C", // untranslated messages, which the summaries match on
	"GH_PROMPT_DISABLED=1",
	"GH_NO_UPDATE_NOTIFIER=1",
	"GH_SPINNER_DISABLED=1",
	"GH_PAGER=cat",
	"NO_COLOR=1",
	"CLICOLOR=0",
}

// childEnv returns base minus scrubbedEnv and pinned names, plus pinnedEnv and extra.
func childEnv(base, extra []string) []string {
	pinned := make(map[string]bool, len(pinnedEnv)+len(extra))
	for _, kv := range append(append([]string(nil), pinnedEnv...), extra...) {
		name, _, _ := strings.Cut(kv, "=")
		pinned[name] = true
	}
	out := make([]string, 0, len(base)+len(pinnedEnv)+len(extra))
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		if !scrubbedEnv[name] && !pinned[name] {
			out = append(out, kv)
		}
	}
	out = append(out, pinnedEnv...)
	return append(out, extra...)
}

// lockedBuffer interleaves stdout and stderr writes from exec's copy goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

type teeWriter struct {
	own      *bytes.Buffer
	combined *lockedBuffer
}

func (t teeWriter) Write(p []byte) (int, error) {
	t.own.Write(p)
	return t.combined.Write(p)
}

// Run implements Runner. ctx should carry the operation's deadline.
func (r ExecRunner) Run(ctx context.Context, c Cmd) Result {
	cmd := exec.CommandContext(ctx, c.Name, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = childEnv(os.Environ(), c.Env)
	cmd.Stdin = nil // /dev/null
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = r.WaitDelay
	if cmd.WaitDelay <= 0 {
		cmd.WaitDelay = 2 * time.Second
	}
	var stdout, stderr bytes.Buffer
	var combined lockedBuffer
	cmd.Stdout = teeWriter{&stdout, &combined}
	cmd.Stderr = teeWriter{&stderr, &combined}
	err := cmd.Run()
	res := Result{Stdout: stdout.String(), Combined: combined.buf.String(), ExitCode: -1}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	// A grandchild (an editor the launcher started) may keep our pipes open; the
	// process itself exited cleanly, so that is success.
	if errors.Is(err, exec.ErrWaitDelay) && res.ExitCode == 0 {
		err = nil
	}
	if err != nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	res.Err = err
	return res
}
