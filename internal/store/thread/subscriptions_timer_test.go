package thread

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestFormatEvery(t *testing.T) {
	for d, want := range map[time.Duration]string{
		time.Minute: "1m", 30 * time.Minute: "30m", 2 * time.Hour: "2h", 90 * time.Minute: "1h30m",
		90 * time.Second: "1m30s", 10 * time.Second: "10s", 24 * time.Hour: "24h",
	} {
		if got := FormatEvery(d); got != want {
			t.Errorf("FormatEvery(%s) = %q, want %q", d, got, want)
		}
	}
}

func TestTimerSubscribeTarget(t *testing.T) {
	at := time.Date(2026, 10, 20, 14, 0, 0, 123456789, time.FixedZone("CDT", -5*3600))
	tests := []struct {
		name    string
		at      time.Time
		every   time.Duration
		cond    Condition
		want    string
		wantErr bool
	}{
		{name: "at, in UTC to the millisecond", at: at, want: "at:2026-10-20T19:00:00.123Z"},
		{name: "every", every: 30 * time.Minute, want: "every:30m"},
		{name: "every, settled means fired", every: time.Hour, cond: CondSettled, want: "every:1h"},
		{name: "every, fired", every: time.Minute, cond: CondFired, want: "every:1m"},
		{name: "under a minute", every: 59 * time.Second, wantErr: true},
		{name: "negative", every: -time.Minute, wantErr: true},
		{name: "both", at: at, every: time.Hour, wantErr: true},
		{name: "a thread condition", every: time.Hour, cond: CondIdle, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, c, err := TimerTarget(tt.at, tt.every, tt.cond)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("err = %v, want invalid argument", err)
				}
				return
			}
			if err != nil || got != tt.want || c != CondFired {
				t.Fatalf("= %q %q %v, want %q fired", got, c, err, tt.want)
			}
			gotAt, gotEvery, ok := parseTimerTarget(got)
			if !ok || gotEvery != tt.every || (tt.every == 0 && !gotAt.Equal(tt.at.Truncate(time.Millisecond))) {
				t.Errorf("parse(%q) = %v %v %v", got, gotAt, gotEvery, ok)
			}
		})
	}
	for _, bad := range []string{"", "at:", "every:", "every:x", "every:-1m", "at:yesterday", "s-1"} {
		if _, _, ok := parseTimerTarget(bad); ok {
			t.Errorf("parseTimerTarget(%q) ok", bad)
		}
	}
}

