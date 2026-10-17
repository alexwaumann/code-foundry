package project

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTiers(t *testing.T) {
	tests := []struct {
		name       string
		live, idle time.Duration
		want       tier
	}{
		{name: "defaults", want: tier{live: 2 * time.Minute, idle: 15 * time.Minute}},
		{name: "live set", live: 5 * time.Minute, want: tier{live: 5 * time.Minute, idle: 15 * time.Minute}},
		{name: "idle never shorter than live", live: 30 * time.Minute, want: tier{live: 30 * time.Minute, idle: 30 * time.Minute}},
		{name: "both set", live: time.Second, idle: time.Hour, want: tier{live: time.Second, idle: time.Hour}},
		{name: "negative idle is live", live: time.Second, idle: -1, want: tier{live: time.Second, idle: time.Second}},
		{name: "disabled", live: -1, want: tier{live: -1, idle: 15 * time.Minute}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tiers(tt.live, tt.idle, DefaultFetchInterval, DefaultIdleFetchInterval); got != tt.want {
				t.Fatalf("tiers = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// TestTierSchedDue covers tier selection: which projects a round runs, including a
// project that just turned live (the immediate fetch).
func TestTierSchedDue(t *testing.T) {
	t0 := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	fetch := tier{live: 2 * time.Minute, idle: 15 * time.Minute}
	tests := []struct {
		name string
		seed time.Time
		last time.Duration // ago; 0 = never run
		live bool
		want bool
	}{
		{name: "never fetched", want: true},
		{name: "never fetched, live", live: true, want: true},
		{name: "never polled, seeded at start", seed: t0.Add(-time.Minute), want: false},
		{name: "seeded long ago", seed: t0.Add(-20 * time.Minute), want: true},
		{name: "live, fetched a minute ago", last: time.Minute, live: true, want: false},
		{name: "live, fetched two minutes ago", last: 2 * time.Minute, live: true, want: true},
		{name: "idle, fetched five minutes ago", last: 5 * time.Minute, want: false},
		{name: "turned live, fetched five minutes ago: fetch now", last: 5 * time.Minute, live: true, want: true},
		{name: "turned live, fetched 90s ago: wait", last: 90 * time.Second, live: true, want: false},
		{name: "idle, fetched 15 minutes ago", last: 15 * time.Minute, want: true},
		{name: "idle, fetched 14 minutes ago", last: 14 * time.Minute, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTierSched(fetch, tt.seed)
			if tt.last > 0 {
				s.ran("p", t0.Add(-tt.last))
			}
			if got := s.due("p", tt.live, t0); got != tt.want {
				t.Fatalf("due = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTierSchedWait(t *testing.T) {
	t0 := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	poll := tier{live: 30 * time.Second, idle: 10 * time.Minute}
	tests := []struct {
		name string
		last map[string]time.Duration // ago
		live map[string]bool
		want time.Duration
	}{
		{name: "no projects: the live interval", want: 30 * time.Second},
		{name: "idle only: capped at the live interval", last: map[string]time.Duration{"a": time.Second}, want: 30 * time.Second},
		{name: "live due soon", last: map[string]time.Duration{"a": 20 * time.Second, "b": time.Second},
			live: map[string]bool{"a": true}, want: 10 * time.Second},
		{name: "overdue is now", last: map[string]time.Duration{"a": time.Hour}, want: 0},
		{name: "never run is now", last: map[string]time.Duration{"a": time.Second, "b": 0}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTierSched(poll, time.Time{})
			var ids []string
			for id, ago := range tt.last {
				ids = append(ids, id)
				if ago > 0 {
					s.ran(id, t0.Add(-ago))
				}
			}
			if got := s.wait(ids, func(id string) bool { return tt.live[id] }, t0); got != tt.want {
				t.Fatalf("wait = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTierSchedForget(t *testing.T) {
	s := newTierSched(tier{live: time.Second, idle: time.Minute}, time.Time{})
	now := time.Now()
	s.ran("a", now)
	s.ran("b", now)
	s.forget([]string{"a"})
	if _, ok := s.last["b"]; ok || s.last["a"] != now {
		t.Fatalf("last = %v", s.last)
	}
}

// eventually polls cond until it holds, failing after timeout.
func eventually(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func nudged(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestProjectLive(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.base, "link")
	if err := os.Symlink(f.project, link); err != nil {
		t.Fatal(err)
	}
	g := h.store
	now := time.Now()
	if g.projectLive(r.ID, now) {
		t.Fatal("a fresh project is live")
	}
	nudged(g.pollNudge)
	nudged(g.fetchNudge)

	// A live thread's worktree, named through a symlink, makes the project live and
	// wakes both loops.
	g.SetLiveWorktrees([]string{link, filepath.Join(f.base, "elsewhere")})
	if !g.projectLive(r.ID, now) {
		t.Fatal("project with a live worktree is idle")
	}
	if !nudged(g.pollNudge) || !nudged(g.fetchNudge) {
		t.Fatal("turning live did not nudge the loops")
	}
	// The same set, or a smaller one, gains nothing: no nudge.
	g.SetLiveWorktrees([]string{f.project, filepath.Join(f.base, "elsewhere")})
	g.SetLiveWorktrees([]string{f.project})
	if nudged(g.pollNudge) || nudged(g.fetchNudge) {
		t.Fatal("nudged without a newly live worktree")
	}
	g.SetLiveWorktrees(nil)
	if g.projectLive(r.ID, now) {
		t.Fatal("project live after its threads went away")
	}

	// A detail request makes it live for DetailWatch, and nudges.
	if _, err := g.WorktreeDetail(ctx, r.ID, f.project); err != nil {
		t.Fatal(err)
	}
	if !nudged(g.fetchNudge) {
		t.Fatal("a detail request did not nudge")
	}
	if !g.projectLive(r.ID, time.Now()) {
		t.Fatal("project idle right after a detail request")
	}
	if g.projectLive(r.ID, time.Now().Add(DetailWatch+time.Second)) {
		t.Fatal("project live after the detail watch lapsed")
	}
	if _, err := g.WorktreeDetail(ctx, r.ID, f.project); err != nil {
		t.Fatal(err)
	}
	if nudged(g.fetchNudge) {
		t.Fatal("a renewed detail watch nudged")
	}
}

// TestPollTiers: an idle project is not polled at the live interval; a live thread or
// a detail request makes it so.
func TestPollTiers(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, PollInterval: 100 * time.Millisecond, IdlePollInterval: time.Hour})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	before := cr.count("status")
	time.Sleep(600 * time.Millisecond)
	if n := cr.count("status"); n != before {
		t.Fatalf("idle project polled: status ran %d more times", n-before)
	}

	h.store.SetLiveWorktrees([]string{f.project})
	eventually(t, "live polls", 3*time.Second, func() bool { return cr.count("status") >= before+3 })

	h.store.SetLiveWorktrees(nil)
	time.Sleep(300 * time.Millisecond)
	before = cr.count("status")
	time.Sleep(500 * time.Millisecond)
	if n := cr.count("status"); n != before {
		t.Fatalf("project polled after going idle: status ran %d more times", n-before)
	}
	if _, err := h.store.WorktreeDetail(ctx, r.ID, f.project); err != nil {
		t.Fatal(err)
	}
	eventually(t, "polls while the detail is watched", 3*time.Second, func() bool { return cr.count("status") >= before+3 })
}

// TestFetchTiers: an idle project is not fetched at the live interval; one that turns
// live with an old fetch is fetched again.
func TestFetchTiers(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, FetchInterval: 300 * time.Millisecond, IdleFetchInterval: time.Hour})
	if _, err := h.store.Register(context.Background(), f.project); err != nil {
		t.Fatal(err)
	}
	// Live from the start, so the first fetch does not depend on whether the first
	// round ran before Register learned the origin.
	h.store.SetLiveWorktrees([]string{f.project})
	eventually(t, "first fetch", 5*time.Second, func() bool { return cr.count("fetch") >= 1 })

	h.store.SetLiveWorktrees(nil)
	time.Sleep(400 * time.Millisecond) // a fetch in flight finishes
	idle := cr.count("fetch")
	time.Sleep(time.Second)
	if n := cr.count("fetch"); n != idle {
		t.Fatalf("idle project fetched %d more times", n-idle)
	}

	// The last fetch is over a second old, past the live interval: fetched now.
	h.store.SetLiveWorktrees([]string{f.project})
	eventually(t, "fetch on turning live", 3*time.Second, func() bool { return cr.count("fetch") > idle })
}

// TestTouch: Touch debounces per worktree (a burst is one status run), TouchNow runs
// at once; both see an edit below the top level. The FSEvents stream sees that edit
// too, so its tree window is set out of reach: only Touch and TouchNow refresh here.
func TestTouch(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	const window = 300 * time.Millisecond
	h := startHarness(t, "", Options{Runner: cr, TouchDebounce: window, TreeDebounce: time.Hour})
	if _, err := h.store.Register(context.Background(), f.project); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.base, "link")
	if err := os.Symlink(f.project, link); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	before := cr.count("status")

	writeFile(t, filepath.Join(f.project, "sub", "x.txt"), "edited\n")
	start := time.Now()
	for i := range 10 {
		p := f.project
		if i%2 == 1 {
			p = link
		}
		h.store.Touch(p)
	}
	h.store.Touch(filepath.Join(f.base, "not-a-worktree")) // ignored
	h.waitFor("nested edit via Touch", worktreeUpdated(f.project, func(w Worktree) bool { return w.Status.Modified == 1 }))
	if el := time.Since(start); el < window-50*time.Millisecond {
		t.Fatalf("Touch refreshed after %v, before its %v window", el, window)
	}
	time.Sleep(2 * window)
	if n := cr.count("status") - before; n != 1 {
		t.Fatalf("a burst of touches ran status %d times, want 1", n)
	}

	writeFile(t, filepath.Join(f.project, "sub", "x.txt"), "x\n")
	h.store.TouchNow(link)
	h.waitFor("nested revert via TouchNow", worktreeUpdated(f.project, func(w Worktree) bool { return w.Status.Modified == 0 }))
	if n := cr.count("status") - before; n != 2 {
		t.Fatalf("status ran %d times, want 2", n)
	}
}
