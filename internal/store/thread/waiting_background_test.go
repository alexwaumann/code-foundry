package thread

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The reason grammar (docs/notes/waiting-background-tasks.md): "waiting" alone for a
// wake, else the non-zero parts in order, joined by " and ".
func TestWaitingReasonParts(t *testing.T) {
	tests := []struct {
		w    Waiting
		want string
	}{
		{Waiting{}, "waiting"},
		{Waiting{Children: 2}, "waiting on 2 child threads"},
		{Waiting{Children: 1}, "waiting on 1 child thread"},
		{Waiting{Subagents: 1}, "waiting on 1 subagent"},
		{Waiting{Shells: 2}, "waiting on 2 shells"},
		{Waiting{Children: 2, Subagents: 1}, "waiting on 2 child threads and 1 subagent"},
		{Waiting{Subagents: 1, Shells: 2}, "waiting on 1 subagent and 2 shells"},
		{Waiting{Children: 1, Subagents: 2, Shells: 1}, "waiting on 1 child thread and 2 subagents and 1 shell"},
	}
	for _, tt := range tests {
		got := tt.w.Reason()
		if got != tt.want {
			t.Errorf("%+v.Reason() = %q; want %q", tt.w, got, tt.want)
		}
		if back, ok := ParseWaiting(got); !ok || back != tt.w {
			t.Errorf("ParseWaiting(%q) = %+v, %v; want %+v", got, back, ok, tt.w)
		}
		if n, ok := WaitingOn(got); !ok || n != tt.w.Children {
			t.Errorf("WaitingOn(%q) = %d, %v; want the child count %d", got, n, ok, tt.w.Children)
		}
	}
	if _, ok := ParseWaiting("finished"); ok {
		t.Error("finished parsed as waiting")
	}
}

// The thread's own background work makes a plainly ended turn wait, alone or with child
// threads; anything that needs the user still wins, and work counts only while the
// process runs.
func TestWaitingOnBackgroundWork(t *testing.T) {
	bg := func(depth int) AgentRun {
		return AgentRun{ID: "a" + string(rune('0'+depth)), Status: AgentRunning, Background: true, SpawnDepth: depth}
	}
	fg := AgentRun{ID: "f", Status: AgentRunning, SpawnDepth: 1}
	done := AgentRun{ID: "d", Status: AgentDone, Background: true, SpawnDepth: 1}
	offFinished := step{StateDisconnected, StatusNeedsAttention, "finished", ""}
	tests := []struct {
		name  string
		child bool // p subscribes to a busy child thread
		p     step
		runs  []AgentRun
		shell int
		wake  bool
		want  step
	}{
		{name: "children only", child: true, p: finished, want: waitingStep(1)},
		{name: "a subagent", p: finished, runs: []AgentRun{bg(1)}, want: shown("waiting on 1 subagent")},
		{name: "two shells", p: finished, shell: 2, want: shown("waiting on 2 shells")},
		{name: "a child and a subagent", child: true, p: finished, runs: []AgentRun{bg(1)},
			want: shown("waiting on 1 child thread and 1 subagent")},
		{name: "a subagent and two shells, seen", p: atPrompt, runs: []AgentRun{bg(1), done}, shell: 2,
			want: shown("waiting on 1 subagent and 2 shells")},
		{name: "everything", child: true, p: finished, runs: []AgentRun{bg(1)}, shell: 1,
			want: shown("waiting on 1 child thread and 1 subagent and 1 shell")},
		{name: "Claude's report due alone", p: finished, wake: true, want: shown("waiting")},
		{name: "a shell and the report due", p: finished, shell: 1, wake: true, want: shown("waiting on 1 shell")},
		{name: "a foreground or nested run is the turn's", p: finished, runs: []AgentRun{fg, bg(2), done}, want: finished},
		{name: "a question wins", p: askWhich, shell: 1, want: askWhich},
		{name: "busy is busy", p: busy, runs: []AgentRun{bg(1)}, shell: 1, want: busy},
		{name: "no process, no work", p: offFinished, runs: []AgentRun{bg(1)}, shell: 1, want: offFinished},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			p := e.stopped("p")
			if tt.child {
				c := e.stopped("c")
				e.setStep(c.ID, busy)
				if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: p.ID, TargetThreadID: c.ID, Condition: CondSettled, Repeat: true}); err != nil {
					t.Fatal(err)
				}
			}
			e.m.update(p.ID, false, func(rec *record) {
				rec.s.AgentRuns, rec.s.BackgroundShellsRunning, rec.s.WakePending = tt.runs, tt.shell, tt.wake
			})
			e.setStep(p.ID, tt.p)
			e.waitFor(p.ID, tt.want.status.String()+" ("+tt.want.reason+")", func(s Thread) bool {
				return s.Status == tt.want.status && s.StatusReason == tt.want.reason
			})
		})
	}

	// The work ends: the overlay follows the counts, and the raw status comes back.
	t.Run("the work ends", func(t *testing.T) {
		e := newEnv(t)
		p := e.stopped("p")
		e.setStep(p.ID, finished)
		set := func(agents, shells int) {
			runs := []AgentRun{}
			for i := range agents {
				runs = append(runs, AgentRun{ID: string(rune('a' + i)), Status: AgentRunning, Background: true, SpawnDepth: 1})
			}
			e.m.update(p.ID, false, func(rec *record) { rec.s.AgentRuns, rec.s.BackgroundShellsRunning = runs, shells })
		}
		set(1, 1)
		e.waitFor(p.ID, "both", func(s Thread) bool { return s.StatusReason == "waiting on 1 subagent and 1 shell" })
		set(0, 1)
		e.waitFor(p.ID, "a shell", func(s Thread) bool { return s.StatusReason == "waiting on 1 shell" })
		set(0, 0)
		e.waitFor(p.ID, "finished", func(s Thread) bool { return s.Status == StatusNeedsAttention && s.StatusReason == "finished" })
	})

	// A child waiting on its own shell keeps its parent waiting (pendingLocked), as a
	// lead waiting on its workers does.
	t.Run("a parent waits on a child waiting on its shell", func(t *testing.T) {
		e := newEnv(t)
		p, c := e.stopped("p"), e.stopped("c")
		e.setStep(c.ID, busy)
		if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: p.ID, TargetThreadID: c.ID, Condition: CondAttention, Repeat: true}); err != nil {
			t.Fatal(err)
		}
		e.m.update(c.ID, false, func(rec *record) { rec.s.BackgroundShellsRunning = 1 })
		e.setStep(c.ID, finished)
		e.setStep(p.ID, finished)
		e.waitFor(c.ID, "the child waiting", func(s Thread) bool { return s.StatusReason == "waiting on 1 shell" })
		e.waitFor(p.ID, "the parent waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
	})
}

