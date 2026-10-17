package action

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// waitDelay bounds how long a finished background run's output pipes may stay open
// (a process it left running in the background holds them) before they are closed.
const waitDelay = 2 * time.Second

// terminalGonePoll is how often Wait checks that a terminal run's terminal still
// exists, for an exit the observer never saw (the terminal store force-removed it).
const terminalGonePoll = time.Second

// runRec is one run's mutable state. run is guarded by Manager.mu.
type runRec struct {
	run Run
	out *tailBuffer // background runs
	pid int         // background runs: the process (group leader)
	// started is closed once the run is registered and published; finish waits for it.
	started chan struct{}
	// done is closed when the run has finished.
	done    chan struct{}
	killing bool
}

// public returns the run, with its output when withOutput.
func (r *runRec) public(withOutput bool) Run {
	out := r.run
	if withOutput && r.out != nil {
		out.Output, out.Truncated = r.out.text()
	}
	return out
}

// kill ends a running background run: SIGTERM to its process group, SIGKILL to the
// group after grace. The run finishing first is not enough to skip the SIGKILL: the
// shell can die of the SIGTERM at once and leave a group member that ignores it, so
// only a group that is gone entirely is spared. wg (the Manager's) tracks the
// escalation so Close waits for it; adding to it is safe because a running run's
// process waiter still holds it. Callers hold Manager.mu.
func (r *runRec) kill(grace time.Duration, wg *sync.WaitGroup) {
	if r.run.Mode != ModeBackground || r.run.State != RunRunning || r.pid <= 0 || r.killing {
		return
	}
	r.killing = true
	pgid, done := r.pid, r.done
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTimer(grace)
		defer t.Stop()
		select {
		case <-done:
			if syscall.Kill(-pgid, 0) != nil {
				return // the whole group is gone
			}
			<-t.C
		case <-t.C:
		}
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}()
}

// Run implements Store.
func (m *Manager) Run(ctx context.Context, o RunOptions) (Run, error) {
	owner, err := m.owner(o.ThreadID, o.Worktree, o.ProjectID)
	if err != nil {
		return Run{}, err
	}
	a, err := m.Snapshot().Resolve(owner.ProjectID, o.Action)
	if err != nil {
		return Run{}, err
	}
	return m.start(ctx, a, owner, o.Mode, TriggerUser)
}

// owner resolves a run's owner: the thread threadID, else the registered worktree at
// worktree (in projectID when given).
func (m *Manager) owner(threadID, worktree, projectID string) (Owner, error) {
	switch {
	case threadID != "":
		if m.opts.Thread == nil {
			return Owner{}, fmt.Errorf("%w: thread %s", ErrNotFound, threadID)
		}
		ow, ok := m.opts.Thread(threadID)
		if !ok {
			return Owner{}, fmt.Errorf("%w: thread %s", ErrNotFound, threadID)
		}
		if ow.ProjectID == "" {
			return Owner{}, fmt.Errorf("%w: thread %s has no project; actions belong to a project", ErrFailedPrecondition, threadID)
		}
		if projectID != "" && projectID != ow.ProjectID {
			return Owner{}, fmt.Errorf("%w: thread %s is in project %s, not %s", ErrInvalidArgument, threadID, ow.ProjectID, projectID)
		}
		ow.ThreadID = threadID
		return ow, nil
	case worktree != "":
		for _, r := range m.opts.Projects.Snapshot().Projects {
			if projectID != "" && r.ID != projectID {
				continue
			}
			if slices.ContainsFunc(r.Worktrees, func(w project.Worktree) bool { return w.Path == worktree }) {
				return Owner{ProjectID: r.ID, Worktree: worktree}, nil
			}
		}
		return Owner{}, fmt.Errorf("%w: %s is not a worktree of a registered project", ErrInvalidArgument, worktree)
	default:
		return Owner{}, fmt.Errorf("%w: a run needs a thread or a worktree", ErrInvalidArgument)
	}
}

