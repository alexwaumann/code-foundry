package thread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Background shells in claudestream/testdata/shells*.jsonl (Claude Code 2.1.300): the
// call (its item id) of each capture's one shell.
const (
	fxShellCall   = "toolu_01RzkuxN1AhfxgDDtEmNqk2E" // shells: sleep 15 && echo done
	fxFailCall    = "toolu_01WvQcvbHHykxg8Cx7hB63NR" // shells-fail: exit 3
	fxStopCall    = "toolu_01WgguJyMrQ4apZhyF8LvhVi" // shells-stop: TaskStop in the turn
	fxTaskStop    = "toolu_01KzPniXJf4g8aFACHfxssJw" // shells-stop: the TaskStop call
	fxMonitorCall = "toolu_01Cv7pnpdvxdmkK4CpqXnjgh" // shells-monitor
	fxEventsCall  = "toolu_01NUFrxcnLrtCMQXCuGtrZxv" // shells-monitor-events
	fxCloseCall   = "toolu_011ihSVKk5Nas3mtpMPJFhQN" // shells-close: SIGTERM
)

// shellFeed replays a capture through the projector and the shells model the way the
// runner does (onShellTask without the publication), recording the running count at
// each turn's end and the shells as they started.
type shellFeed struct {
	log     *threadLog
	set     shellSet
	started []BackgroundShell
	atEnds  []int // the count at each result
}

func playShells(t *testing.T, fixture string) *shellFeed {
	t.Helper()
	data, err := os.ReadFile(fixturePath(fixture))
	if err != nil {
		t.Fatal(err)
	}
	f := &shellFeed{log: newThreadLog("s", bus.New(), time.Now, nil)}
	p := newProjector(itemWriter{log: f.log, save: func(Item) {}}, runningTotals{known: true})
	call := func(id string) (string, string) {
		if it, ok := f.log.get(id); ok && it.Tool != nil {
			return it.Tool.Name, it.Tool.InputJSON
		}
		return "", ""
	}
	var sp claudestream.Splitter
	for _, line := range sp.Split(nil, data) {
		ev := claudestream.Parse(line)
		p.event(ev)
		switch e := ev.(type) {
		case *claudestream.Task:
			ch := f.set.task(e, time.Now(), call)
			ch.apply(p)
			if ch.handled && e.Subtype == claudestream.TaskStarted {
				f.started = append(f.started, *f.set.running[e.TaskID])
			}
		case *claudestream.Result:
			f.atEnds = append(f.atEnds, f.set.count())
		}
	}
	return f
}

func (f *shellFeed) tool(t *testing.T, id string) ToolCall {
	t.Helper()
	it, ok := f.log.get(id)
	if !ok || it.Tool == nil {
		t.Fatalf("no tool item %s", id)
	}
	return *it.Tool
}

func TestBgShellsFromCapturedFrames(t *testing.T) {
	tests := []struct {
		fixture, call string
		monitor       bool
		command       string
		atEnds        []int // running shells at each turn's end
		status        ToolStatus
		output        string
	}{
		{"shells", fxShellCall, false, "sleep 15 && echo done", []int{1, 0}, ToolDone,
			`Background command "Run sleep 15 then echo done in background" completed (exit code 0)`},
		{"shells-fail", fxFailCall, false, "sleep 8 && echo oops && exit 3", []int{1, 0}, ToolError,
			`Background command "Run sleep then echo oops and exit 3 in background" failed with exit code 3`},
		// TaskStop: the summary is the description, so the error is Claude's word.
		{"shells-stop", fxStopCall, false, "sleep 120 && echo late", []int{0}, ToolError, "stopped"},
		{"shells-monitor", fxMonitorCall, true, "until [ -f ready.txt ]; do sleep 1; done; echo ready", []int{1, 0}, ToolDone,
			`Monitor "Wait for ready file" stream ended`},
		// An event's turn while the monitor runs: still running at its end.
		{"shells-monitor-events", fxEventsCall, true, "for i in 1 2; do sleep 6; echo tick $i; done", []int{1, 1, 0}, ToolDone,
			`Monitor "Two ticks" stream ended`},
		// SIGTERM: the notification before task_updated.
		{"shells-close", fxCloseCall, false, "sleep 90 && echo done", []int{1}, ToolError, "stopped"},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			f := playShells(t, tt.fixture)
			if len(f.started) != 1 {
				t.Fatalf("started %+v", f.started)
			}
			if sh := f.started[0]; sh.ToolUseID != tt.call || sh.Monitor != tt.monitor || sh.Command != tt.command ||
				!strings.HasPrefix(sh.TaskID, "b") || sh.Description == "" || sh.StartedAt.IsZero() {
				t.Errorf("shell %+v", sh)
			}
			if !slicesEqual(f.atEnds, tt.atEnds) {
				t.Errorf("running at the turns' ends %v, want %v", f.atEnds, tt.atEnds)
			}
			if n := f.set.count(); n != 0 {
				t.Errorf("%d still running", n)
			}
			if tc := f.tool(t, tt.call); tc.Status != tt.status || tc.IsError != (tt.status == ToolError) || tc.Output != tt.output {
				t.Errorf("call %s %v %q, want %s %q", tc.Status, tc.IsError, tc.Output, tt.status, tt.output)
			}
			for _, it := range f.log.snapshot().Items {
				if it.Kind == KindNote {
					t.Errorf("note %q", it.Text)
				}
			}
		})
	}
}

func slicesEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The call stays running after its turn until the shell ends; the item's output is the
// launch text meanwhile.
func TestBgShellCallRunsPastItsTurn(t *testing.T) {
	data, err := os.ReadFile(fixturePath("shells"))
	if err != nil {
		t.Fatal(err)
	}
	log := newThreadLog("s", bus.New(), time.Now, nil)
	p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
	var sp claudestream.Splitter
	for _, line := range sp.Split(nil, data) {
		ev := claudestream.Parse(line)
		p.event(ev)
		if _, ok := ev.(*claudestream.Result); ok {
			break
		}
	}
	it, _ := log.get(fxShellCall)
	if it.Tool == nil || it.Tool.Status != ToolRunning || !strings.HasPrefix(it.Tool.Output, "Command running in background with ID: by3gxdr0o") {
		t.Fatalf("call after its turn %+v", it.Tool)
	}
	if len(log.unfinished()) != 1 {
		t.Errorf("unfinished %d", len(log.unfinished()))
	}
}

// A subagent's shells are not the thread's: never counted, their frames left to the
// agents model.
func TestBgShellsSkipSubagentShells(t *testing.T) {
	for _, fixture := range []string{"agents", "agents-stop"} {
		t.Run(fixture, func(t *testing.T) {
			f := playShells(t, fixture)
			if len(f.started) != 0 || f.set.count() != 0 {
				t.Errorf("started %+v", f.started)
			}
			for i, n := range f.atEnds {
				if n != 0 {
					t.Errorf("turn %d: %d shells", i+1, n)
				}
			}
		})
	}
}

// The captured tool results that launch a shell, and others that do not.
func TestIsShellLaunch(t *testing.T) {
	tests := []struct {
		fixture, call string
		want          bool
	}{
		{"shells", fxShellCall, true},           // Bash: backgroundTaskId
		{"shells-monitor", fxMonitorCall, true}, // Monitor: taskId
		{"shells-stop", fxTaskStop, false},      // TaskStop: task_id
		{"agents", fxSlowTool, false},           // an async Agent call
		{"bash", "", false},                     // a foreground Bash call
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			raw := capturedResult(t, tt.fixture, tt.call)
			if got := isShellLaunch(raw); got != tt.want {
				t.Errorf("isShellLaunch(%s) = %v, want %v", raw, got, tt.want)
			}
		})
	}
}

// capturedResult is the tool_use_result of call's result in a capture ("": the first
// tool result's).
func capturedResult(t *testing.T, fixture, call string) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(fixturePath(fixture))
	if err != nil {
		t.Fatal(err)
	}
	var sp claudestream.Splitter
	for _, line := range sp.Split(nil, data) {
		u, ok := claudestream.Parse(line).(*claudestream.User)
		if !ok {
			continue
		}
		for _, b := range u.Blocks() {
			if b.Type == "tool_result" && (call == "" || b.ToolUseID == call) {
				return u.ToolUseResult
			}
		}
	}
	t.Fatalf("no result for %q in %s", call, fixture)
	return nil
}

