package clone

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Runner runs a process and streams its output. ExecRunner runs real ones; tests use
// fakes.
type Runner interface {
	// Run runs name with args in dir. Every line it writes (stdout or stderr) goes to
	// line as it arrives. A non-zero exit returns a *ExitError carrying the last lines.
	Run(ctx context.Context, dir, name string, args []string, line func(Progress)) error
}

// Progress is one line of a clone's output.
type Progress struct {
	Line string
	// Transient lines ended in a carriage return (git's progress counters): the next
	// line replaces it on screen.
	Transient bool
}

// ExitError is a process that failed.
type ExitError struct {
	ExitCode int // -1 when it did not exit normally (not found, killed, timed out)
	// Tail is the last lines it wrote, newest last.
	Tail []string
	Err  error
}

func (e *ExitError) Error() string {
	if t := strings.Join(e.Tail, "\n"); t != "" {
		return t
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return fmt.Sprintf("exit %d", e.ExitCode)
}

func (e *ExitError) Unwrap() error { return e.Err }

// tailLines is how many final lines an ExitError keeps.
const tailLines = 8

// ExecRunner runs real processes: stdin is /dev/null, the child gets its own session
// (no terminal to prompt on), and gh and git are kept non-interactive.
type ExecRunner struct{}

// scrubbedEnv would redirect git away from the directory it clones into; a daemon
// started from a git hook would inherit them.
var scrubbedEnv = map[string]bool{
	"GIT_DIR": true, "GIT_WORK_TREE": true, "GIT_INDEX_FILE": true, "GIT_COMMON_DIR": true,
	"GIT_OBJECT_DIRECTORY": true, "GIT_ALTERNATE_OBJECT_DIRECTORIES": true,
	"GIT_NAMESPACE": true, "GIT_PREFIX": true,
}

// pinnedEnv replaces any inherited value.
var pinnedEnv = []string{
	"GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1",
	"GH_SPINNER_DISABLED=1", "GH_PAGER=cat", "GIT_PAGER=cat", "LC_ALL=C", "NO_COLOR=1", "CLICOLOR=0",
}

func childEnv(base []string) []string {
	pinned := map[string]bool{}
	for _, kv := range pinnedEnv {
		name, _, _ := strings.Cut(kv, "=")
		pinned[name] = true
	}
	out := make([]string, 0, len(base)+len(pinnedEnv))
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		if !scrubbedEnv[name] && !pinned[name] {
			out = append(out, kv)
		}
	}
	return append(out, pinnedEnv...)
}

// Run implements Runner. ctx carries the deadline.
func (ExecRunner) Run(ctx context.Context, dir, name string, args []string, line func(Progress)) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = childEnv(os.Environ())
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = 2 * time.Second
	w := &lineWriter{emit: line}
	cmd.Stdout, cmd.Stderr = w, w
	err := cmd.Run()
	w.flush()
	if err == nil {
		return nil
	}
	ee := &ExitError{ExitCode: -1, Tail: w.tail(), Err: err}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		ee.ExitCode = exitErr.ExitCode()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		ee.Err = fmt.Errorf("%w: %w", ctxErr, err)
	}
	return ee
}

// lineWriter splits output at '\n' and '\r' and emits each line. A line ended by '\r'
// is transient; "\r\n" re-emits it as final. It keeps the last final lines for errors.
// exec copies stdout and stderr on two goroutines, hence the mutex.
type lineWriter struct {
	mu        sync.Mutex
	emit      func(Progress)
	buf       []byte
	afterCR   bool   // the previous byte was '\r' and ended a line
	transient string // the last transient line, if nothing came after it
	last      []string
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, b := range p {
		switch b {
		case '\n':
			if w.afterCR && len(w.buf) == 0 {
				w.finish(w.transient, false)
			} else {
				w.finish(string(w.buf), false)
			}
			w.afterCR = false
		case '\r':
			w.finish(string(w.buf), true)
			w.afterCR = true
		default:
			w.buf = append(w.buf, b)
			w.afterCR = false
		}
	}
	return len(p), nil
}

// finish emits a line and resets the buffer. Called with mu held.
func (w *lineWriter) finish(text string, transient bool) {
	w.buf = w.buf[:0]
	text = strings.TrimRight(text, " \t")
	if text == "" {
		return
	}
	if transient {
		w.transient = text
	} else {
		w.transient = ""
		w.last = append(w.last, text)
		if len(w.last) > tailLines {
			w.last = w.last[len(w.last)-tailLines:]
		}
	}
	if w.emit != nil {
		w.emit(Progress{Line: text, Transient: transient})
	}
}

// flush emits a final line without a newline.
func (w *lineWriter) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) > 0 {
		w.finish(string(w.buf), false)
	}
}

// tail is the last final lines, plus a transient line nothing replaced.
func (w *lineWriter) tail() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := append([]string(nil), w.last...)
	if w.transient != "" {
		out = append(out, w.transient)
	}
	return out
}
