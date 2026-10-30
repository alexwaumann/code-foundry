package thread

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestTaskOfOutput(t *testing.T) {
	tests := []struct {
		path, want string
	}{
		{"/private/tmp/claude-501/-Users-a-web/3e1bcb/tasks/by3gxdr0o.output", "by3gxdr0o"},
		{"/tmp/claude-501/x/s/tasks/b1.output", "b1"},
		{"/private/tmp/claude-501/x/s/tasks/.output", ""},
		{"/private/tmp/claude-501/x/s/other/b1.output", ""},
		{"/private/tmp/claude-501/x/s/tasks/b1.log", ""},
		{"b1.output", ""},
		{"/dev/null", ""},
		{"pipe", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := taskOfOutput(tt.path); got != tt.want {
			t.Errorf("taskOfOutput(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestShellSetListKeepsWhatWasFound(t *testing.T) {
	t0 := time.Unix(1000, 0)
	s := shellSet{running: map[string]*BackgroundShell{
		"b2": {TaskID: "b2", Command: "npm run dev", StartedAt: t0.Add(time.Second)},
		"b1": {TaskID: "b1", Command: "sleep 9", StartedAt: t0},
	}}
	prev := []BackgroundShell{{TaskID: "b2", PGID: 42, Ports: []int{5173}}, {TaskID: "gone", PGID: 7}}
	got := s.list(prev)
	if len(got) != 2 || got[0].TaskID != "b1" || got[1].TaskID != "b2" {
		t.Fatalf("list = %+v, want b1 then b2", got)
	}
	if got[0].PGID != 0 || got[0].Ports != nil || got[1].PGID != 42 || !slices.Equal(got[1].Ports, []int{5173}) {
		t.Errorf("list = %+v, want b2's group and ports kept", got)
	}
	if (&shellSet{}).list(prev) != nil {
		t.Errorf("no shells: want nil")
	}
}

// fakeServerProbe answers from its maps and counts the calls.
type fakeServerProbe struct {
	mu sync.Mutex
	// groups maps task ids to groups; ShellGroups answers nothing before call mapFrom.
	groups  map[string]int
	mapFrom int
	ports   map[int][]int
	mapErr  error
	lisErr  error

	mapCalls []int   // the pids asked
	listens  [][]int // the groups asked, sorted
}

func (f *fakeServerProbe) ShellGroups(_ context.Context, pid int) (map[string]int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mapCalls = append(f.mapCalls, pid)
	if f.mapErr != nil {
		return nil, f.mapErr
	}
	if len(f.mapCalls) < f.mapFrom {
		return map[string]int{}, nil
	}
	out := map[string]int{}
	for k, v := range f.groups {
		out[k] = v
	}
	return out, nil
}

func (f *fakeServerProbe) Listening(_ context.Context, pgids []int) (map[int][]int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listens = append(f.listens, slices.Sorted(slices.Values(pgids)))
	if f.lisErr != nil {
		return nil, f.lisErr
	}
	out := map[int][]int{}
	for _, g := range pgids {
		if p, ok := f.ports[g]; ok {
			out[g] = p
		}
	}
	return out, nil
}

func (f *fakeServerProbe) set(fn func(f *fakeServerProbe)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeServerProbe) counts() (maps, listens int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.mapCalls), len(f.listens)
}

// shellWatchHarness drives a serverWatch on a hand-made snapshot with a fake clock.
type shellWatchHarness struct {
	w       *serverWatch
	probe   *fakeServerProbe
	threads []Thread
	sets    []string
}

func newShellWatchHarness(probe *fakeServerProbe) *shellWatchHarness {
	h := &shellWatchHarness{probe: probe}
	h.w = &serverWatch{probe: probe, sig: make(chan struct{}, 1), log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		threads: func() []Thread { return h.threads },
		set: func(k shellKey, fn func(*BackgroundShell)) {
			var sh BackgroundShell
			fn(&sh)
			h.sets = append(h.sets, fmt.Sprintf("%s/%s pgid=%d ports=%v", k.thread, k.task, sh.PGID, sh.Ports))
		},
		mapAfter: shellMapAfter, burst: serverBurst, every: serverEvery, shells: map[shellKey]*watchedShell{}}
	return h
}

func (h *shellWatchHarness) takeSets() []string {
	out := h.sets
	h.sets = nil
	slices.Sort(out)
	return out
}

// The schedule: a new shell is looked for at once, then 1 and 3 seconds later; the ports
// are probed 1, 3 and 10 seconds after any shell starts, then every 10 seconds, with one
// call for every group; nothing runs while no shell does.
func TestServerWatchSchedule(t *testing.T) {
	ctx := context.Background()
	probe := &fakeServerProbe{groups: map[string]int{"b1": 101, "b2": 102}, mapFrom: 2, ports: map[int][]int{101: {3000}}}
	h := newShellWatchHarness(probe)
	t0 := time.Unix(1000, 0)
	sec := func(n float64) time.Time { return t0.Add(time.Duration(n * float64(time.Second))) }
	step := func(at time.Time, want time.Time) {
		t.Helper()
		if got := h.w.step(ctx, at); !got.Equal(want) {
			t.Fatalf("step at +%v: next +%v, want +%v", at.Sub(t0), got.Sub(t0), want.Sub(t0))
		}
	}

	step(t0, time.Time{}) // nothing runs: nothing is due
	if m, l := probe.counts(); m != 0 || l != 0 {
		t.Fatalf("calls with no shell: %d maps, %d probes", m, l)
	}

	h.threads = []Thread{{ID: "t1", BackgroundShells: []BackgroundShell{{TaskID: "b1", ClaudePID: 50}}}}
	step(t0, sec(1)) // looked for at once: not there yet
	if m, l := probe.counts(); m != 1 || l != 0 {
		t.Fatalf("at start: %d maps, %d probes; want 1, 0", m, l)
	}
	step(sec(1), sec(3)) // found on the retry, probed with the burst's first
	if got, want := h.takeSets(), []string{"t1/b1 pgid=0 ports=[3000]", "t1/b1 pgid=101 ports=[]"}; !slices.Equal(got, want) {
		t.Fatalf("published %q, want %q", got, want)
	}
	step(sec(3), sec(10))
	step(sec(10), sec(20))
	step(sec(20), sec(30))
	if got := h.takeSets(); len(got) != 0 {
		t.Errorf("unchanged ports published again: %q", got)
	}

	// A second thread's shell starts: found at once, and a new burst.
	h.threads = append(h.threads, Thread{ID: "t2", BackgroundShells: []BackgroundShell{{TaskID: "b2", ClaudePID: 60}}})
	step(sec(25), sec(26))
	step(sec(26), sec(28))
	probe.mu.Lock()
	last := probe.listens[len(probe.listens)-1]
	probe.mu.Unlock()
	if !slices.Equal(last, []int{101, 102}) {
		t.Errorf("probe asked %v, want both groups in one call", last)
	}
	h.takeSets()
	probe.set(func(f *fakeServerProbe) { f.ports = map[int][]int{102: {8080, 8081}} })
	step(sec(28), sec(35))
	if got, want := h.takeSets(), []string{"t1/b1 pgid=0 ports=[]", "t2/b2 pgid=0 ports=[8080 8081]"}; !slices.Equal(got, want) {
		t.Errorf("published %q, want %q", got, want)
	}

	// Both end: nothing more is due, nothing is called.
	h.threads = nil
	_, before := probe.counts()
	step(sec(35), time.Time{})
	if _, l := probe.counts(); l != before {
		t.Errorf("probed with no shell running")
	}
	// A shell whose process never shows is given up after the last retry.
	probe.set(func(f *fakeServerProbe) { f.groups = nil })
	h.threads = []Thread{{ID: "t3", BackgroundShells: []BackgroundShell{{TaskID: "b3", ClaudePID: 70}}}}
	step(sec(100), sec(101))
	step(sec(101), sec(103))
	step(sec(103), sec(110))
	maps, _ := probe.counts()
	step(sec(110), sec(120))
	if m, _ := probe.counts(); m != maps {
		t.Errorf("looked for a shell after its last retry")
	}
}

// lsof failing turns the watch off for good: no more calls.
func TestServerWatchOffWhenLsofFails(t *testing.T) {
	tests := []struct {
		name string
		fail func(f *fakeServerProbe)
	}{
		{"mapping", func(f *fakeServerProbe) { f.mapErr = errors.New("exec: no lsof") }},
		{"probing", func(f *fakeServerProbe) { f.lisErr = errors.New("signal: killed") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probe := &fakeServerProbe{groups: map[string]int{"b1": 101}}
			tt.fail(probe)
			h := newShellWatchHarness(probe)
			h.threads = []Thread{{ID: "t1", BackgroundShells: []BackgroundShell{{TaskID: "b1", ClaudePID: 50}}}}
			t0 := time.Unix(1000, 0)
			h.w.step(context.Background(), t0)
			h.w.step(context.Background(), t0.Add(time.Second))
			m, l := probe.counts()
			for i := 2; i < 40; i++ {
				if at := h.w.step(context.Background(), t0.Add(time.Duration(i)*time.Second)); !at.IsZero() {
					t.Fatalf("off, but next at %v", at)
				}
			}
			if m2, l2 := probe.counts(); m2 != m || l2 != l || m+l > 2 {
				t.Errorf("calls after the failure: %d+%d then %d+%d", m, l, m2, l2)
			}
		})
	}
}

// Through the stream: a background shell gets its group and ports on the Thread; stop
// ends its process group and leaves a note; the shell's end drops it.
func TestServerPortsAndStopThroughTheStream(t *testing.T) {
	// A process group of its own standing in for the shell.
	sleeper := exec.Command("sleep", "60")
	sleeper.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := sleeper.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- sleeper.Wait() }()
	t.Cleanup(func() { _ = sleeper.Process.Kill() })
	pgid := sleeper.Process.Pid

	probe := &fakeServerProbe{groups: map[string]int{"by3gxdr0o": pgid}, ports: map[int][]int{pgid: {9399}}}
	gates := t.TempDir()
	e := newFixtureEnvAt(t, fixturePath("shells"), []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + gates},
		func(o *Options) { o.ServerProbe = probe })
	s := e.create(CreateOptions{InitialPrompt: "launch"})
	got := e.waitFor(s.ID, "the shell's port", func(s Thread) bool {
		return len(s.BackgroundShells) == 1 && slices.Equal(s.BackgroundShells[0].Ports, []int{9399})
	})
	sh := got.BackgroundShells[0]
	if sh.TaskID != "by3gxdr0o" || sh.PGID != pgid || sh.ClaudePID != e.pid(s.ID) || !strings.Contains(sh.Command, "sleep 15") || sh.StartedAt.IsZero() {
		t.Errorf("shell %+v", sh)
	}
	probe.mu.Lock()
	asked := slices.Clone(probe.mapCalls)
	probe.mu.Unlock()
	if len(asked) == 0 || asked[0] != e.pid(s.ID) {
		t.Errorf("looked for the shell under %v, want Claude's pid %d", asked, e.pid(s.ID))
	}

	if _, err := e.m.StopShell(e.ctx(), s.ID, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("stop of an unknown shell: %v, want ErrNotFound", err)
	}
	if _, err := e.m.StopShell(e.ctx(), s.ID, "by3gxdr0o"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the shell's process group still runs after stop")
	}
	e.waitItems(s.ID, "the stop note", func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool {
			return it.Kind == KindNote && it.Text == "Stopped background shell: "+sh.Command
		})
	})

	// Claude reports the end: the shell and its ports are gone at once.
	if err := os.WriteFile(filepath.Join(gates, "turn-2"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "no shells", func(s Thread) bool { return len(s.BackgroundShells) == 0 && s.BackgroundShellsRunning == 0 })
}