// start runs a for owner and returns the run once it has started.
func (m *Manager) start(ctx context.Context, a Action, owner Owner, mode Mode, trigger Trigger) (Run, error) {
	r, ok := m.opts.Projects.Snapshot().Project(owner.ProjectID)
	if !ok {
		return Run{}, fmt.Errorf("%w: project %s is not registered", ErrNotFound, owner.ProjectID)
	}
	if mode == ModeDefault {
		mode = ModeBackground
		if a.InTerminal {
			mode = ModeTerminal
		}
	}
	if mode == ModeTerminal && m.opts.Terminals == nil {
		return Run{}, fmt.Errorf("%w: terminal runs are not available", ErrFailedPrecondition)
	}
	id, err := newID("r-")
	if err != nil {
		return Run{}, err
	}
	rec := &runRec{
		run: Run{
			ID: id, ActionID: a.ID, ActionName: a.Name, Command: a.Command,
			ProjectID: owner.ProjectID, ThreadID: owner.ThreadID, Worktree: owner.Worktree,
			Mode: mode, Trigger: trigger, State: RunRunning, StartedAt: m.opts.Now(),
		},
		started: make(chan struct{}),
		done:    make(chan struct{}),
	}
	env := append(slices.Clip(m.opts.Env), runEnv(r.Path, owner)...)

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Run{}, ErrClosed
	}
	if mode == ModeBackground {
		m.wg.Add(1) // the process waiter
	}
	m.mu.Unlock()

	switch mode {
	case ModeTerminal:
		t, err := m.opts.Terminals.Create(ctx, terminal.Spec{
			Argv: []string{m.opts.Shell, "-lc", a.Command}, Cwd: owner.Worktree, Env: env,
			Labels:   termlabel.ActionTerminal(owner.ThreadID, owner.ProjectID, owner.Worktree, a.ID, a.Name, id),
			Observer: m.observer(rec),
		})
		if err != nil {
			return Run{}, fmt.Errorf("run action %s in a terminal: %w", a.Name, err)
		}
		rec.run.TerminalID = t.ID
	case ModeBackground:
		if err := m.startProcess(rec, env); err != nil {
			m.wg.Done()
			return Run{}, err
		}
	}

	m.mu.Lock()
	m.runs[id] = rec
	if m.closed {
		rec.kill(m.opts.KillGrace, &m.wg) // Close ran while it started
	}
	dropped := m.trim(owner.ProjectID)
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, RunUpdated{Run: rec.public(false)})
	for _, d := range dropped {
		bus.Publish[Event](m.opts.Bus, RunRemoved{ID: d})
	}
	close(rec.started)
	out := rec.public(true)
	m.mu.Unlock()
	m.log.Info("action run started", "run", id, "action", a.ID, "name", a.Name, "mode", mode.String(),
		"thread", owner.ThreadID, "worktree", owner.Worktree, "terminal", out.TerminalID)
	return out, nil
}

// runEnv is what a run gets on top of the daemon's environment.
func runEnv(root string, o Owner) []string {
	env := []string{paths.EnvProjectRoot + "=" + root, paths.EnvWorktree + "=" + o.Worktree}
	if o.ThreadID != "" {
		env = append(env, paths.EnvThread+"="+o.ThreadID)
	}
	return env
}

// observer finishes a terminal run when its terminal exits. It runs on the terminal's
// actor goroutine, so it only hands the exit off.
func (m *Manager) observer(rec *runRec) terminal.Observer {
	return func(_ string, ev terminal.ObserveEvent) {
		if ev.Exited != nil {
			go m.finish(rec, ev.Exited.Code)
		}
	}
}

// startProcess starts a background run: `<shell> -lc <command>` in its own process
// group, stdin from /dev/null, stdout and stderr into the run's tail buffer.
func (m *Manager) startProcess(rec *runRec, env []string) error {
	rec.out = newTailBuffer(m.opts.OutputLimit)
	cmd := exec.Command(m.opts.Shell, "-lc", rec.run.Command)
	cmd.Dir = rec.run.Worktree
	cmd.Env = mergeEnv(os.Environ(), env)
	cmd.Stdout, cmd.Stderr = rec.out, rec.out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = waitDelay
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("run action %s: %w", rec.run.ActionName, err)
	}
	rec.pid = cmd.Process.Pid
	go func() {
		defer m.wg.Done()
		err := cmd.Wait()
		if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
			var ee *exec.ExitError
			if !errors.As(err, &ee) {
				m.log.Warn("action run: wait", "run", rec.run.ID, "err", err)
			}
		}
		m.finish(rec, exitCode(cmd.ProcessState))
	}()
	return nil
}

