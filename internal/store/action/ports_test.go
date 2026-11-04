package action

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// fakePortProbe answers from ports and records the calls.
type fakePortProbe struct {
	mu    sync.Mutex
	ports map[int][]int
	// byAny answers every pid (a run's pid is not known before it starts).
	byAny []int
	// err fails the calls: all of them, or only the first errN.
	err  error
	errN int
	// during runs inside a call, outside the lock: a slow lsof, or what happens meanwhile.
	during func(ctx context.Context)

	calls [][]int // the pids asked, sorted
}

func (f *fakePortProbe) Listening(ctx context.Context, pids []int) (map[int][]int, error) {
	f.mu.Lock()
	f.calls = append(f.calls, slices.Sorted(slices.Values(pids)))
	n, during := len(f.calls), f.during
	f.mu.Unlock()
	if during != nil {
		during(ctx)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil && (f.errN == 0 || n <= f.errN) {
		return nil, f.err
	}
	out := map[int][]int{}
	for _, p := range pids {
		if v, ok := f.ports[p]; ok {
			out[p] = v
		} else if f.byAny != nil {
			out[p] = f.byAny
		}
	}
	return out, nil
}

func (f *fakePortProbe) answer(ports ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byAny = ports
	if f.byAny == nil {
		f.byAny = []int{}
	}
}

func (f *fakePortProbe) asked() [][]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// watchHarness drives a portWatch on hand-made runs with a fake clock.
type watchHarness struct {
	w     *portWatch
	probe *fakePortProbe
	runs  []runningRun
	sets  []string
	clock time.Time
}

func newWatchHarness(probe *fakePortProbe) *watchHarness {
	h := &watchHarness{probe: probe, clock: time.Unix(1000, 0)}
	h.w = &portWatch{probe: probe, sig: make(chan struct{}, 1), log: discard, now: func() time.Time { return h.clock },
		running: func() []runningRun { return h.runs },
		set:     func(id string, ports []int) { h.sets = append(h.sets, fmt.Sprintf("%s %v", id, ports)) },
		burst:   portBurst, every: portEvery, gap: portGap, seen: map[string]bool{}}
	return h
}

// at runs a step d after the harness's start and returns when it asks to come back, as
// an offset.
func (h *watchHarness) at(d time.Duration) time.Duration {
	h.clock = time.Unix(1000, 0).Add(d)
	next := h.w.step(context.Background(), h.clock)
	if next.IsZero() {
		return 0
	}
	return next.Sub(time.Unix(1000, 0))
}

func TestPortWatchSchedule(t *testing.T) {
	const s = time.Second
	probe := &fakePortProbe{ports: map[int][]int{101: {5173}}}
	h := newWatchHarness(probe)

	if next := h.at(0); next != 0 || len(probe.asked()) != 0 {
		t.Fatalf("no run: next %v, %d calls", next, len(probe.asked()))
	}
	h.runs = []runningRun{{"r1", 101}, {"r2", 102}}
	// One step at the run's start asks for the burst; each probe comes when it is due.
	for _, step := range []struct {
		at, next time.Duration
		calls    int
	}{
		{0, 1 * s, 0},
		{1 * s, 3 * s, 1},
		{3 * s, 10 * s, 2},
		{10 * s, 20 * s, 3},
		{20 * s, 30 * s, 4},
	} {
		if next := h.at(step.at); next != step.next || len(probe.asked()) != step.calls {
			t.Fatalf("at %v: next %v (want %v), %d calls (want %d)", step.at, next, step.next, len(probe.asked()), step.calls)
		}
	}
	for i, pids := range probe.asked() {
		if !slices.Equal(pids, []int{101, 102}) {
			t.Errorf("call %d asked %v: every run in one call", i, pids)
		}
	}
	if h.sets[0] != "r1 [5173]" || h.sets[1] != "r2 []" {
		t.Errorf("sets %v", h.sets)
	}
	// A wake between probes (a run ended, another still runs) does not probe.
	h.runs = h.runs[:1]
	if next := h.at(25 * s); next != 30*s || len(probe.asked()) != 4 {
		t.Errorf("run ended: next %v, %d calls", next, len(probe.asked()))
	}
	// The last run ended: nothing more, not even what was planned.
	h.runs = nil
	if next := h.at(26 * s); next != 0 || len(probe.asked()) != 4 {
		t.Errorf("no run left: next %v, %d calls", next, len(probe.asked()))
	}
	// A run that starts later gets its own burst.
	h.runs = []runningRun{{"r3", 103}}
	if next := h.at(60 * s); next != 61*s {
		t.Errorf("a new run: next %v", next)
	}
}

// Ports go out ascending whatever the order the processes came in.
func TestPortWatchSortsPorts(t *testing.T) {
	probe := &fakePortProbe{ports: map[int][]int{101: {24678, 5173, 8080}}}
	h := newWatchHarness(probe)
	h.runs = []runningRun{{"r1", 101}}
	h.at(0)
	h.at(time.Second)
	if want := "r1 [5173 8080 24678]"; len(h.sets) != 1 || h.sets[0] != want {
		t.Errorf("sets %v, want %s", h.sets, want)
	}
	if got := probe.ports[101]; got[0] != 24678 {
		t.Errorf("the probe's own slice was sorted: %v", got)
	}
}

// A probe that takes long pushes the next one back and swallows the burst's probes it
// outlasted: it never runs back to back.
func TestPortWatchSlowProbe(t *testing.T) {
	const s = time.Second
	probe := &fakePortProbe{}
	h := newWatchHarness(probe)
	probe.during = func(context.Context) { h.clock = h.clock.Add(9 * s) }
	h.runs = []runningRun{{"r1", 101}}
	h.at(0)
	if next := h.at(1 * s); next != 20*s {
		t.Errorf("after a 9 s probe from +1 s: next %v, want +20 s (burst gone, every from its end)", next)
	}
	if n := len(probe.asked()); n != 1 {
		t.Errorf("%d calls", n)
	}
}

// Many runs starting close together cost a probe a second, not three each.
func TestPortWatchManyRunsStarting(t *testing.T) {
	const ms = time.Millisecond
	probe := &fakePortProbe{}
	h := newWatchHarness(probe)
	next := time.Duration(0)
	for i := range 40 {
		now := time.Duration(i) * 250 * ms
		h.runs = append(h.runs, runningRun{"r" + strconv.Itoa(i), 100 + i})
		if next = h.at(now); next == 0 {
			t.Fatalf("no next at %v", now)
		}
	}
	for next < 25*time.Second {
		next = h.at(next)
	}
	calls := probe.asked()
	if len(calls) > 25 {
		t.Errorf("%d probes in 25 s for 40 runs", len(calls))
	}
	if last := calls[len(calls)-1]; len(last) != 40 {
		t.Errorf("the last probe asked %d runs", len(last))
	}
}

func TestPortWatchFailures(t *testing.T) {
	const s = time.Second
	killed := errors.New("procscan: lsof: signal: killed")
	tests := []struct {
		name string
		err  error
		errN int
		// offAfter is the failing call that turns it off, 0: it stays on.
		offAfter int
	}{
		{"lsof missing", exec.ErrNotFound, 0, 1},
		{"killed every time", killed, 0, portFailLimit},
		{"killed twice, then fine", killed, 2, 0},
		{"a timeout once", context.DeadlineExceeded, 1, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probe := &fakePortProbe{err: tt.err, errN: tt.errN, ports: map[int][]int{101: {3000}}}
			h := newWatchHarness(probe)
			h.runs = []runningRun{{"r1", 101}}
			h.at(0)
			at := time.Duration(0)
			for i := 1; i <= 6; i++ {
				at += s * 10
				h.at(at)
			}
			switch {
			case tt.offAfter > 0:
				if !h.w.off || len(probe.asked()) != tt.offAfter {
					t.Errorf("off %v after %d calls, want %d", h.w.off, len(probe.asked()), tt.offAfter)
				}
				if want := []string{"r1 []"}; !slices.Equal(h.sets, want) {
					t.Errorf("sets %v, want the ports dropped once", h.sets)
				}
			case h.w.off:
				t.Errorf("turned off after %d calls", len(probe.asked()))
			case h.sets[0] != "r1 [3000]":
				t.Errorf("a failed call touched the ports: %v", h.sets)
			}
		})
	}
	t.Run("closing is no failure", func(t *testing.T) {
		probe := &fakePortProbe{err: context.Canceled}
		h := newWatchHarness(probe)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		h.runs = []runningRun{{"r1", 101}}
		h.w.step(ctx, h.clock)
		h.clock = h.clock.Add(time.Minute)
		h.w.step(ctx, h.clock)
		if h.w.failures != 0 || h.w.off {
			t.Errorf("failures %d, off %v", h.w.failures, h.w.off)
		}
	})
}

