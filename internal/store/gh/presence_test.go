package gh

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestNextInterval(t *testing.T) {
	const idleEvery = 10 * time.Minute
	minute := Config{PollInterval: time.Minute}
	long := Config{PollInterval: 20 * time.Minute}
	tests := []struct {
		name string
		cfg  Config
		p    Presence
		idle bool
		want time.Duration
	}{
		{"foreground: the configured interval", minute, PresenceForeground, false, time.Minute},
		{"background", minute, PresenceBackground, false, DefaultBackgroundInterval},
		{"no GUI", minute, PresenceNone, false, DefaultNoGUIInterval},
		{"foreground, idle", minute, PresenceForeground, true, idleEvery},
		{"background, idle: the longer idle interval", minute, PresenceBackground, true, idleEvery},
		{"no GUI, idle: the longer tier", minute, PresenceNone, true, DefaultNoGUIInterval},
		{"configured interval is a floor: foreground", long, PresenceForeground, false, 20 * time.Minute},
		{"configured interval is a floor: background", long, PresenceBackground, false, 20 * time.Minute},
		{"configured interval is a floor: no GUI", long, PresenceNone, false, 20 * time.Minute},
		{"configured interval is a floor: idle", long, PresenceForeground, true, 20 * time.Minute},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nextInterval(tt.cfg, tt.p, tt.idle, idleEvery); got != tt.want {
				t.Errorf("nextInterval = %v, want %v", got, tt.want)
			}
		})
	}
}

// PresenceChanged moves the next poll only when presence rises: to right away when the
// last poll is older than the new tier's interval, else to one interval after it.
func TestPresenceChangedSnapBack(t *testing.T) {
	now := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		from, to  Presence
		lastPoll  time.Duration // before now
		pollNext  time.Duration // after now
		tracked   bool
		wantNext  time.Duration // after now
		wantNudge bool
	}{
		{"none to foreground, last poll old: poll soon", PresenceNone, PresenceForeground, 2 * time.Minute, 13 * time.Minute, true, pollDebounce, true},
		{"background to foreground, last poll old: poll soon", PresenceBackground, PresenceForeground, 90 * time.Second, 210 * time.Second, true, pollDebounce, true},
		{"background to foreground, last poll recent: one interval after it", PresenceBackground, PresenceForeground, 20 * time.Second, 280 * time.Second, true, 40 * time.Second, true},
		{"none to background, last poll 2 min ago: 5 min after it", PresenceNone, PresenceBackground, 2 * time.Minute, 13 * time.Minute, true, 3 * time.Minute, true},
		{"none to background, last poll 6 min ago: poll soon", PresenceNone, PresenceBackground, 6 * time.Minute, 9 * time.Minute, true, pollDebounce, true},
		{"rise never delays a sooner poll", PresenceBackground, PresenceForeground, 20 * time.Second, 10 * time.Second, true, 10 * time.Second, true},
		{"rise while idle: the idle interval applies", PresenceNone, PresenceForeground, 2 * time.Minute, 13 * time.Minute, false, 8 * time.Minute, true},
		{"foreground to background: unchanged", PresenceForeground, PresenceBackground, 2 * time.Minute, time.Minute, true, time.Minute, false},
		{"background to none: unchanged", PresenceBackground, PresenceNone, 2 * time.Minute, 3 * time.Minute, true, 3 * time.Minute, false},
		{"no change: unchanged", PresenceForeground, PresenceForeground, 2 * time.Minute, time.Minute, true, time.Minute, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := testOptions(openTestDB(t), &fakeRunner{}, nil)
			opts.PollInterval = time.Minute
			opts.IdleInterval = 10 * time.Minute
			opts.Now = func() time.Time { return now }
			s, err := New(context.Background(), opts)
			if err != nil {
				t.Fatal(err)
			}
			if tt.tracked {
				s.tracked["o/r"] = true
			}
			s.lastPoll = now.Add(-tt.lastPoll)
			s.pollNext = now.Add(tt.pollNext)
			s.PresenceChanged(tt.from, tt.to)
			if got := s.pollNext.Sub(now); got != tt.wantNext {
				t.Errorf("next poll in %v, want %v", got, tt.wantNext)
			}
			if s.pollAgain {
				t.Error("pollAgain set: a running poll would be followed by another")
			}
			nudged := len(s.wake) > 0
			if nudged != tt.wantNudge {
				t.Errorf("nudged = %t, want %t", nudged, tt.wantNudge)
			}
		})
	}
}

