package action

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os/exec"
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/procscan"
)

// Ports: the TCP ports a running run listens on, so a dev server a project's Action
// started is known like one in a thread's background shell
// (docs/notes/action-run-ports.md, docs/notes/thread-servers.md).
//
// Every running run's process tree is probed with one sysctl and one lsof call: 1, 3 and
// 10 seconds after any run starts, then every 10 seconds, and not at all while no run
// runs. A run's end drops its ports at once (finish). lsof missing, or failing
// portFailLimit times in a row, turns the watch off for the daemon's life, logged once.

// PortProbe finds the ports running runs listen on.
type PortProbe interface {
	// Listening returns the distinct TCP ports the process tree of each pid in pids
	// listens on, by pid; a tree listening on nothing is absent.
	Listening(ctx context.Context, pids []int) (map[int][]int, error)
}

// procscanProbe is the PortProbe of procscan.
type procscanProbe struct{}

func (procscanProbe) Listening(ctx context.Context, pids []int) (map[int][]int, error) {
	ls, err := procscan.ListeningUnder(ctx, pids)
	if err != nil {
		return nil, err
	}
	res := make(map[int][]int, len(ls))
	for pid, l := range ls {
		res[pid] = procscan.Ports(l)
	}
	return res, nil
}

// The watch's schedule (portWatch fields, shorter in tests).
var (
	// portBurst: the probes after any run started.
	portBurst = []time.Duration{time.Second, 3 * time.Second, 10 * time.Second}
	// portEvery: the probe while any run runs, from the end of the last one.
	portEvery = 10 * time.Second
	// portGap: a burst's probe this close after another is skipped, so that many runs
	// starting together cost about one probe a second, not three each.
	portGap = time.Second
)

// portFailLimit is how many lsof (or sysctl) failures in a row turn the watch off.
const portFailLimit = 3

// runningRun is a running run the watch probes.
type runningRun struct {
	id  string
	pid int
}

// portWatch is the actor that probes running runs' ports (run's goroutine owns
// everything but sig). No lock is held during a probe: a slow lsof holds up nothing but
// the next probe.
type portWatch struct {
	probe PortProbe
	sig   chan struct{}
	log   *slog.Logger
	now   func() time.Time
	// running lists the running runs; set publishes a run's ports if they changed and it
	// still runs.
	running func() []runningRun
	set     func(id string, ports []int)

	burst      []time.Duration
	every, gap time.Duration

	// seen are the running runs the last step knew.
	seen map[string]bool
	// probeAt are the burst's probes to come, in order; next is the regular one, zero
	// while no run runs.
	probeAt []time.Time
	next    time.Time
	// failures are the failed calls in a row; off: lsof is missing or kept failing, the
	// watch does nothing more.
	failures int
	off      bool
}

func newPortWatch(m *Manager) *portWatch {
	return &portWatch{probe: m.opts.PortProbe, sig: make(chan struct{}, 1), log: m.log, now: time.Now,
		running: m.runningRuns, set: m.setPorts,
		burst: portBurst, every: portEvery, gap: portGap, seen: map[string]bool{}}
}

// changed tells the watch that a run started or ended. Non-blocking.
func (w *portWatch) changed() {
	select {
	case w.sig <- struct{}{}:
	default:
	}
}

func (w *portWatch) run(ctx context.Context) {
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.sig:
		case <-timer.C:
		}
		at := w.step(ctx, w.now())
		timer.Stop()
		if !at.IsZero() {
			timer.Reset(at.Sub(w.now()))
		}
	}
}

// step does what is due at now and returns when to come back (zero: when told).
func (w *portWatch) step(ctx context.Context, now time.Time) time.Time {
	runs := w.running()
	w.reconcile(runs, now)
	if len(runs) == 0 || w.off {
		w.probeAt, w.next = nil, time.Time{}
		return time.Time{}
	}
	if !w.next.After(now) || (len(w.probeAt) > 0 && !w.probeAt[0].After(now)) {
		w.probePorts(ctx, runs)
		if w.off {
			return time.Time{}
		}
		// From the probe's end, so a slow lsof does not run back to back.
		end := w.now()
		for len(w.probeAt) > 0 && w.probeAt[0].Before(end.Add(w.gap)) {
			w.probeAt = w.probeAt[1:]
		}
		w.next = end.Add(w.every)
	}
	if len(w.probeAt) > 0 && w.probeAt[0].Before(w.next) {
		return w.probeAt[0]
	}
	return w.next
}

// reconcile starts a burst of probes for new runs and forgets ended ones.
func (w *portWatch) reconcile(runs []runningRun, now time.Time) {
	seen := make(map[string]bool, len(runs))
	started := false
	for _, r := range runs {
		seen[r.id] = true
		started = started || !w.seen[r.id]
	}
	w.seen = seen
	if started {
		for _, d := range w.burst {
			w.probeAt = append(w.probeAt, now.Add(d))
		}
		slices.SortFunc(w.probeAt, time.Time.Compare)
	}
	if w.next.IsZero() && len(runs) > 0 {
		w.next = now.Add(w.every)
	}
}

// probePorts probes every run with one call and hands each its ports, ascending (the
// probe's order follows the processes', which is no reason to publish).
func (w *portWatch) probePorts(ctx context.Context, runs []runningRun) {
	pids := make([]int, len(runs))
	for i, r := range runs {
		pids[i] = r.pid
	}
	start := w.now()
	got, err := w.probe.Listening(ctx, pids)
	if err != nil {
		w.fail(ctx, runs, err)
		return
	}
	w.failures = 0
	w.log.Debug("probed action runs' ports", "runs", len(runs), "took", w.now().Sub(start))
	for _, r := range runs {
		ports := slices.Clone(got[r.pid])
		slices.Sort(ports)
		w.set(r.id, ports)
	}
}

// fail keeps the ports as they are after a failed call (a timeout once says nothing about
// them), and turns the watch off when lsof is missing or after portFailLimit failures in a
// row: then nothing would ever correct them, so they go. Not at shutdown.
func (w *portWatch) fail(ctx context.Context, runs []runningRun, err error) {
	if ctx.Err() != nil {
		return
	}
	w.failures++
	if !errors.Is(err, exec.ErrNotFound) && !errors.Is(err, fs.ErrNotExist) && w.failures < portFailLimit {
		w.log.Info("action runs' ports: probe failed; skipped this time", "err", err, "in_a_row", w.failures)
		return
	}
	w.off = true
	w.log.Warn("action runs' ports: probe failed; no more probes until the daemon restarts", "err", err)
	for _, r := range runs {
		w.set(r.id, nil)
	}
}

// runningRuns lists the runs with a process to probe.
func (m *Manager) runningRuns() []runningRun {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []runningRun
	for id, r := range m.runs {
		if r.run.State == RunRunning && r.pid > 1 {
			out = append(out, runningRun{id: id, pid: r.pid})
		}
	}
	return out
}

// setPorts records and publishes a run's ports if they changed. A run that ended since
// the probe started keeps none (finish cleared them): what the probe saw is stale.
func (m *Manager) setPorts(id string, ports []int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.runs[id]
	if !ok || rec.run.State != RunRunning || slices.Equal(rec.run.Ports, ports) {
		return
	}
	rec.run.Ports = ports
	m.log.Info("action run ports", "run", id, "action", rec.run.ActionID, "name", rec.run.ActionName, "ports", ports)
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, RunUpdated{Run: rec.public(false)})
}