// fastPorts shortens the watch for a test through the Manager.
func fastPorts(t *testing.T) {
	t.Helper()
	burst, every, gap := portBurst, portEvery, portGap
	portBurst, portEvery, portGap = []time.Duration{time.Millisecond}, 15*time.Millisecond, time.Millisecond
	t.Cleanup(func() { portBurst, portEvery, portGap = burst, every, gap })
}

// waitPorts waits for an event of the run with ports (none: an update with none).
func waitPorts(t *testing.T, sub *bus.Subscription[Event], id string, want ...int) Run {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			if e, ok := ev.(RunUpdated); ok && e.Run.ID == id && slices.Equal(e.Run.Ports, want) {
				return e.Run
			}
		case <-deadline:
			t.Fatalf("no RunUpdated with ports %v", want)
		}
	}
}

// settle waits for n more probes.
func settle(t *testing.T, p *fakePortProbe, n int) {
	t.Helper()
	from := len(p.asked())
	for range 2000 {
		if len(p.asked()) >= from+n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no %d more probes", n)
}

// updates counts the RunUpdated events of a run waiting on sub now.
func updates(sub *bus.Subscription[Event], id string) int {
	n := 0
	for {
		select {
		case ev := <-sub.C():
			if e, ok := ev.(RunUpdated); ok && e.Run.ID == id {
				n++
			}
		default:
			return n
		}
	}
}

// A run's life through the Manager: ports come, change and go while it runs, publishing
// only on a change, and go at its end.
func TestRunPortsLifecycle(t *testing.T) {
	tests := []struct {
		name     string
		terminal bool
	}{
		{"background", false},
		{"terminal", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fastPorts(t)
			ctx := context.Background()
			probe := &fakePortProbe{}
			h := newHarness(t, func(o *Options) { o.PortProbe = probe })
			h.create(CreateOptions{ProjectID: "web", Name: "Dev", Command: "sleep 30", InTerminal: tt.terminal})
			sub := bus.Subscribe[Event](h.bus, 256)
			defer sub.Close()
			r, err := h.m.Run(ctx, RunOptions{Action: "dev", ThreadID: "s1"})
			if err != nil {
				t.Fatal(err)
			}
			// Nothing listens yet: no update beyond the start.
			settle(t, probe, 3)
			if n := updates(sub, r.ID); n != 1 {
				t.Errorf("%d updates with no port, want the start's", n)
			}
			if pids := probe.asked()[0]; len(pids) != 1 || pids[0] <= 1 {
				t.Errorf("asked %v", pids)
			}
			if tt.terminal {
				tm, err := h.terms.Get(ctx, r.TerminalID)
				if err != nil {
					t.Fatal(err)
				}
				if got := probe.asked()[0]; !slices.Equal(got, []int{tm.Pid}) {
					t.Errorf("asked %v, want the terminal's pid %d", got, tm.Pid)
				}
			}

			probe.answer(5173)
			got := waitPorts(t, sub, r.ID, 5173)
			// What a GUI needs to link a server to its owner and terminal.
			if got.ThreadID != "s1" || got.State != RunRunning || (got.TerminalID != "") != tt.terminal {
				t.Errorf("run %+v", got)
			}
			if s, _ := h.m.Snapshot().Run(r.ID); !slices.Equal(s.Ports, []int{5173}) {
				t.Errorf("snapshot ports %v", s.Ports)
			}
			if g, err := h.m.GetRun(ctx, r.ID); err != nil || !slices.Equal(g.Ports, []int{5173}) {
				t.Errorf("GetRun = %v, %v", g.Ports, err)
			}
			// Unchanged: the probes go on, nothing is published.
			settle(t, probe, 3)
			if n := updates(sub, r.ID); n != 0 {
				t.Errorf("%d updates with the same port", n)
			}

			probe.answer(5173, 24678)
			waitPorts(t, sub, r.ID, 5173, 24678)
			// A port closes while the run goes on.
			probe.answer()
			gone := waitPorts(t, sub, r.ID)
			if gone.State != RunRunning {
				t.Errorf("state %v, want running", gone.State)
			}

			probe.answer(3000)
			waitPorts(t, sub, r.ID, 3000)
			if tt.terminal {
				if err := h.terms.Exit(r.TerminalID, 0); err != nil {
					t.Fatal(err)
				}
			} else if _, err := h.m.StopRun(ctx, r.ID); err != nil {
				t.Fatal(err)
			}
			if done := h.wait(r.ID); len(done.Ports) != 0 {
				t.Errorf("finished run keeps %v", done.Ports)
			}
			end := waitPorts(t, sub, r.ID)
			if end.State != RunExited {
				t.Errorf("end state %v", end.State)
			}
			// The probe stops with the last run.
			time.Sleep(5 * time.Millisecond)
			n := len(probe.asked())
			time.Sleep(60 * time.Millisecond)
			if m := len(probe.asked()); m != n {
				t.Errorf("%d probes after the end", m-n)
			}
		})
	}
}

