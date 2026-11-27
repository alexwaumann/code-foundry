package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

// pushWorld is a store that is not running, tracking o/r with no GUI connected (the
// 15 min tier), on a fake clock. The test plays the worker (playWorker). during, when
// set, runs inside every Poll request (a push arriving while a poll is in flight).
type pushWorld struct {
	s   *Store
	f   *fakeRunner
	clk *testClock

	mu     sync.Mutex
	polls  []time.Time // fake time of each Poll request
	during func()
}

func newPushWorld(t *testing.T) *pushWorld {
	t.Helper()
	w := &pushWorld{clk: &testClock{}}
	g, _ := changeDrivenWorld()
	w.f = &fakeRunner{}
	w.f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		if op == "Poll" {
			w.mu.Lock()
			w.polls = append(w.polls, w.clk.now())
			during := w.during
			w.during = nil
			w.mu.Unlock()
			if during != nil {
				during()
			}
		}
		return g.respond(op, doc, vars)
	})
	opts := testOptions(openTestDB(t), w.f, nil)
	opts.Now = w.clk.now
	opts.MinGap = time.Millisecond
	opts.UserGap = time.Millisecond
	opts.PollInterval = DefaultPollInterval
	opts.HotPollInterval = -1
	opts.Presence = func() Presence { return PresenceNone }
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	w.s = s
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	// The first poll (Track asked for it), then a quiet stretch well inside the tier.
	w.play(t, time.Second, nil, nil)
	if n := w.f.count("Poll"); n != 1 {
		t.Fatalf("setup polls = %d, want 1", n)
	}
	w.clk.advance(5 * time.Minute)
	return w
}

// play plays the store's worker on the fake clock for horizon: it runs whatever next()
// says is due, advances the clock to the next due work or to the next event, and calls
// fire(i) at offset at[i] from the start (before work due at the same instant).
// Requests take no fake time. It returns the start.
func (w *pushWorld) play(t *testing.T, horizon time.Duration, at []time.Duration, fire func(int)) time.Time {
	t.Helper()
	ctx := context.Background()
	start := w.clk.now()
	i := 0
	for steps := 0; ; steps++ {
		if steps > 10_000 {
			t.Fatal("play: no progress")
		}
		j, wait := w.s.next()
		if j != nil && wait <= 0 {
			w.s.execute(ctx, j)
			continue
		}
		elapsed := w.clk.now().Sub(start)
		if i < len(at) && (j == nil || elapsed+wait >= at[i]) {
			w.clk.advance(max(0, at[i]-elapsed))
			fire(i)
			i++
			continue
		}
		if j == nil || elapsed+wait > horizon {
			return start
		}
		w.clk.advance(wait)
	}
}

// pollsSince is the offsets from start of the Poll requests sent since then, to the
// second (the fake clock also runs with real time, a few ms per test).
func (w *pushWorld) pollsSince(start time.Time) []time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []time.Duration
	for _, p := range w.polls {
		if !p.Before(start) {
			out = append(out, p.Sub(start).Round(time.Second))
		}
	}
	return out
}

func secs(n ...int) []time.Duration {
	out := make([]time.Duration, len(n))
	for i, v := range n {
		out[i] = time.Duration(v) * time.Second
	}
	return out
}

