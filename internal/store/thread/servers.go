package thread

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/procscan"
)

// Servers: the TCP ports a thread's background shells listen on, for the thread info
// card (docs/notes/thread-servers.md).
//
// Claude Code runs each background Bash or Monitor task as a direct child of its
// process, leading a process group of its own, with its standard output on the task's
// output file (<tmp>/claude-<uid>/<cwd slug>/<session>/tasks/<task id>.output, the
// task_notification's output_file); the task frames carry no pid. So a new shell is
// found by that file: Claude's children (sysctl) and their standard outputs (one lsof
// call), at once and again 1 and 3 seconds later while the child is not there yet. Its
// group is kept on the Thread's BackgroundShell.
//
// The found groups are probed for listening TCP sockets with one lsof call for every
// running shell of every thread: 1, 3 and 10 seconds after any shell starts, then every
// 10 seconds, and not at all while no shell runs. A shell's end drops it, ports and all,
// at once (the runner publishes the list without it). lsof missing or failing turns the
// watch off for the daemon's life, logged once.

// ShellStopGrace is how long a stopped background shell's process group gets between
// SIGTERM and SIGKILL (StopShell).
const ShellStopGrace = 3 * time.Second

// ServerProbe finds background shells' process groups and the ports those listen on.
type ServerProbe interface {
	// ShellGroups maps the background shells running under Claude process pid to their
	// process groups, by task id. A shell whose process is not there is absent.
	ShellGroups(ctx context.Context, pid int) (map[string]int, error)
	// Listening returns the distinct TCP ports each process group in pgids listens on;
	// a group listening on nothing is absent.
	Listening(ctx context.Context, pgids []int) (map[int][]int, error)
}

// lsofProbe is the ServerProbe of procscan: sysctl for the process table, lsof for
// the rest.
type lsofProbe struct{}

func (lsofProbe) ShellGroups(ctx context.Context, pid int) (map[string]int, error) {
	kids, err := procscan.Children(pid)
	if err != nil {
		return nil, err
	}
	// A task leads its own group; anything else (an MCP server, a hook) is not one.
	var leaders []int
	for _, k := range kids {
		if k.PGID == k.PID {
			leaders = append(leaders, k.PID)
		}
	}
	outs, err := procscan.Stdouts(ctx, leaders)
	if err != nil {
		return nil, err
	}
	res := map[string]int{}
	for p, path := range outs {
		if id := taskOfOutput(path); id != "" {
			res[id] = p
		}
	}
	return res, nil
}

func (lsofProbe) Listening(ctx context.Context, pgids []int) (map[int][]int, error) {
	ls, err := procscan.ListeningIn(ctx, pgids)
	if err != nil {
		return nil, err
	}
	res := make(map[int][]int, len(ls))
	for g, l := range ls {
		res[g] = procscan.Ports(l)
	}
	return res, nil
}

// taskOfOutput is the task id a background task's output file names
// (".../tasks/b9x3jnir3.output"); "" for any other path.
func taskOfOutput(path string) string {
	dir, file := filepath.Split(path)
	id, ok := strings.CutSuffix(file, ".output")
	if !ok || id == "" || dir == "" || filepath.Base(filepath.Clean(dir)) != "tasks" {
		return ""
	}
	return id
}

// The watch's schedule (serverWatch fields, shorter in tests).
var (
	// shellMapAfter: when a new shell is looked for, after it started.
	shellMapAfter = []time.Duration{0, time.Second, 3 * time.Second}
	// serverBurst: the probes after any shell started.
	serverBurst = []time.Duration{time.Second, 3 * time.Second, 10 * time.Second}
	// serverEvery: the probe while any shell runs.
	serverEvery = 10 * time.Second
)

// shellKey is a shell of a thread.
type shellKey struct{ thread, task string }

// watchedShell is what the watch keeps of a running shell.
type watchedShell struct {
	pid  int
	pgid int
	// mapAt are the attempts left at finding its process (pgid 0).
	mapAt []time.Time
	// ports were last published.
	ports []int
}