func TestBackgroundWork(t *testing.T) {
	run := func(st AgentStatus, background bool, depth int) AgentRun {
		return AgentRun{ID: "a", Status: st, Background: background, SpawnDepth: depth}
	}
	tests := []struct {
		name string
		s    Session
		want bool
	}{
		{"nothing", Session{}, false},
		{"a shell", Session{BackgroundShellsRunning: 1}, true},
		{"a background agent", Session{AgentRuns: []AgentRun{run(AgentRunning, true, 1)}}, true},
		{"a foreground agent (part of the turn)", Session{AgentRuns: []AgentRun{run(AgentRunning, false, 1)}}, false},
		{"a nested background run alone", Session{AgentRuns: []AgentRun{run(AgentRunning, true, 2)}}, false},
		{"a finished background agent", Session{AgentRuns: []AgentRun{run(AgentDone, true, 1)}}, false},
		{"both", Session{BackgroundShellsRunning: 2, AgentRuns: []AgentRun{run(AgentRunning, true, 1)}}, true},
		{"Claude's turn for an end is due", Session{WakePending: true}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.s.BackgroundWork(); got != tt.want {
				t.Errorf("BackgroundWork() = %v, want %v", got, tt.want)
			}
		})
	}
}

func shellsRunning(n int) func(Session) bool {
	return func(s Session) bool { return s.BackgroundShellsRunning == n }
}

// The captures through the runner (the fake replays one turn per message): the call
// runs past its turn and the Session counts the shell; the next message replays the
// end and Claude's own turn: the call done or failed with the summary, the count 0.
func TestBgShellsThroughTheStream(t *testing.T) {
	tests := []struct {
		fixture, call, launch string
		status                ToolStatus
		output                string
	}{
		{"shells", fxShellCall, "Command running in background", ToolDone,
			`Background command "Run sleep 15 then echo done in background" completed (exit code 0)`},
		{"shells-fail", fxFailCall, "Command running in background", ToolError,
			`Background command "Run sleep then echo oops and exit 3 in background" failed with exit code 3`},
		{"shells-monitor", fxMonitorCall, "Monitor started", ToolDone, `Monitor "Wait for ready file" stream ended`},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			e := newFixtureEnv(t, tt.fixture)
			s := e.create(CreateOptions{InitialPrompt: "launch"})
			items := e.waitItems(s.ID, "launched", turnCount(1))
			if it := agentItem(t, items, tt.call); it.Tool.Status != ToolRunning || !strings.HasPrefix(it.Tool.Output, tt.launch) {
				t.Errorf("call after its turn %+v", it.Tool)
			}
			if got := e.waitFor(s.ID, "a shell", shellsRunning(1)); !got.BackgroundWork() {
				t.Errorf("no background work: %+v", got)
			}

			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "next"}); err != nil {
				t.Fatal(err)
			}
			items = e.waitItems(s.ID, "the end and Claude's turn", turnCount(2))
			if got := e.waitFor(s.ID, "no shell", shellsRunning(0)); got.BackgroundWork() {
				t.Errorf("background work after the end: %+v", got)
			}
			if it := agentItem(t, items, tt.call); it.Tool.Status != tt.status || it.Tool.Output != tt.output {
				t.Errorf("call after the end %s %q", it.Tool.Status, it.Tool.Output)
			}
			if n := noteItems(items); len(n) != 0 {
				t.Errorf("notes %+v", n)
			}
		})
	}
}

// TaskStop in the turn: the shell ends before the turn does.
func TestBgShellStoppedInItsTurn(t *testing.T) {
	e := newFixtureEnv(t, "shells-stop")
	s := e.create(CreateOptions{InitialPrompt: "launch and stop"})
	items := e.waitItems(s.ID, "the turn", turnCount(1))
	if it := agentItem(t, items, fxStopCall); it.Tool.Status != ToolError || it.Tool.Output != "stopped" {
		t.Errorf("stopped call %+v", it.Tool)
	}
	if it := agentItem(t, items, fxTaskStop); it.Tool.Status != ToolDone {
		t.Errorf("TaskStop call %+v", it.Tool)
	}
	e.waitFor(s.ID, "no shell", shellsRunning(0))
}