// Pushes (the gitops bridge after Push and CreatePR) while no GUI is looking. Each
// push watches its branch and asks for a poll; the polls are spaced pushPollGap after
// the last one ended, the first one runs at once, and none is lost. Refresh("") (a
// person waiting) stays unspaced. Before BranchPushed the bridge called
// BranchPullRequests and Refresh(""): ten pushes in ten seconds were ten polls.
func TestPushBurstPolls(t *testing.T) {
	ctx := context.Background()
	push := func(w *pushWorld, branch string) {
		if err := w.s.BranchPushed(ctx, "o/r", branch); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		name string
		at   []time.Duration
		ask  func(w *pushWorld, i int)
		want []time.Duration
	}{
		{"one push after a quiet stretch polls at once", secs(0),
			func(w *pushWorld, i int) { push(w, "b0") }, secs(0)},
		{"a second push inside the gap gets a trailing poll", secs(0, 1),
			func(w *pushWorld, i int) { push(w, fmt.Sprintf("b%d", i)) }, secs(0, 3)},
		{"ten pushes on ten branches in ten seconds", secs(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
			func(w *pushWorld, i int) { push(w, fmt.Sprintf("b%d", i)) }, secs(0, 3, 6, 9)},
		{"ten pushes on one branch in ten seconds", secs(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
			func(w *pushWorld, i int) { push(w, "b") }, secs(0, 3, 6, 9)},
		{"a push without a branch is spaced too", secs(0, 1, 2),
			func(w *pushWorld, i int) {
				if err := w.s.BranchPushed(ctx, "", ""); err != nil {
					t.Fatal(err)
				}
			}, secs(0, 3)},
		{"pushes a gap apart each poll at once", secs(0, 3, 6),
			func(w *pushWorld, i int) { push(w, fmt.Sprintf("b%d", i)) }, secs(0, 3, 6)},
		{"a push during a poll brings one more, a gap after it", secs(0),
			func(w *pushWorld, i int) {
				w.mu.Lock()
				w.during = func() { push(w, "b1") }
				w.mu.Unlock()
				push(w, "b0")
			}, secs(0, 3)},
		{"Refresh with no slug is not spaced", secs(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
			func(w *pushWorld, i int) {
				if err := w.s.Refresh(ctx, ""); err != nil {
					t.Fatal(err)
				}
			}, secs(0, 1, 2, 3, 4, 5, 6, 7, 8, 9)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newPushWorld(t)
			start := w.play(t, time.Minute, tt.at, func(i int) { tt.ask(w, i) })
			got := w.pollsSince(start)
			t.Logf("%d asks -> %d polls at %v", len(tt.at), len(got), got)
			if fmt.Sprint(got) != fmt.Sprint(tt.want) {
				t.Fatalf("polls at %v, want %v", got, tt.want)
			}
		})
	}
}

// The schedule a push leaves, against the one Refresh("") leaves: a push is spaced from
// the end of the last poll and never delays a sooner poll or the auth check; Refresh
// is not spaced and checks auth now.
func TestPushPollSchedule(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name          string
		lastPoll      time.Duration // before now; 0 means never
		pollNext      time.Duration // from now
		refresh       bool          // Refresh("") instead of BranchPushed
		wantNext      time.Duration
		wantAuthNow   bool
		wantPollAgain bool
	}{
		{name: "quiet: at once", lastPoll: time.Minute, pollNext: 15 * time.Minute, wantNext: 0},
		{name: "never polled: at once", pollNext: 15 * time.Minute, wantNext: 0},
		{name: "inside the gap: when it ends", lastPoll: time.Second, pollNext: 15 * time.Minute, wantNext: pushPollGap - time.Second},
		{name: "just at the gap: at once", lastPoll: pushPollGap, pollNext: 15 * time.Minute, wantNext: 0},
		{name: "a sooner poll is kept", lastPoll: time.Second, pollNext: pollDebounce, wantNext: pollDebounce},
		{name: "a due poll is kept", lastPoll: time.Second, pollNext: -time.Second, wantNext: -time.Second},
		{name: "refresh inside the gap: at once, auth now", lastPoll: time.Second, pollNext: 15 * time.Minute,
			refresh: true, wantNext: 0, wantAuthNow: true, wantPollAgain: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newPushWorld(t)
			s := w.s
			s.opts.Now = func() time.Time { return now }
			authNext := now.Add(time.Minute)
			s.mu.Lock()
			s.lastPoll = time.Time{}
			if tt.lastPoll > 0 {
				s.lastPoll = now.Add(-tt.lastPoll)
			}
			s.pollNext = now.Add(tt.pollNext)
			s.authNext = authNext
			s.pollAgain, s.pushAgain = false, false
			s.mu.Unlock()
			var err error
			if tt.refresh {
				err = s.Refresh(ctx, "")
			} else {
				// A newly watched branch: alone it would poll within pollDebounce.
				err = s.BranchPushed(ctx, "o/r", "new-branch")
			}
			if err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			if got := s.pollNext.Sub(now); got != tt.wantNext {
				t.Errorf("next poll in %v, want %v", got, tt.wantNext)
			}
			if got := s.authNext.Equal(now); got != tt.wantAuthNow {
				t.Errorf("auth check now = %v, want %v", got, tt.wantAuthNow)
			}
			if s.pollAgain != tt.wantPollAgain {
				t.Errorf("pollAgain = %v, want %v", s.pollAgain, tt.wantPollAgain)
			}
			if s.pushAgain == tt.refresh {
				t.Errorf("pushAgain = %v, want %v", s.pushAgain, !tt.refresh)
			}
			if !tt.refresh && !s.watches[branchKey{"o/r", "new-branch"}].Equal(now) {
				t.Error("pushed branch not watched")
			}
		})
	}
}

// The schedule after a poll ends: pushAgain (a push while it ran) brings the next one
// to pushPollGap after the end unless it is sooner; pollAgain still means at once.
func TestSchedulePollAfterPush(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name                 string
		pollAgain, pushAgain bool
		next                 time.Duration
		want                 time.Duration
	}{
		{"nothing asked", false, false, 15 * time.Minute, 15 * time.Minute},
		{"push: the gap after the end", false, true, 15 * time.Minute, pushPollGap},
		{"push: a sooner schedule is kept", false, true, time.Second, time.Second},
		{"poll asked: at once", true, false, 15 * time.Minute, 0},
		{"poll and push asked: at once", true, true, 15 * time.Minute, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Store{}
			s.pollAgain, s.pushAgain = tt.pollAgain, tt.pushAgain
			s.schedulePollLocked(now, now.Add(tt.next))
			if got := s.pollNext.Sub(now); got != tt.want {
				t.Errorf("next poll in %v, want %v", got, tt.want)
			}
			if s.pollAgain || s.pushAgain {
				t.Error("asks not cleared")
			}
		})
	}
}

// An invalid slug is reported, and the poll is still asked for.
func TestBranchPushedInvalidSlug(t *testing.T) {
	w := newPushWorld(t)
	w.s.mu.Lock()
	w.s.pushAgain = false
	w.s.mu.Unlock()
	err := w.s.BranchPushed(context.Background(), "not a slug", "b")
	if err == nil {
		t.Fatal("err = nil for an invalid slug")
	}
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	if !w.s.pushAgain || w.s.pollNext.After(w.clk.now()) {
		t.Errorf("poll not asked for: pushAgain=%v next in %v", w.s.pushAgain, w.s.pollNext.Sub(w.clk.now()))
	}
}