func TestTimerNext(t *testing.T) {
	created := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	at := created.Add(3 * time.Hour)
	tests := []struct {
		name   string
		target string
		last   time.Time
		want   time.Time
	}{
		{name: "at", target: timerTarget(at, 0), want: at},
		{name: "every, never fired", target: "every:30m", want: created.Add(30 * time.Minute)},
		{name: "every, fired on time", target: "every:30m", last: created.Add(30 * time.Minute), want: created.Add(time.Hour)},
		{name: "every, fired late keeps the slots", target: "every:30m", last: created.Add(37 * time.Minute), want: created.Add(time.Hour)},
		{name: "every, catch-up fire after a long stop", target: "every:1h", last: created.Add(5*time.Hour + 10*time.Minute),
			want: created.Add(6 * time.Hour)},
		{name: "malformed", target: "every:x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := timerNext(Subscription{TargetKind: TargetTimer, TargetID: tt.target, CreatedAt: created, LastFiredAt: tt.last})
			if !got.Equal(tt.want) {
				t.Errorf("timerNext = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTimerWakeMessage(t *testing.T) {
	due := time.Date(2026, 10, 20, 14, 30, 0, 0, time.UTC)
	at := due.Add(4 * time.Second)
	for _, tt := range []struct {
		target, note, want, every, setAt string
	}{
		{target: "every:30m", want: "Timer sub-1 fired at " + ClockTime(at, at) + " (every 30m).", every: "30m"},
		{target: timerTarget(due, 0), want: "Timer sub-1 fired at " + ClockTime(at, at) + " (set for " + ClockTime(due, at) + ").",
			setAt: "2026-10-20T14:30:00.000Z"},
		{target: timerTarget(due, 0), note: "remind the user to review the PWA branch (t-aa39dec3)",
			want:  "Timer sub-1 fired at " + ClockTime(at, at) + " (set for " + ClockTime(due, at) + "): remind the user to review the PWA branch (t-aa39dec3).",
			setAt: "2026-10-20T14:30:00.000Z"},
		{target: "every:2m", note: "Ping the user.", want: "Timer sub-1 fired at " + ClockTime(at, at) + " (every 2m): Ping the user.", every: "2m"},
	} {
		msg := timerWake(Subscription{ID: "sub-1", TargetKind: TargetTimer, TargetID: tt.target, Condition: CondFired, Note: tt.note}, due, at)
		if msg.WakeTitle != tt.want || msg.Origin != OriginWake || !strings.HasPrefix(msg.Text, wakePrefix+tt.want+"\n```json\n") {
			t.Errorf("%s: wake = %+v", tt.target, msg)
		}
		var p map[string]any
		if err := json.Unmarshal([]byte(msg.WakeJSON), &p); err != nil {
			t.Fatal(err)
		}
		if p["kind"] != "timer" || p["subscription_id"] != "sub-1" || p["condition"] != "fired" || p["fired_at"] != "2026-10-20T14:30:04.000Z" ||
			p["due_at"] != "2026-10-20T14:30:00.000Z" || (tt.every != "" && p["every"] != tt.every) || (tt.setAt != "" && p["at"] != tt.setAt) ||
			(tt.note != "" && p["note"] != tt.note) || (tt.note == "" && p["note"] != nil) {
			t.Errorf("%s: payload = %v", tt.target, p)
		}
	}
}

// timerOpts checks the timers every few milliseconds.
func timerOpts(o *Options) { o.TimerCheckInterval = 5 * time.Millisecond }

// timerWakes are the timer wakes in thread id's items.
func (e *env) timerWakes(id string) []Item {
	e.t.Helper()
	var out []Item
	for _, it := range wakes(e.items(id).Items) {
		if strings.HasPrefix(it.WakeTitle, "Timer ") {
			out = append(out, it)
		}
	}
	return out
}

func TestTimerAt(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts)
	sub := e.stopped("sleeper")
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: clk.Now().Add(10 * time.Minute)})
	if err != nil || res.Fired || res.Subscription.Repeat || res.Subscription.TargetKind != TargetTimer || res.Subscription.Condition != CondFired {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	listed, ok := e.subscription(res.Subscription.ID)
	if !ok || !strings.HasPrefix(listed.TargetName, "at ") || !strings.HasPrefix(listed.TargetStatus, "next ") {
		t.Errorf("listed = %+v (%v)", listed, ok)
	}
	// The same timer again is the same subscription.
	if again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: clk.Now().Add(10 * time.Minute)}); err != nil ||
		!again.Existed || again.Subscription.ID != res.Subscription.ID {
		t.Errorf("again = %+v, %v", again, err)
	}

	clk.advance(9 * time.Minute)
	time.Sleep(50 * time.Millisecond)
	if w := e.timerWakes(sub.ID); len(w) != 0 {
		t.Fatalf("fired a minute early: %+v", w)
	}
	clk.advance(2 * time.Minute)
	items := e.waitItems(sub.ID, "the timer's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	if !strings.HasPrefix(w.WakeTitle, "Timer "+res.Subscription.ID+" fired at ") || !strings.Contains(w.WakeJSON, `"kind": "timer"`) {
		t.Errorf("wake = %+v", w)
	}
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Errorf("a one-shot timer was kept after it fired")
	}
	// It started the stopped subscriber, which answered.
	e.waitFor(sub.ID, "the subscriber's turn", func(s Thread) bool { return s.Status == StatusNeedsAttention && s.StatusReason == "finished" })
	time.Sleep(30 * time.Millisecond)
	if n := len(e.timerWakes(sub.ID)); n != 1 {
		t.Errorf("%d timer wakes, want 1", n)
	}
}