func TestShellStopNote(t *testing.T) {
	tests := []struct {
		sh   BackgroundShell
		want string
	}{
		{BackgroundShell{TaskID: "b1", Command: "pnpm dev", Description: "Start the dev server"}, "Stopped background shell: pnpm dev"},
		{BackgroundShell{TaskID: "b1", Description: "Watch the log"}, "Stopped background shell: Watch the log"},
		{BackgroundShell{TaskID: "b1"}, "Stopped background shell: b1"},
	}
	for _, tt := range tests {
		if got := shellStopNote(tt.sh); got != tt.want {
			t.Errorf("shellStopNote(%+v) = %q, want %q", tt.sh, got, tt.want)
		}
	}
}

// startGroup starts a sleep leading a process group of its own, standing in for a shell.
func startGroup(t *testing.T) int {
	t.Helper()
	c := exec.Command("sleep", "60")
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Process.Kill(); _ = c.Wait() })
	return c.Process.Pid
}

// alive reports whether process pid still runs (it is our child: reaped only by Wait).
func alive(pid int) bool {
	var ws syscall.WaitStatus
	got, err := syscall.Wait4(pid, &ws, syscall.WNOHANG, nil)
	return err == nil && got == 0
}

// StopShell signals nothing unless the group it finds right before the kill is the
// shell's, under the Claude process that started it.
func TestStopShellRefuses(t *testing.T) {
	const task = "by3gxdr0o"
	tests := []struct {
		name string
		// groups is what the probe maps the task to from the start (0: nothing);
		// then changes what it says once the shell was looked for.
		groups func(pgid, other int) int
		then   func(e *env, p *fakeServerProbe, id string, pgid, other int)
	}{
		{name: "no group found", groups: func(int, int) int { return 0 }},
		{name: "group 1", groups: func(int, int) int { return 1 }},
		{name: "the group changed since it was found", groups: func(pgid, _ int) int { return pgid },
			then: func(_ *env, p *fakeServerProbe, _ string, _, other int) {
				p.set(func(f *fakeServerProbe) { f.groups = map[string]int{task: other} })
			}},
		{name: "another Claude process", groups: func(pgid, _ int) int { return pgid },
			then: func(e *env, _ *fakeServerProbe, id string, _, _ int) {
				e.m.setShell(shellKey{id, task}, func(sh *BackgroundShell) { sh.ClaudePID++ })
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pgid, other := startGroup(t), startGroup(t)
			probe := &fakeServerProbe{groups: map[string]int{}}
			if g := tt.groups(pgid, other); g != 0 {
				probe.groups[task] = g
			}
			gates := t.TempDir()
			e := newFixtureEnvAt(t, fixturePath("shells"), []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + gates},
				func(o *Options) { o.ServerProbe = probe })
			s := e.create(CreateOptions{InitialPrompt: "launch"})
			e.waitFor(s.ID, "the shell", func(s Thread) bool { return len(s.BackgroundShells) == 1 })
			if tt.then != nil {
				e.waitFor(s.ID, "its group", func(s Thread) bool { return s.BackgroundShells[0].PGID == pgid })
				tt.then(e, probe, s.ID, pgid, other)
			}
			if _, err := e.m.StopShell(e.ctx(), s.ID, task); !errors.Is(err, ErrFailedPrecondition) {
				t.Fatalf("stop: %v, want ErrFailedPrecondition", err)
			}
			time.Sleep(100 * time.Millisecond)
			if !alive(pgid) || !alive(other) {
				t.Errorf("a group was signalled")
			}
			if slices.ContainsFunc(e.items(s.ID).Items, func(it Item) bool { return it.Kind == KindNote }) {
				t.Errorf("a stop note without a stop")
			}
		})
	}
}