// Shells run inside the thread's process: when it ends or the daemon stops, the shells
// it left running end with it.
func TestBgShellsOrphaned(t *testing.T) {
	t.Run("process ended", func(t *testing.T) {
		e := newFixtureEnv(t, "shells")
		s := e.create(CreateOptions{InitialPrompt: "launch"})
		e.waitItems(s.ID, "launched", turnCount(1))
		e.waitFor(s.ID, "a shell", shellsRunning(1))
		e.exit(s.ID, 0)
		got := e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
		if got.BackgroundShellsRunning != 0 || got.BackgroundWork() {
			t.Errorf("shells %d", got.BackgroundShellsRunning)
		}
		if it := agentItem(t, e.items(s.ID).Items, fxShellCall); it.Tool.Status != ToolError || !it.Tool.IsError ||
			it.Tool.Output != "the thread's process ended before the shell finished" {
			t.Errorf("call %+v", it.Tool)
		}
	})
	t.Run("daemon stopped", func(t *testing.T) {
		e := newFixtureEnv(t, "shells")
		s := e.create(CreateOptions{InitialPrompt: "launch"})
		e.waitItems(s.ID, "launched", turnCount(1))
		e.waitFor(s.ID, "a shell", shellsRunning(1))
		e.restart()
		if got := e.snapshot(s.ID); got.BackgroundShellsRunning != 0 {
			t.Errorf("shells after the restart %d", got.BackgroundShellsRunning)
		}
		if it := agentItem(t, e.items(s.ID).Items, fxShellCall); it.Tool.Status != ToolError ||
			it.Tool.Output != "the daemon stopped before the shell finished" {
			t.Errorf("call %+v", it.Tool)
		}
	})
}

// An effort change waits for the shell: restarting Claude would kill it.
func TestBgShellBlocksTheEffortRestart(t *testing.T) {
	e := newFixtureEnv(t, "shells")
	s := e.create(CreateOptions{Effort: "low", InitialPrompt: "launch"})
	e.waitItems(s.ID, "launched", turnCount(1))
	e.waitFor(s.ID, "a shell at the prompt", func(s Session) bool { return s.BackgroundShellsRunning == 1 && turnOver(s) })
	got, err := e.m.SetEffort(e.ctx(), s.ID, "high")
	if err != nil || !got.EffortPending {
		t.Fatalf("set effort %+v %v", got, err)
	}
	if e.restartBegun(s.ID) {
		t.Fatalf("restarted with a shell running")
	}
	// The shell ends (and Claude's own turn): now it restarts.
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "next"}); err != nil {
		t.Fatal(err)
	}
	e.waitArgv("the restart after the shell", func(a []string) bool { return argOf(a, "--effort") == "high" })
	e.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.State == StateConnected })
}

// restartBegun reports whether the thread's runner began an effort restart. It goes
// through the runner's goroutine first (a SetEffort to the effort already wanted), so
// every event the runner had taken, and the maybeRestart after it, is done.
func (e *env) restartBegun(id string) bool {
	e.t.Helper()
	r, _, _, s, err := e.m.lifecycle(id)
	if err != nil || r == nil {
		e.t.Fatalf("thread %s is not running (%v)", id, err)
	}
	if _, err := e.m.SetEffort(e.ctx(), id, s.Effort); err != nil {
		e.t.Fatal(err)
	}
	return r.st.restart != restartNone
}

// A shell that task_updated ended keeps that end when its process goes before the
// notification: the call gets Claude's status and no longer follows the shell.
func TestBgShellOrphanKeepsTheUpdatedEnd(t *testing.T) {
	tests := []struct {
		fixture, call string
		status        ToolStatus
		output        string // "": the launch text stays
	}{
		{"shells", fxShellCall, ToolDone, ""},
		{"shells-fail", fxFailCall, ToolError, "failed"},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			data, err := os.ReadFile(fixturePath(tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			log := newThreadLog("s", bus.New(), time.Now, nil)
			p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
			var set shellSet
			var sp claudestream.Splitter
			for _, line := range sp.Split(nil, data) {
				ev := claudestream.Parse(line)
				p.event(ev)
				if tk, ok := ev.(*claudestream.Task); ok {
					set.task(tk, time.Now(), nil).apply(p)
					if tk.Subtype == claudestream.TaskUpdated {
						break // the process ends before the notification
					}
				}
			}
			ends := set.orphan(orphanProcessEnded)
			if len(ends) != 1 || !ends[0].final || ends[0].shell.ToolUseID != tt.call {
				t.Fatalf("ends %+v", ends)
			}
			ends[0].apply(p)
			if p.async[tt.call] {
				t.Errorf("the call still follows the shell")
			}
			it, _ := log.get(tt.call)
			if it.Tool.Status != tt.status || (tt.output != "" && it.Tool.Output != tt.output) ||
				(tt.output == "" && !strings.HasPrefix(it.Tool.Output, "Command running in background")) {
				t.Errorf("call %s %q", it.Tool.Status, it.Tool.Output)
			}
			if len(set.orphan(orphanProcessEnded)) != 0 {
				t.Errorf("ended twice")
			}
		})
	}
}