// serverWatch is the actor that finds the shells' processes and probes their ports
// (run's goroutine owns everything but sig).
type serverWatch struct {
	probe ServerProbe
	sig   chan struct{}
	log   *slog.Logger
	// threads is the store's snapshot; set changes a running shell on its Thread.
	threads func() []Thread
	set     func(k shellKey, fn func(*BackgroundShell))

	mapAfter, burst []time.Duration
	every           time.Duration

	shells map[shellKey]*watchedShell
	// probeAt are the burst's probes to come, in order; next is the regular one, zero
	// while no shell runs.
	probeAt []time.Time
	next    time.Time
	// failures are the failed calls in a row; off: lsof is missing or kept failing, the
	// watch does nothing more.
	failures int
	off      bool
}

func newServerWatch(m *Manager, probe ServerProbe) *serverWatch {
	return &serverWatch{probe: probe, sig: make(chan struct{}, 1), log: m.log,
		threads: func() []Thread { return m.Snapshot().Threads }, set: m.setShell,
		mapAfter: shellMapAfter, burst: serverBurst, every: serverEvery, shells: map[shellKey]*watchedShell{}}
}

// changed tells the watch that some thread's shells changed. Non-blocking; nil-safe.
func (w *serverWatch) changed() {
	if w == nil {
		return
	}
	select {
	case w.sig <- struct{}{}:
	default:
	}
}

func (w *serverWatch) run(ctx context.Context) {
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.sig:
		case <-timer.C:
		}
		at := w.step(ctx, time.Now())
		timer.Stop()
		if !at.IsZero() {
			timer.Reset(time.Until(at))
		}
	}
}

// step does what is due at now and returns when to come back (zero: when told).
func (w *serverWatch) step(ctx context.Context, now time.Time) time.Time {
	w.reconcile(now)
	if len(w.shells) == 0 || w.off {
		w.probeAt, w.next = nil, time.Time{}
		return time.Time{}
	}
	w.mapDue(ctx, now)
	due := !w.next.After(now)
	for len(w.probeAt) > 0 && !w.probeAt[0].After(now) {
		w.probeAt, due = w.probeAt[1:], true
	}
	if due && !w.off {
		w.probePorts(ctx)
		w.next = now.Add(w.every)
	}
	if w.off {
		return time.Time{}
	}
	at := w.next
	if len(w.probeAt) > 0 && w.probeAt[0].Before(at) {
		at = w.probeAt[0]
	}
	for _, ws := range w.shells {
		if ws.pgid == 0 && len(ws.mapAt) > 0 && ws.mapAt[0].Before(at) {
			at = ws.mapAt[0]
		}
	}
	return at
}

// reconcile takes the running shells from the snapshot: new ones are looked for and
// start a burst of probes, ended ones are forgotten.
func (w *serverWatch) reconcile(now time.Time) {
	cur := map[shellKey]BackgroundShell{}
	for _, t := range w.threads() {
		for _, sh := range t.BackgroundShells {
			cur[shellKey{t.ID, sh.TaskID}] = sh
		}
	}
	for k := range w.shells {
		if _, ok := cur[k]; !ok {
			delete(w.shells, k)
		}
	}
	started := false
	for k, sh := range cur {
		if _, ok := w.shells[k]; ok {
			continue
		}
		ws := &watchedShell{pid: sh.ClaudePID, pgid: sh.PGID, ports: sh.Ports}
		if ws.pgid == 0 {
			for _, d := range w.mapAfter {
				ws.mapAt = append(ws.mapAt, now.Add(d))
			}
		}
		w.shells[k] = ws
		started = true
	}
	if started {
		for _, d := range w.burst {
			w.probeAt = append(w.probeAt, now.Add(d))
		}
		slices.SortFunc(w.probeAt, time.Time.Compare)
	}
	if w.next.IsZero() && len(w.shells) > 0 {
		w.next = now.Add(w.every)
	}
}