// The poll schedules the next one from the presence it reads after each poll; a GUI
// arriving while the worker sleeps on a 15 minute timer wakes it at once.
func TestPollTiersAndWake(t *testing.T) {
	g := newFakeGitHub()
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	f := (&fakeRunner{}).serve(g)
	var presence atomic.Int32 // PresenceNone
	opts := testOptions(openTestDB(t), f, nil)
	opts.PollInterval = 50 * time.Millisecond
	opts.Presence = func() Presence { return Presence(presence.Load()) }
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "first poll", func() bool { return f.count("Poll") >= 1 })
	// The next poll is one interval after the last one ended (lastPoll is taken just
	// after the schedule, so a few ms short of it).
	scheduled := func(want time.Duration) func() bool {
		return func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			gap := s.pollNext.Sub(s.lastPoll)
			return gap <= want && gap > want-time.Second
		}
	}
	waitFor(t, "no-GUI schedule", scheduled(DefaultNoGUIInterval))

	time.Sleep(100 * time.Millisecond) // the last poll is older than the 50ms interval
	polls := f.count("Poll")
	presence.Store(int32(PresenceBackground))
	s.PresenceChanged(PresenceNone, PresenceBackground) // last poll 100ms ago < 5 min: no poll
	time.Sleep(pollDebounce + 200*time.Millisecond)
	if n := f.count("Poll"); n != polls {
		t.Fatalf("polls = %d after none -> background, want %d", n, polls)
	}
	presence.Store(int32(PresenceForeground))
	start := time.Now()
	s.PresenceChanged(PresenceBackground, PresenceForeground)
	waitFor(t, "snap-back poll", func() bool { return f.count("Poll") > polls })
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("snap-back poll after %v", d)
	}
	// Foreground now: the configured interval again (polls keep coming every 50ms).
	waitFor(t, "foreground polls", func() bool { return f.count("Poll") > polls+2 })
	presence.Store(int32(PresenceBackground))
	s.PresenceChanged(PresenceForeground, PresenceBackground)
	waitFor(t, "background schedule", scheduled(DefaultBackgroundInterval))
}

// Every GitHub write brings the next poll forward: the dashboards and lists moved.
func TestWritesPollSoon(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name  string
		write func(s *Store) error
	}{
		{"review", func(s *Store) error {
			_, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove})
			return err
		}},
		{"comment", func(s *Store) error {
			_, err := s.AddPullRequestComment(ctx, "o/r", 1, "thanks")
			return err
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, r, s, _ := reviewWorld(t)
			waitFor(t, "first poll", func() bool { return r.count("Poll") >= 1 })
			polls := r.count("Poll")
			if err := tt.write(s); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "poll after the write", func() bool { return r.count("Poll") > polls })
		})
	}
	t.Run("review request", func(t *testing.T) {
		var polls atomic.Int32
		srv := newAPIServer(t, "tok", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/graphql" {
				polls.Add(1)
				_, _ = w.Write([]byte(`{"data":{"viewer":{"id":"U1","login":"octocat"}}}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"number":1,"requested_reviewers":[{"login":"kim"}],"requested_teams":[],"base":{"repo":{"owner":{"login":"o"}}}}`))
		})
		runner := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
		s := startStore(t, testOptions(openTestDB(t), runner, nil))
		waitFor(t, "first poll", func() bool { return polls.Load() >= 1 })
		before := polls.Load()
		if _, err := s.SetReviewRequest(ctx, "o/r", 1, ReviewRequest{Login: "kim", Requested: true}); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "poll after the write", func() bool { return polls.Load() > before })
	})
}