// exitCode is a process's exit status, 128+signal when a signal ended it, -1 unknown.
func exitCode(ps *os.ProcessState) int {
	if ps == nil {
		return ExitUnknown
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return ps.ExitCode()
}

// finish records a run's end once, publishes it, and wakes its waiters.
func (m *Manager) finish(rec *runRec, code int) {
	select {
	case <-rec.started:
	case <-m.ctx.Done():
		// Closing: the run may never be published; still wake waiters.
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.run.State == RunExited {
		return
	}
	rec.run.State, rec.run.ExitCode, rec.run.FinishedAt = RunExited, code, m.opts.Now()
	close(rec.done)
	r := rec.run
	m.log.Info("action run finished", "run", r.ID, "action", r.ActionID, "name", r.ActionName, "mode", r.Mode.String(),
		"exit", code, "took", r.FinishedAt.Sub(r.StartedAt).Round(time.Millisecond).String())
	if m.runs[r.ID] != rec {
		return // forgotten meanwhile (its project was unregistered)
	}
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, RunUpdated{Run: rec.public(false)})
	bus.Publish[Event](m.opts.Bus, RunFinished{
		RunID: r.ID, ActionID: r.ActionID, ActionName: r.ActionName, ProjectID: r.ProjectID, ThreadID: r.ThreadID,
		TerminalID: r.TerminalID, Mode: r.Mode, Trigger: r.Trigger, ExitCode: code,
	})
}

// trim forgets projectID's oldest finished runs beyond RunHistory and returns their ids.
// Callers hold m.mu.
func (m *Manager) trim(projectID string) []string {
	var rs []Run
	for _, r := range m.runs {
		if r.run.ProjectID == projectID {
			rs = append(rs, r.run)
		}
	}
	if len(rs) <= m.opts.RunHistory {
		return nil
	}
	sortRuns(rs)
	var dropped []string
	for i := len(rs) - 1; i >= 0 && len(rs)-len(dropped) > m.opts.RunHistory; i-- {
		if rs[i].Finished() {
			delete(m.runs, rs[i].ID)
			dropped = append(dropped, rs[i].ID)
		}
	}
	return dropped
}

// GetRun implements Store.
func (m *Manager) GetRun(_ context.Context, id string) (Run, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.runs[id]
	if !ok {
		return Run{}, fmt.Errorf("%w: run %q", ErrNotFound, id)
	}
	return rec.public(true), nil
}

// Wait implements Store. A terminal run whose terminal is gone without a seen exit
// finishes with ExitUnknown.
func (m *Manager) Wait(ctx context.Context, id string) (Run, error) {
	m.mu.Lock()
	rec, ok := m.runs[id]
	m.mu.Unlock()
	if !ok {
		return Run{}, fmt.Errorf("%w: run %q", ErrNotFound, id)
	}
	var tick <-chan time.Time
	if rec.run.Mode == ModeTerminal && m.opts.Terminals != nil {
		t := time.NewTicker(terminalGonePoll)
		defer t.Stop()
		tick = t.C
	}
	for {
		select {
		case <-rec.done:
			m.mu.Lock()
			defer m.mu.Unlock()
			return rec.public(true), nil
		case <-ctx.Done():
			return Run{}, ctx.Err()
		case <-m.ctx.Done():
			return Run{}, ErrClosed
		case <-tick:
			if _, err := m.opts.Terminals.Get(ctx, rec.run.TerminalID); errors.Is(err, terminal.ErrNotFound) {
				m.finish(rec, ExitUnknown)
			}
		}
	}
}

// WorktreeCreated runs projectID's on-worktree-create actions in the background, one
// after another in their order, for the thread threadID whose new worktree is at
// worktree. It returns at once; failures are logged and published as RunFinished.
func (m *Manager) WorktreeCreated(threadID, projectID, worktree string) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	var acts []Action
	for _, a := range m.projectActions(projectID) {
		if a.OnWorktreeCreate {
			acts = append(acts, a)
		}
	}
	if len(acts) == 0 {
		m.mu.Unlock()
		return
	}
	m.wg.Add(1)
	m.mu.Unlock()
	owner := Owner{ThreadID: threadID, ProjectID: projectID, Worktree: worktree}
	go func() {
		defer m.wg.Done()
		for _, a := range acts {
			r, err := m.start(m.ctx, a, owner, ModeBackground, TriggerWorktreeCreate)
			if err != nil {
				m.log.Warn("worktree-create action did not start", "action", a.ID, "name", a.Name, "thread", threadID, "err", err)
				continue
			}
			r, err = m.Wait(m.ctx, r.ID)
			if err != nil {
				return // closing
			}
			if r.ExitCode != 0 {
				m.log.Warn("worktree-create action failed", "action", a.ID, "name", a.Name, "thread", threadID,
					"run", r.ID, "exit", r.ExitCode, "output", lastLines(r.Output, 5))
			}
		}
	}()
}

// lastLines returns the last n lines of s, for a log line.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	return strings.Join(lines[max(0, len(lines)-n):], "\n")
}

// mergeEnv returns base with overrides ("KEY=VALUE") applied; later entries win.
func mergeEnv(base []string, overrides []string) []string {
	keys := make(map[string]bool, len(overrides))
	for _, kv := range overrides {
		k, _, _ := strings.Cut(kv, "=")
		keys[k] = true
	}
	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		if k, _, _ := strings.Cut(kv, "="); !keys[k] {
			out = append(out, kv)
		}
	}
	return append(out, overrides...)
}