// mapDue looks for the processes of the shells due: one call per Claude process.
func (w *serverWatch) mapDue(ctx context.Context, now time.Time) {
	byPID := map[int][]shellKey{}
	for k, ws := range w.shells {
		if ws.pgid != 0 || len(ws.mapAt) == 0 || ws.mapAt[0].After(now) {
			continue
		}
		for len(ws.mapAt) > 0 && !ws.mapAt[0].After(now) {
			ws.mapAt = ws.mapAt[1:]
		}
		if ws.pid > 0 {
			byPID[ws.pid] = append(byPID[ws.pid], k)
		}
	}
	for pid, keys := range byPID {
		groups, err := w.probe.ShellGroups(ctx, pid)
		if err != nil {
			w.fail(ctx, "find background shells' processes", err)
			return
		}
		w.failures = 0
		for _, k := range keys {
			ws := w.shells[k]
			g := groups[k.task]
			if g <= 1 {
				if len(ws.mapAt) == 0 {
					w.log.Info("background shell: its process was not found", "thread", k.thread, "task", k.task, "claude_pid", pid)
				}
				continue
			}
			ws.pgid, ws.mapAt = g, nil
			w.set(k, func(sh *BackgroundShell) { sh.PGID = g })
		}
	}
}

// probePorts probes every found shell's group with one call and publishes what changed.
func (w *serverWatch) probePorts(ctx context.Context) {
	var pgids []int
	for _, ws := range w.shells {
		if ws.pgid > 0 && !slices.Contains(pgids, ws.pgid) {
			pgids = append(pgids, ws.pgid)
		}
	}
	if len(pgids) == 0 {
		return
	}
	start := time.Now()
	got, err := w.probe.Listening(ctx, pgids)
	if err != nil {
		w.fail(ctx, "probe background shells' ports", err)
		return
	}
	w.failures = 0
	w.log.Debug("probed background shells' ports", "groups", len(pgids), "took", time.Since(start))
	for k, ws := range w.shells {
		if ws.pgid == 0 {
			continue
		}
		ports := got[ws.pgid]
		if slices.Equal(ports, ws.ports) {
			continue
		}
		ws.ports = ports
		w.log.Info("background shell ports", "thread", k.thread, "task", k.task, "ports", ports)
		w.set(k, func(sh *BackgroundShell) { sh.Ports = ports })
	}
}

// setShell changes shell k on its Thread (a copy of the list), if it still runs.
func (m *Manager) setShell(k shellKey, fn func(*BackgroundShell)) {
	t, ok := m.Snapshot().Thread(k.thread)
	if !ok || !slices.ContainsFunc(t.BackgroundShells, func(sh BackgroundShell) bool { return sh.TaskID == k.task }) {
		return
	}
	m.update(k.thread, false, func(rec *record) {
		i := slices.IndexFunc(rec.s.BackgroundShells, func(sh BackgroundShell) bool { return sh.TaskID == k.task })
		if i < 0 {
			return
		}
		list := slices.Clone(rec.s.BackgroundShells)
		fn(&list[i])
		rec.s.BackgroundShells = list
	})
}

// serverFailLimit is how many lsof (or sysctl) failures in a row turn the watch off.
const serverFailLimit = 3

// fail skips the rest of this tick after a failed call, and turns the watch off when lsof
// is missing or after serverFailLimit failures in a row (a timeout or a sysctl error once
// is no reason to stop looking). Not at shutdown.
func (w *serverWatch) fail(ctx context.Context, what string, err error) {
	if ctx.Err() != nil {
		return
	}
	w.failures++
	if !errors.Is(err, exec.ErrNotFound) && !errors.Is(err, fs.ErrNotExist) && w.failures < serverFailLimit {
		w.log.Info("background shells' servers: "+what+"; skipped this time", "err", err, "in_a_row", w.failures)
		return
	}
	w.off = true
	w.log.Warn("background shells' servers: "+what+"; no more probes until the daemon restarts", "err", err)
}

