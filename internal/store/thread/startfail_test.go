package thread

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A new thread whose claude never comes up keeps its first prompt: the timeline has
// the user's message, then the error, then the daemon's turn end, also after a restart
// (the items are persisted), so the user can copy or resend it.
func TestCreateStartFailureKeepsThePrompt(t *testing.T) {
	tests := []struct {
		name     string
		env      func(t *testing.T) *env
		wantText string
	}{
		{
			name:     "claude exits before its handshake",
			env:      func(t *testing.T) *env { return newFixtureEnv(t, "no-such-fixture") },
			wantText: "Claude did not start: exit code 2: fake claude",
		},
		{
			name: "claude never answers its handshake",
			env: func(t *testing.T) *env {
				gate := initGate(t) // never opened
				return newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path},
					func(o *Options) { o.StartTimeout = 500 * time.Millisecond })
			},
			wantText: "Claude did not start: no answer to the initialize handshake",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := tt.env(t)
			s := e.create(CreateOptions{InitialPrompt: "my long carefully written prompt"})
			e.waitFor(s.ID, "the failed start", func(s Thread) bool {
				return s.State == StateDisconnected && s.StatusReason == ReasonStartFailed
			})
			check := func(when string) {
				items := e.items(s.ID).Items
				if len(items) != 3 || items[0].Kind != KindUserMessage || items[0].Text != "my long carefully written prompt" ||
					items[1].Kind != KindError || !strings.HasPrefix(items[1].Text, tt.wantText) ||
					items[2].ID != synthTurnPrefix+items[0].ID || items[0].Queued {
					t.Errorf("%s: want the prompt, %q, then the turn end:\n%s", when, tt.wantText, describeItems(items))
				}
			}
			check("now")
			e.restart()
			check("after a restart")
		})
	}
}

func TestWakeBackoff(t *testing.T) {
	tests := []struct {
		n    int
		want time.Duration
	}{
		{1, time.Minute}, {2, 2 * time.Minute}, {3, 4 * time.Minute}, {6, 32 * time.Minute}, {7, time.Hour}, {100, time.Hour},
	}
	for _, tt := range tests {
		if got := wakeBackoff(time.Minute, tt.n); got != tt.want {
			t.Errorf("wakeBackoff(1m, %d) = %s, want %s", tt.n, got, tt.want)
		}
	}
}

// After a failed start, wakes to the thread wait (Options.WakeStartBackoff, doubling
// with each failure) instead of starting Claude for every one; a held queue keeps a
// subscription's latest wake. A user's message always tries.
func TestWakesBackOffAfterAFailedStart(t *testing.T) {
	const backoff = 600 * time.Millisecond
	e := newFixtureEnv(t, "no-such-fixture", func(o *Options) { o.WakeStartBackoff = backoff })
	s := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitFor(s.ID, "the failed start", func(s Thread) bool { return stopped(s) && s.StatusReason == ReasonStartFailed })
	failedAt := time.Now()
	wake := func(sub, text string) {
		e.m.mu.Lock()
		e.m.subs.mu.Lock()
		e.m.enqueueLocked(s.ID, delivery{sub: sub, msg: func(context.Context) Message {
			return Message{Text: text, Origin: OriginWake, WakeTitle: text}
		}})
		e.m.subs.mu.Unlock()
		e.m.mu.Unlock()
	}
	wakes := func() []string {
		var out []string
		for _, it := range e.items(s.ID).Items {
			if it.Origin == OriginWake {
				out = append(out, it.Text)
			}
		}
		return out
	}
	wake("a", "a1")
	wake("a", "a2") // replaces a1 in the held queue
	wake("b", "b1")
	time.Sleep(backoff / 3)
	if got := wakes(); len(got) != 0 && time.Since(failedAt) < backoff {
		t.Fatalf("wakes delivered during the backoff: %v", got)
	}
	e.waitItems(s.ID, "the first wake's failed start", func(items []Item) bool { return kindCount(items, KindError) == 2 })
	if got := wakes(); len(got) != 1 || got[0] != "a2" {
		t.Fatalf("after the first backoff: wakes %v, want [a2]", got)
	}
	secondAt := time.Now()
	time.Sleep(backoff) // the second backoff is twice as long
	if got := wakes(); len(got) != 1 && time.Since(secondAt) < 2*backoff {
		t.Fatalf("a wake went before the doubled backoff: %v", got)
	}
	e.waitItems(s.ID, "the second wake's failed start", func(items []Item) bool { return kindCount(items, KindError) == 3 })
	if got := wakes(); len(got) != 2 || got[1] != "b1" {
		t.Errorf("wakes %v, want [a2 b1]", got)
	}

	// A user's message tries at once, backoff or not.
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "mine"}); err != nil {
		t.Fatal(err)
	}
	e.waitItems(s.ID, "the message's failed start", func(items []Item) bool { return kindCount(items, KindError) == 4 })
}

// A start that comes up ends the backoff.
func TestWakeBackoffEndsWhenAStartWorks(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{NoProject: true, InitialPrompt: "first"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.m.mu.Lock()
	e.m.recs[s.ID].noteStartFailed()
	e.m.mu.Unlock()
	if e.m.wakeHold(s.ID) <= 0 {
		t.Fatal("no hold after a failed start")
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "started", func(s Thread) bool { return s.State == StateConnected })
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if d := e.m.wakeHold(s.ID); d > 0 {
		t.Errorf("hold %s after a start that came up", d)
	}
}
