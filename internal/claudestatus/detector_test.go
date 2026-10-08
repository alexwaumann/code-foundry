package claudestatus

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// step is one input to the detector at a time offset, optionally followed by an
// expected status.
type step struct {
	ms     int
	out    string // Output
	tr     string // Transcript
	in     string // Input
	ack    bool   // Acknowledge
	tick   bool   // Tick
	screen *string
	want   Status
	reason string // expected reason prefix ("" = don't check)
	check  bool
}

func out(ms int, s string) step { return step{ms: ms, out: s} }
func tr(ms int, s string) step  { return step{ms: ms, tr: s} }
func in(ms int, s string) step  { return step{ms: ms, in: s} }
func tick(ms int) step          { return step{ms: ms, tick: true} }
func scr(ms int, s string) step { return step{ms: ms, screen: &s} }
func want(ms int, st Status, why string) step {
	return step{ms: ms, want: st, reason: why, check: true}
}

func title(t string) string { return "\x1b]0;" + t + "\x07" }

var (
	promptScreen = rule + "\n❯ \n" + rule + "\n  -- INSERT --"
	permScreen   = rule + "\n Bash command\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend"
	exitScreen   = "Resume this session with:\nclaude --resume 2b00"

	lineUserPrompt = `{"type":"user","message":{"role":"user","content":"hi"}}`
	lineToolUse    = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}`
	lineToolResult = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}}`
	lineEndTurn    = `{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}`
	lineTurnEnd    = `{"type":"system","subtype":"turn_duration","durationMs":5}`
	lineAPIError   = `{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","message":{"role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"x"}]}}`
	lineInterrupt  = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`
)

func runSteps(t *testing.T, withScreen bool, steps []step) {
	t.Helper()
	now := replayBase
	screen := ""
	var fn func() (string, error)
	if withScreen {
		fn = func() (string, error) { return screen, nil }
	}
	d := New(fn, WithClock(func() time.Time { return now }))
	for i, s := range steps {
		now = replayBase.Add(time.Duration(s.ms) * time.Millisecond)
		switch {
		case s.screen != nil:
			screen = *s.screen
		case s.out != "":
			d.Output([]byte(s.out))
		case s.tr != "":
			d.Transcript([]byte(s.tr))
		case s.in != "":
			d.Input([]byte(s.in))
		case s.ack:
			d.Acknowledge()
		case s.tick:
			d.Tick(now)
		case s.check:
			st, reason := d.Status()
			if st != s.want || !strings.HasPrefix(reason, s.reason) {
				t.Fatalf("step %d @%dms: got %v %q, want %v %q\nsnapshot: %+v", i, s.ms, st, reason, s.want,
					s.reason, d.Snapshot())
			}
		}
	}
}

func TestDetectorTransitions(t *testing.T) {
	tests := []struct {
		name   string
		screen bool
		steps  []step
	}{
		{"startup is unknown", true, []step{
			want(0, Unknown, "starting"),
			tick(0), want(0, Unknown, "no prompt visible"),
		}},
		{"idle title before any screen read", true, []step{
			out(100, title("✳ Claude Code")), want(100, Idle, "at prompt"),
		}},
		{"busy, then finished after a fresh screen read", true, []step{
			scr(0, promptScreen), out(0, title("✳ Claude Code")), tick(0), want(0, Idle, "at prompt"),
			in(900, "hi\r"),
			out(1000, title("◐ Claude Code")), want(1000, Busy, "working: Claude Code"),
			out(1960, title("◑ Say hi")), want(1960, Busy, "working: Say hi"),
			out(2500, title("✳ Say hi")), want(2500, Busy, ""), // hysteresis: no fresh screen yet
			tick(2600), want(2600, Busy, ""), // within settle: screen not read yet
			tick(3000), want(3000, NeedsAttention, "finished"),
			in(4000, "x"), want(4000, Idle, "at prompt"),
		}},
		{"transcript turn end with idle title decides without the screen", true, []step{
			scr(0, promptScreen), tick(0),
			in(900, "\r"), out(1000, title("◐ t")), tr(1100, lineUserPrompt),
			out(2000, title("✳ t")), want(2000, Busy, ""),
			tr(2100, lineEndTurn), want(2100, NeedsAttention, "finished"),
			tr(2101, lineTurnEnd), want(2101, NeedsAttention, "finished"),
		}},
		{"a stale pre-turn screen never reports idle over a dialog", true, []step{
			scr(0, promptScreen), tick(0),
			in(900, "\r"), out(1000, title("◐ t")), tr(1100, lineUserPrompt),
			scr(1990, permScreen), out(2000, title("✳ t")), tr(2100, lineToolUse),
			want(2100, Busy, ""), // the screen read at 0 showed a prompt; it is not used
			tick(3000), want(3000, NeedsAttention, "permission: Do you want to proceed?"),
			in(5000, "\r"), want(5000, NeedsAttention, "permission"), // the dialog is still drawn
			scr(5010, promptScreen), out(5020, title("◐ t")), want(5020, Busy, "running Bash"),
			tr(5300, lineToolResult), want(5300, Busy, "working: t"),
		}},
		{"stale spinner title stops counting as busy", true, []step{
			scr(0, promptScreen), out(0, title("◐ t")), want(0, Busy, ""),
			tick(3000), want(3000, Busy, ""),
			tick(4000), tick(5000), want(5000, NeedsAttention, "finished"),
		}},
		{"screen is not read while the title says busy", true, []step{
			out(0, title("◐ t")), tick(1000), tick(2000), want(2000, Busy, ""),
		}},
		{"pending tool without a screen waits for approval", false, []step{
			out(0, title("◐ t")), tr(100, lineUserPrompt), tr(900, lineToolUse),
			out(1000, title("✳ t")), want(1000, Busy, ""),
			tick(2000), want(2000, Busy, ""), // maxSettle not reached
			tick(3000), want(3000, NeedsAttention, "waiting for approval: Bash"),
			tr(4000, lineToolResult), want(4000, NeedsAttention, "waiting for input"),
		}},
		{"open turn without a prompt after grace", true, []step{
			scr(0, "Pick a flavour\n  vanilla\n  chocolate"), out(0, title("◐ t")), tr(100, lineUserPrompt),
			out(1000, title("✳ t")), tick(1500), want(1500, Busy, ""), // screen read, grace not up
			tick(2000), want(2000, Busy, ""),
			tick(2600), want(2600, NeedsAttention, "waiting for input"),
		}},
		{"open turn with the prompt visible is idle (interrupt without a transcript record)", true, []step{
			scr(0, promptScreen), out(0, title("◐ t")), tr(100, lineUserPrompt), in(900, "\x03"),
			out(1000, title("✳ t")), tick(2000), tick(3000), want(3000, Idle, "at prompt"),
		}},
		{"interrupt record acknowledges", true, []step{
			scr(0, promptScreen), in(0, "\r"), out(10, title("◐ t")), tr(100, lineUserPrompt),
			out(1000, title("✳ t")), tr(1100, lineEndTurn), want(1100, NeedsAttention, "finished"),
			tr(1101, lineInterrupt), want(1101, Idle, "at prompt"),
		}},
		{"api error", true, []step{
			scr(0, promptScreen), in(0, "\r"), out(10, title("◐ t")), tr(20, lineUserPrompt),
			out(300, title("✳ t")), tr(400, lineAPIError), tr(401, lineTurnEnd),
			want(401, NeedsAttention, "error: rate_limit"),
			ack(500), want(500, Idle, ""),
		}},
		{"notification", false, []step{
			out(0, title("✳ t")), want(0, Idle, ""),
			out(100, "\x1b]777;notify;Claude Code;Claude needs your permission\x07"),
			want(100, NeedsAttention, "notification: Claude needs your permission"),
			in(200, "1"), want(200, Idle, ""),
		}},
		{"idle reminder notification is not attention", false, []step{
			out(0, title("✳ t")),
			out(100, "\x1b]9;Claude is waiting for your input\x07"), want(100, Idle, ""),
		}},
		{"bell", false, []step{
			out(0, title("✳ t")), out(100, "\x07"), want(100, NeedsAttention, "bell"),
			ack(200), want(200, Idle, ""),
		}},
		{"program status protocol", false, []step{
			out(0, "\x1b]7501;state=working\x1b\\"), want(0, Busy, "working"),
			out(1000, "\x1b]7501;state=blocked:kind=permission\x1b\\"), tick(3000),
			want(3000, NeedsAttention, "blocked: permission"),
			out(4000, "\x1b]7501;state=idle\x1b\\"), in(4000, "y"), want(4000, Idle, ""),
		}},
		{"progress report", false, []step{
			out(0, "\x1b]9;4;3\x07"), want(0, Busy, ""),
			out(1000, "\x1b]9;4;0\x07"), tick(3500), want(3500, Busy, ""), tick(4500), want(4500, Unknown, "no signals yet"),
		}},
		{"output activity with an open turn is busy when there is no title", false, []step{
			tr(0, lineUserPrompt),
			out(100, "a"), out(200, "b"), out(300, "c"), out(400, "d"), want(400, Unknown, ""),
			out(500, "e"), want(500, Busy, "working"),
		}},
		{"screen spinner without a title", true, []step{
			scr(0, "✻ Ruminating… (3s · ↓ 5 tokens)\n"+rule+"\n❯ \n"+rule), out(0, "x"),
			tick(1000), want(1000, Busy, "working"),
			scr(1500, promptScreen), out(1500, "y"),
			tick(2000), want(2000, Busy, ""), // read at the busy end; settle not satisfied
			tick(3000), want(3000, NeedsAttention, "finished"),
		}},
		{"trust dialog at startup", true, []step{
			scr(0, rule+"\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel"),
			tick(1000), want(1000, NeedsAttention, "trust"),
		}},
		{"exit clears the title", true, []step{
			scr(0, promptScreen), out(0, title("✳ t")), tick(0), want(0, Idle, ""),
			scr(500, exitScreen), out(500, "\x1b[?1049l"+title("")), tick(1000), want(1000, Idle, ""), // unknownHold
			tick(2000), want(2000, Unknown, "no prompt visible"),
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) { runSteps(t, tt.screen, tt.steps) })
	}
}

func ack(ms int) step { return step{ms: ms, ack: true} }

func TestSnapshot(t *testing.T) {
	now := replayBase
	d := New(func() (string, error) { return permScreen, nil }, WithClock(func() time.Time { return now }))
	d.Output([]byte("\x1b[?1049h\x1b[?2004h" + title("◐ Touch hello.txt")))
	d.Transcript([]byte(lineUserPrompt))
	d.Transcript([]byte(lineToolUse))
	now = now.Add(time.Second)
	d.Output([]byte(title("✳ Touch hello.txt")))
	d.Tick(now.Add(time.Second))
	s := d.Snapshot()
	if s.Status != NeedsAttention || !s.AltScreen || !s.BracketedPaste || s.TitleKind != "idle" ||
		s.Screen.Dialog != DialogPermission || !s.TurnActive || len(s.PendingTools) != 1 || s.PendingTools[0] != "Bash" ||
		s.LastStopReason != "tool_use" || s.Title != "✳ Touch hello.txt" {
		t.Fatalf("snapshot: %+v", s)
	}
}

// The screen func runs without the lock: it may wait for the terminal actor, which may
// be inside Output at that moment.
func TestTickDoesNotHoldLockDuringScreen(t *testing.T) {
	var d *Detector
	d = New(func() (string, error) {
		d.Output([]byte("x")) // would self-deadlock if Tick held the lock
		return promptScreen, nil
	})
	done := make(chan struct{})
	go func() {
		d.Tick(time.Now())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Tick deadlocked calling screen")
	}
}

func TestScreenErrorIsTolerated(t *testing.T) {
	d := New(func() (string, error) { return "", errors.New("gone") })
	d.Output([]byte(title("✳ t")))
	d.Tick(time.Now())
	if st, _ := d.Status(); st != Idle {
		t.Fatalf("status %v", st)
	}
	if d.Snapshot().ScreenErr != "gone" {
		t.Fatal("screen error not recorded")
	}
}

func TestDetectorConcurrent(t *testing.T) {
	d := New(func() (string, error) { return promptScreen, nil })
	chunk := []byte(title("◐ t") + "\x1b[2;3Hhello" + title("✳ t"))
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for _, f := range []func(){
		func() { d.Output(chunk) },
		func() { d.Transcript([]byte(lineToolUse)); d.Transcript([]byte(lineToolResult)) },
		func() { d.Tick(time.Now()) },
		func() { d.Status(); d.Snapshot() },
		func() { d.Input([]byte("x")) },
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					f()
				}
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()
}
