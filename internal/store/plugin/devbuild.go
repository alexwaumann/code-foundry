package plugin

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/childproc"
)

// The build `plugin dev --watch` runs (devwatch.go) after an edit, before restarting the
// plugin.

const (
	// DefaultDevBuild is the build command when `plugin dev --build` names none.
	DefaultDevBuild = "make build"
	// DefaultDevBuildTimeout bounds one build.
	DefaultDevBuildTimeout = 5 * time.Minute
	// devBuildTail is how many of a failed build's last lines its error quotes.
	devBuildTail = 20
)

// devBuildCommand is the command a row builds with.
func devBuildCommand(build string) string {
	if strings.TrimSpace(build) == "" {
		return DefaultDevBuild
	}
	return build
}

// devBuildResult is how one build ended.
type devBuildResult struct {
	exit     int // the exit status; -1 when killed or not started
	timedOut bool
	err      error // it could not start
	took     time.Duration
	tail     []string // the last devBuildTail lines of its output
}

func (r devBuildResult) ok() bool { return r.err == nil && !r.timedOut && r.exit == 0 }

// summary is the result in words for the log and for errors.
func (r devBuildResult) summary(timeout time.Duration) string {
	switch {
	case r.err != nil:
		return "build failed: " + r.err.Error()
	case r.timedOut:
		return "build failed: timed out after " + shortDuration(timeout)
	}
	return fmt.Sprintf("build failed (exit %d)", r.exit)
}

// runDevBuild runs build with $SHELL -lc in dir, in its own process group, with the
// plugin's minimal environment (never the API's: the build has the plugin's privileges,
// not the daemon's), until it exits, ctx ends or the timeout passes. Every output line
// goes to the plugin's log as source "build".
func (m *Manager) runDevBuild(ctx context.Context, dir, build string, logs *logBuffer) devBuildResult {
	start := m.opts.Now()
	var tailMu sync.Mutex
	var tail []string
	line := func(l string) {
		logs.add("build", "", l)
		tailMu.Lock()
		tail = append(tail, l)
		if len(tail) > devBuildTail {
			tail = tail[len(tail)-devBuildTail:]
		}
		tailMu.Unlock()
	}
	res := devBuildResult{exit: -1}
	proc, err := childproc.Start(childproc.Spec{
		Argv: []string{m.opts.Shell, "-lc", build}, BaseEnv: m.minimalEnviron(), Dir: dir,
		Name: "build", StderrLine: line,
	})
	if err != nil {
		res.err = err
		line(err.Error())
		res.tail = tail
		return res
	}
	_ = proc.Stdin().Close()
	stdout := make(chan struct{})
	go func() {
		defer close(stdout)
		sc := bufio.NewScanner(proc.Stdout())
		sc.Buffer(make([]byte, 0, 64<<10), maxLogLine)
		for sc.Scan() {
			line(sc.Text())
		}
	}()
	timer := time.NewTimer(m.opts.DevBuildTimeout)
	defer timer.Stop()
	select {
	case <-proc.Done():
	case <-timer.C:
		res.timedOut = true
	case <-ctx.Done():
		res.err = context.Cause(ctx)
	}
	// Whatever the build left running in its group goes too.
	_, _ = proc.SignalGroup(syscall.SIGKILL)
	<-proc.Done()
	select {
	case <-stdout:
	case <-time.After(time.Second):
		proc.CloseOutput() // a grandchild kept stdout open
		<-stdout
	}
	if res.err == nil && !res.timedOut {
		res.exit = proc.ExitCode()
	}
	res.took = m.opts.Now().Sub(start)
	tailMu.Lock()
	res.tail = slices.Clone(tail)
	tailMu.Unlock()
	return res
}

// errDevBuildFailed is DevSettle's and the first build's error.
var errDevBuildFailed = errors.New("build failed")

// minimalEnviron is the daemon's variables a plugin inherits (minimalEnv).
func (m *Manager) minimalEnviron() []string {
	var env []string
	for _, kv := range m.opts.Environ {
		k, _, _ := strings.Cut(kv, "=")
		if isMinimalEnv(k) {
			env = append(env, kv)
		}
	}
	return env
}