func TestTimerEvery(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts)
	sub := e.stopped("ticker")
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetEvery: 30 * time.Minute})
	if err != nil || res.Fired || !res.Subscription.Repeat || res.Subscription.TargetID != "every:30m" {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	clk.advance(31 * time.Minute)
	e.waitItems(sub.ID, "the first wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	clk.advance(30 * time.Minute)
	e.waitItems(sub.ID, "the second wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	got, ok := e.subscription(res.Subscription.ID)
	if !ok || got.FiredCount != 2 || got.TargetName != "every 30m" || !strings.HasPrefix(got.TargetStatus, "next ") {
		t.Errorf("listed = %+v (%v)", got, ok)
	}
	var p wakeTimerPayload
	if err := json.Unmarshal([]byte(e.timerWakes(sub.ID)[1].WakeJSON), &p); err != nil || p.Every != "30m" ||
		p.DueAt != wakeTime(res.Subscription.CreatedAt.Add(time.Hour)) {
		t.Errorf("second payload = %+v, %v", p, err)
	}

	// The daemon stops for five hours: one catch-up wake at the start, then the schedule.
	ctx := e.ctx()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	clk.advance(5 * time.Hour)
	e.open(clk.opts(), timerOpts)
	e.waitItems(sub.ID, "the catch-up wake", func(items []Item) bool { return len(wakes(items)) == 3 })
	time.Sleep(50 * time.Millisecond)
	if n := len(e.timerWakes(sub.ID)); n != 3 {
		t.Fatalf("%d timer wakes after the restart, want 3", n)
	}
	clk.advance(30 * time.Minute)
	e.waitItems(sub.ID, "the next slot's wake", func(items []Item) bool { return len(wakes(items)) == 4 })

	// Unsubscribing every timer of the thread ends it.
	gone, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: sub.ID, TargetTimer: true})
	if err != nil || len(gone) != 1 || gone[0].ID != res.Subscription.ID {
		t.Fatalf("Unsubscribe = %+v, %v", gone, err)
	}
	if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: sub.ID, TargetTimer: true}); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Unsubscribe err = %v, want not found", err)
	}
}

func TestTimerAtFiresAfterRestart(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts)
	sub := e.stopped("sleeper")
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: clk.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	ctx := e.ctx()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	clk.advance(3 * time.Hour) // the time passed while the daemon was stopped
	e.open(clk.opts(), timerOpts)
	e.waitItems(sub.ID, "the late wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Errorf("the one-shot timer was kept after its late fire")
	}
}

func TestTimerRefusedAndCleanedUp(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts)
	sub := e.stopped("sub")
	for _, o := range []SubscribeOptions{
		{SubscriberID: sub.ID, TargetAt: clk.Now().Add(-time.Minute)},
		{SubscriberID: sub.ID, TargetAt: clk.Now()},
		{SubscriberID: sub.ID, TargetEvery: 30 * time.Second},
		{SubscriberID: sub.ID, TargetEvery: time.Hour, TargetThreadID: sub.ID},
		{SubscriberID: sub.ID, TargetEvery: time.Hour, Condition: CondIdle},
	} {
		if _, err := e.m.Subscribe(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Subscribe(%+v) err = %v, want invalid argument", o, err)
		}
	}
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetEvery: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Archive(e.ctx(), sub.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Errorf("the timer outlived its archived subscriber")
	}
	clk.advance(2 * time.Hour)
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(e.items(sub.ID).Items)); n != 0 {
		t.Errorf("the archived subscriber got %d wakes", n)
	}
}

func TestTimerWakeLimit(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts, func(o *Options) { o.WakeLimit = 1 })
	sub := e.stopped("busy")
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetEvery: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	clk.advance(61 * time.Second)
	e.waitItems(sub.ID, "the first wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	clk.advance(time.Minute) // over the limit: dropped, tried again a minute later
	time.Sleep(50 * time.Millisecond)
	if got, _ := e.subscription(res.Subscription.ID); got.FiredCount != 1 {
		t.Errorf("fired %d, want 1 (the second dropped)", got.FiredCount)
	}
	clk.advance(time.Hour) // the window rolled
	e.waitItems(sub.ID, "the wake after the window", func(items []Item) bool { return len(wakes(items)) == 2 })
}