// A run that ends while a probe is out: what the probe saw is not published.
func TestRunExitsDuringProbe(t *testing.T) {
	fastPorts(t)
	ctx := context.Background()
	probe := &fakePortProbe{}
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	probe.during = func(context.Context) {
		once.Do(func() { close(entered); <-release })
	}
	h := newHarness(t, func(o *Options) { o.PortProbe = probe })
	h.create(CreateOptions{ProjectID: "web", Name: "Dev", Command: "sleep 30"})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	r, err := h.m.Run(ctx, RunOptions{Action: "dev", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	probe.answer(5173)
	if _, err := h.m.StopRun(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	h.wait(r.ID)
	close(release)
	// The next wake finds no run; give the late answer its chance.
	time.Sleep(50 * time.Millisecond)
	if s, _ := h.m.Snapshot().Run(r.ID); len(s.Ports) != 0 {
		t.Errorf("a finished run got ports %v", s.Ports)
	}
	if n := updates(sub, r.ID); n != 2 {
		t.Errorf("%d updates, want the start's and the end's", n)
	}
}

// setPorts leaves alone what is no longer there.
func TestSetPortsRefuses(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	h.create(CreateOptions{ProjectID: "web", Name: "Dev", Command: "sleep 30"})
	r, err := h.m.Run(ctx, RunOptions{Action: "dev", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	h.m.ProjectRemoved(ctx, "web")
	sub := bus.Subscribe[Event](h.bus, 8)
	defer sub.Close()
	h.m.setPorts(r.ID, []int{5173})
	h.m.setPorts("r-nope", []int{5173})
	if n := updates(sub, r.ID); n != 0 {
		t.Errorf("%d updates for a forgotten run", n)
	}
}

// Ports are in memory like runs: a new daemon has neither, and probes nothing.
func TestPortsAfterRestart(t *testing.T) {
	fastPorts(t)
	ctx := context.Background()
	probe := &fakePortProbe{byAny: []int{5173}}
	h := newHarness(t, func(o *Options) { o.PortProbe = probe })
	h.create(CreateOptions{ProjectID: "web", Name: "Dev", Command: "sleep 30"})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	r, err := h.m.Run(ctx, RunOptions{Action: "dev", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	waitPorts(t, sub, r.ID, 5173)
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := h.m.Close(cctx); err != nil {
		t.Fatal(err)
	}

	next := &fakePortProbe{byAny: []int{5173}}
	m, err := New(ctx, Options{DB: h.db, Projects: h.projects, Terminals: h.terms, Bus: h.bus, Log: discard, Shell: "/bin/sh", PortProbe: next})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close(ctx) })
	time.Sleep(40 * time.Millisecond)
	if got := m.Snapshot().Runs; len(got) != 0 {
		t.Errorf("runs after a restart: %+v", got)
	}
	if n := len(next.asked()); n != 0 {
		t.Errorf("%d probes with no run", n)
	}
	recs, err := m.RunRecords(ctx, "web")
	if err != nil || len(recs) != 1 {
		t.Errorf("records %v, %v: the record outlives the restart", recs, err)
	}
}

// Close does not wait out a slow lsof: the probe's context ends.
func TestCloseDuringProbe(t *testing.T) {
	fastPorts(t)
	ctx := context.Background()
	entered := make(chan struct{})
	var once sync.Once
	probe := &fakePortProbe{during: func(c context.Context) {
		once.Do(func() { close(entered) })
		<-c.Done()
	}, err: context.Canceled}
	h := newHarness(t, func(o *Options) { o.PortProbe = probe; o.KillGrace = 100 * time.Millisecond })
	h.create(CreateOptions{ProjectID: "web", Name: "Dev", Command: "sleep 30"})
	if _, err := h.m.Run(ctx, RunOptions{Action: "dev", Worktree: h.web}); err != nil {
		t.Fatal(err)
	}
	<-entered
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := h.m.Close(cctx); err != nil {
		t.Fatal(err)
	}
}

// The real probe on real processes: `<shell> -lc` keeps a listener where the walk finds
// it, in a background run, and its port goes with it.
func TestRunPortsLive(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("no python3")
	}
	fastPorts(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	ctx := context.Background()
	h := newHarness(t, func(o *Options) { o.PortProbe = procscanProbe{}; o.KillGrace = 200 * time.Millisecond })
	h.create(CreateOptions{ProjectID: "web", Name: "Serve", Command: "python3 -m http.server --bind 127.0.0.1 " + strconv.Itoa(port)})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	r, err := h.m.Run(ctx, RunOptions{Action: "serve", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	waitPorts(t, sub, r.ID, port)
	if _, err := h.m.StopRun(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if done := h.wait(r.ID); len(done.Ports) != 0 {
		t.Errorf("ports %v after the end", done.Ports)
	}
}