// StopShell implements Store.
func (m *Manager) StopShell(ctx context.Context, id, taskID string) (Thread, error) {
	t, ok := m.Snapshot().Thread(id)
	if !ok {
		return Thread{}, m.notFound(id)
	}
	i := slices.IndexFunc(t.BackgroundShells, func(sh BackgroundShell) bool { return sh.TaskID == taskID })
	if i < 0 {
		return Thread{}, fmt.Errorf("%w: thread %s runs no background shell %q", ErrNotFound, id, taskID)
	}
	sh := t.BackgroundShells[i]
	k := shellKey{id, taskID}
	if !m.beginShellStop(k) {
		// A second click while the first stop runs: one SIGTERM, one note.
		m.log.Info("background shell already stopping", "thread", id, "task", taskID)
		return t, nil
	}
	pgid, err := m.shellGroupNow(ctx, id, sh)
	if err != nil {
		m.endShellStop(k)
		return Thread{}, err
	}
	if _, err := m.verbItem(ctx, id, func(Thread) (Item, error) {
		return Item{Kind: KindNote, Text: shellStopNote(sh)}, nil
	}, nil); err != nil {
		m.log.Warn("note a stopped background shell", "thread", id, "task", taskID, "err", err)
	}
	m.log.Info("stopping a background shell", "thread", id, "task", taskID, "pgid", pgid, "command", sh.Command)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer m.endShellStop(k)
		procscan.StopGroups(m.ctx, []int{pgid}, ShellStopGrace)
	}()
	cur, _ := m.Snapshot().Thread(id)
	return cur, nil
}

// beginShellStop marks shell k as being stopped; false when it already is.
func (m *Manager) beginShellStop(k shellKey) bool {
	m.shellStops.Lock()
	defer m.shellStops.Unlock()
	if m.shellStops.keys == nil {
		m.shellStops.keys = map[shellKey]bool{}
	}
	if m.shellStops.keys[k] {
		return false
	}
	m.shellStops.keys[k] = true
	return true
}

// endShellStop forgets shell k's stop: refused, or its group got SIGKILL.
func (m *Manager) endShellStop(k shellKey) {
	m.shellStops.Lock()
	delete(m.shellStops.keys, k)
	m.shellStops.Unlock()
}

// shellGroupNow is thread id's shell sh's process group, looked up again right before a
// kill: it must still be the child of the Claude process that started the shell, writing
// this task's output, and the group found before if one was. A pid reused since (the
// shell ended, another process took its number) is never signalled.
func (m *Manager) shellGroupNow(ctx context.Context, id string, sh BackgroundShell) (int, error) {
	if pid := m.claudePID(id); pid == 0 || pid != sh.ClaudePID {
		return 0, fmt.Errorf("%w: background shell %s of thread %s: the Claude process that started it is gone", ErrFailedPrecondition, sh.TaskID, id)
	}
	groups, err := m.opts.ServerProbe.ShellGroups(ctx, sh.ClaudePID)
	if err != nil {
		return 0, fmt.Errorf("thread %s: find background shell %s: %w", id, sh.TaskID, err)
	}
	pgid := groups[sh.TaskID]
	if pgid <= 1 || (sh.PGID != 0 && pgid != sh.PGID) {
		return 0, fmt.Errorf("%w: background shell %s of thread %s: its process was not found", ErrFailedPrecondition, sh.TaskID, id)
	}
	return pgid, nil
}

// claudePID is thread id's running Claude process, 0 when none (or a restart is swapping
// it).
func (m *Manager) claudePID(id string) int {
	m.mu.Lock()
	rec, ok := m.recs[id]
	var r *runner
	if ok {
		r = rec.run
	}
	m.mu.Unlock()
	if r == nil || r.st == nil {
		return 0
	}
	r.st.connMu.Lock()
	defer r.st.connMu.Unlock()
	if r.st.swapping || r.st.proc == nil {
		return 0
	}
	return r.st.proc.Pid()
}

// shellStopNote is the conversation's note for a stopped shell: its command, else its
// description, else its task id.
func shellStopNote(sh BackgroundShell) string {
	what := sh.Command
	if what == "" {
		what = sh.Description
	}
	if what == "" {
		what = sh.TaskID
	}
	return "Stopped background shell: " + what
}