func TestCleanNote(t *testing.T) {
	for _, tt := range []struct {
		in, want string
		bad      bool
	}{
		{in: "", want: ""},
		{in: "  remind the user\n  to review   t-aa39dec3 ", want: "remind the user to review t-aa39dec3"},
		{in: strings.Repeat("é", MaxNote), want: strings.Repeat("é", MaxNote)},
		{in: strings.Repeat("x", MaxNote+1), bad: true},
	} {
		got, err := CleanNote(tt.in)
		if tt.bad != errors.Is(err, ErrInvalidArgument) || got != tt.want {
			t.Errorf("CleanNote(%q) = %q, %v", tt.in, got, err)
		}
	}
}

// A timer's note is kept, listed, persisted, replaced by a second subscribe that gives
// one, and carried by the wake; the changes are published as SubscriptionsChanged.
func TestTimerNote(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts)
	changes := bus.Subscribe[SubscriptionsChanged](e.bus, 64)
	defer changes.Close()
	sub := e.stopped("noted")
	changed := func(what string) {
		t.Helper()
		select {
		case ev := <-changes.C():
			if ev.SubscriberID != sub.ID {
				t.Errorf("%s: subscriber %q", what, ev.SubscriberID)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: no SubscriptionsChanged", what)
		}
	}
	at := clk.Now().Add(10 * time.Minute)
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: at, Note: strings.Repeat("x", MaxNote+1)}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a long note: err = %v, want invalid argument", err)
	}
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: at, Note: "review the\nPWA branch"})
	if err != nil || res.Subscription.Note != "review the PWA branch" {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	changed("subscribe")
	listed, ok := e.subscription(res.Subscription.ID)
	if !ok || listed.Note != "review the PWA branch" || !listed.NextAt.Equal(at.Truncate(time.Millisecond)) || listed.Every != 0 {
		t.Errorf("listed = %+v (%v)", listed, ok)
	}
	// Again without a note keeps it; with one replaces it.
	if again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: at}); err != nil || !again.Existed ||
		again.Subscription.Note != "review the PWA branch" {
		t.Errorf("again = %+v, %v", again, err)
	}
	if again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetAt: at, Note: "review PR #12"}); err != nil ||
		!again.Existed || again.Subscription.Note != "review PR #12" {
		t.Errorf("again with a note = %+v, %v", again, err)
	}
	changed("the note replaced")
	every, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: sub.ID, TargetEvery: 30 * time.Minute, Note: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	changed("a second timer")
	if got, _ := e.subscription(every.Subscription.ID); got.Every != 30*time.Minute || !got.NextAt.Equal(every.Subscription.CreatedAt.Add(30*time.Minute)) {
		t.Errorf("every listed = %+v", got)
	}

	// The note survives a restart.
	if err := e.m.Shutdown(e.ctx()); err != nil {
		t.Fatal(err)
	}
	e.open(clk.opts(), timerOpts)
	if got, ok := e.subscription(res.Subscription.ID); !ok || got.Note != "review PR #12" {
		t.Errorf("after the restart = %+v (%v)", got, ok)
	}

	// The wake carries it; the one-shot goes.
	clk.advance(11 * time.Minute)
	e.waitItems(sub.ID, "the wake", func([]Item) bool { return len(e.timerWakes(sub.ID)) == 1 })
	w := e.timerWakes(sub.ID)[0]
	if !strings.HasSuffix(w.WakeTitle, "): review PR #12.") || !strings.Contains(w.WakeJSON, `"note": "review PR #12"`) {
		t.Errorf("wake = %q %s", w.WakeTitle, w.WakeJSON)
	}
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Error("the one-shot was kept")
	}
}