// When a background shell or agent ends while Claude is at its prompt, Claude starts a
// turn by itself to report it. An effort change must wait for that turn: restarting in
// the gap would close stdin under the reply. The fake replays the capture's second turn
// unprompted: its end frames, then (held) the turn's init, reply and result.
func TestBackgroundEndHoldsTheEffortRestartForClaudesTurn(t *testing.T) {
	tests := []struct {
		fixture string
		running func(Session) bool
	}{
		{"shells", func(s Session) bool { return s.BackgroundShellsRunning == 1 }},
		{"agents", func(s Session) bool { _, bg := s.AgentsRunning(); return bg == 1 }},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			gates := t.TempDir()
			release := func(name string) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(gates, name), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			e := newFixtureEnvAt(t, fixturePath(tt.fixture), []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + gates})
			s := e.create(CreateOptions{Effort: "low", InitialPrompt: "launch"})
			e.waitItems(s.ID, "launched", turnCount(1))
			e.waitFor(s.ID, "background work at the prompt", func(s Session) bool { return tt.running(s) && turnOver(s) })
			if got, err := e.m.SetEffort(e.ctx(), s.ID, "high"); err != nil || !got.EffortPending {
				t.Fatalf("set effort %+v %v", got, err)
			}
			if e.restartBegun(s.ID) {
				t.Fatalf("restarted with background work running")
			}

			// The end frames: nothing runs any more, but Claude's turn is due.
			release("turn-2")
			got := e.waitFor(s.ID, "the end, a wake due", func(s Session) bool { return !tt.running(s) && s.WakePending })
			if !got.BackgroundWork() {
				t.Errorf("no background work while the wake is due: %+v", got)
			}
			if e.restartBegun(s.ID) {
				t.Fatalf("restarted between the end and Claude's own turn")
			}

			// Claude's turn: once it ended, the restart goes ahead.
			release("turn-2.init")
			e.waitArgv("the restart after Claude's turn", func(a []string) bool { return argOf(a, "--effort") == "high" })
			got = e.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && !s.WakePending && s.State == StateConnected })
			if got.BackgroundWork() {
				t.Errorf("background work after the turn: %+v", got)
			}
			items := e.waitItems(s.ID, "the effort note", hasEffortNote("high"))
			var ends []Item
			for _, it := range items {
				if it.Kind == KindTurnEnd {
					ends = append(ends, it)
				}
				if it.Tool != nil && strings.Contains(it.Tool.Output, "Claude restarted") {
					t.Errorf("cut by the restart: %+v", it.Tool)
				}
			}
			note := items[slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput })]
			if len(ends) != 2 || ends[1].Turn == nil || ends[1].Turn.IsError || ends[1].Ordinal > note.Ordinal {
				t.Errorf("Claude's own turn did not end before the restart:\n%s", describeItems(items))
			}
		})
	}
}

// No turn comes after the end (Claude stayed quiet): the hold lapses after WakeTimeout.
func TestBackgroundWakeTimesOut(t *testing.T) {
	gates := t.TempDir()
	e := newFixtureEnvAt(t, fixturePath("shells"), []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + gates},
		func(o *Options) { o.WakeTimeout = 150 * time.Millisecond })
	s := e.create(CreateOptions{Effort: "low", InitialPrompt: "launch"})
	e.waitItems(s.ID, "launched", turnCount(1))
	e.waitFor(s.ID, "a shell at the prompt", func(s Session) bool { return s.BackgroundShellsRunning == 1 && turnOver(s) })
	if _, err := e.m.SetEffort(e.ctx(), s.ID, "high"); err != nil {
		t.Fatal(err)
	}
	// The end frames only; the turn's init never comes.
	if err := os.WriteFile(filepath.Join(gates, "turn-2"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "a wake due", func(s Session) bool { return s.WakePending })
	e.waitArgv("the restart after the timeout", func(a []string) bool { return argOf(a, "--effort") == "high" })
	e.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && !s.WakePending })
}