func shown(reason string) step { return step{StateConnected, StatusIdle, reason, ""} }

// End to end with a real runner: a background shell or agent run outlives the turn,
// which then shows waiting (no "finished": no bell); the end frames keep it waiting
// while Claude's report is due; Claude's own turn is busy, and its end is finished
// (the one bell, for the report).
func TestWaitingOnBackgroundWorkUntilTheReport(t *testing.T) {
	tests := []struct {
		fixture, reason string
	}{
		{"shells", "waiting on 1 shell"},
		{"agents", "waiting on 1 subagent"},
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
			sub := bus.Subscribe[Event](e.bus, 4096)
			defer sub.Close()
			s := e.create(CreateOptions{InitialPrompt: "launch"})
			e.waitItems(s.ID, "launched", turnCount(1))
			e.waitFor(s.ID, tt.reason, func(s Thread) bool { return s.Status == StatusIdle && s.StatusReason == tt.reason })

			release("turn-2")
			e.waitFor(s.ID, "the report due", func(s Thread) bool { return s.WakePending && s.StatusReason == ReasonWaiting })
			release("turn-2.init")
			e.waitFor(s.ID, "the report's turn ended", func(s Thread) bool {
				return !s.WakePending && s.Status == StatusNeedsAttention && s.StatusReason == "finished"
			})

			// The report's turn is busy as ever; the fake replays it faster than the
			// status debounce, which may fold that busy away (the live check saw it).
			seen := shownStatuses(sub, s.ID)
			want := []string{"idle (" + tt.reason + ")", "idle (waiting)", "needs attention (finished)"}
			at := slices.Index(seen, want[0])
			rest := slices.DeleteFunc(slices.Clone(seen[max(at, 0):]), func(w string) bool { return w == "busy (working)" })
			if at < 0 || !slices.Equal(rest, want) {
				t.Errorf("statuses = %q; want them to end %q (busy allowed before finished)", seen, want)
			}
			if b := slices.Index(seen[max(at, 0):], "busy (working)"); b >= 0 && b != len(seen[at:])-2 {
				t.Errorf("busy before the end frames: %q", seen)
			}
			if at >= 0 && slices.Contains(seen[:at], "needs attention (finished)") {
				t.Errorf("the first turn rang finished before it waited: %q", seen)
			}
		})
	}
}

// Claude reports nothing after the end (no turn within WakeTimeout): the thread waits
// on nothing any more and shows its ended turn, finished, as it did before this rule.
func TestWaitingOnBackgroundWorkNoReport(t *testing.T) {
	gates := t.TempDir()
	e := newFixtureEnvAt(t, fixturePath("shells"), []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + gates},
		func(o *Options) { o.WakeTimeout = 150 * time.Millisecond })
	s := e.create(CreateOptions{InitialPrompt: "launch"})
	e.waitItems(s.ID, "launched", turnCount(1))
	e.waitFor(s.ID, "waiting on the shell", func(s Thread) bool { return s.StatusReason == "waiting on 1 shell" })
	if err := os.WriteFile(filepath.Join(gates, "turn-2"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "finished once the wake lapsed", func(s Thread) bool {
		return !s.WakePending && s.BackgroundShellsRunning == 0 && s.Status == StatusNeedsAttention && s.StatusReason == "finished"
	})
}

// shownStatuses drains sub's updates of thread id into their distinct statuses in order.
func shownStatuses(sub *bus.Subscription[Event], id string) []string {
	var seen []string
	for len(sub.C()) > 0 {
		if u, ok := (<-sub.C()).(Updated); ok && u.Thread.ID == id {
			w := statusWords(u.Thread)
			if len(seen) == 0 || seen[len(seen)-1] != w {
				seen = append(seen, w)
			}
		}
	}
	return seen
}
