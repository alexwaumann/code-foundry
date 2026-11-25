package project

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestProjectSleepJump(t *testing.T) {
	tests := []struct {
		name         string
		wallDelta    time.Duration
		monoDelta    time.Duration
		tickInterval time.Duration
		fromTick     bool
		wantJump     bool
		wantDur      time.Duration
	}{
		{
			name: "normal awake tick", wallDelta: 5 * time.Second, monoDelta: 5 * time.Second,
			tickInterval: 5 * time.Second, fromTick: true, wantJump: false,
		},
		{
			name: "NTP backward step", wallDelta: -20 * time.Second, monoDelta: 5 * time.Second,
			tickInterval: 5 * time.Second, fromTick: true, wantJump: false,
		},
		{
			name: "macOS mono paused skew", wallDelta: 10*time.Minute + 2*time.Second, monoDelta: 2 * time.Second,
			tickInterval: 5 * time.Second, fromTick: true, wantJump: true, wantDur: 10 * time.Minute,
		},
		{
			name: "tick wall overrun", wallDelta: 30 * time.Second, monoDelta: 30 * time.Second,
			tickInterval: 5 * time.Second, fromTick: true, wantJump: true, wantDur: 25 * time.Second,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotDur, gotJump := sleepJump(tt.wallDelta, tt.monoDelta, tt.tickInterval, tt.fromTick)
			if gotJump != tt.wantJump || gotDur != tt.wantDur {
				t.Errorf("sleepJump = (%v, %v), want (%v, %v)", gotDur, gotJump, tt.wantDur, tt.wantJump)
			}
		})
	}
}

func TestWakeRefreshesLiveProject(t *testing.T) {
	liveFix := newFixture(t)
	idleFix := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}

	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	var sampleMu sync.Mutex
	cur := wakeSample{wall: t0, mono: t0}
	ticks := make(chan time.Time, 1)

	h := startHarness(t, "", Options{
		Runner:            cr,
		FetchInterval:     5 * time.Minute,
		IdleFetchInterval: 15 * time.Minute,
		PollInterval:      5 * time.Minute,
		IdlePollInterval:  15 * time.Minute,
		wake: &wakeConfig{
			tickInterval: 5 * time.Second,
			ticks:        ticks,
			sample: func() wakeSample {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				return cur
			},
		},
	})
	ctx := context.Background()
	liveProj, err := h.store.Register(ctx, liveFix.project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Register(ctx, idleFix.project); err != nil {
		t.Fatal(err)
	}
	h.store.SetLiveWorktrees([]string{liveFix.project})

	// Push a new commit to liveFix's origin from its second clone while "asleep".
	writeFile(t, filepath.Join(liveFix.other, "remote.txt"), "landed during sleep\n")
	git(t, liveFix.other, "add", "remote.txt")
	git(t, liveFix.other, "commit", "-q", "-m", "during sleep")
	git(t, liveFix.other, "push", "-q", "origin", "main")

	fetchesBefore := cr.count("fetch")
	revParseBefore := cr.count("rev-parse")
	worktreeBefore := cr.count("worktree")

	// Simulate a 5-minute macOS sleep jump and deliver one wake monitor tick.
	sampleMu.Lock()
	cur = wakeSample{wall: t0.Add(5*time.Minute + 2*time.Second), mono: t0.Add(2 * time.Second)}
	sampleMu.Unlock()
	ticks <- cur.wall

	// Live project must immediately fetch + reconcile + resolve base and observe BaseBehind == 1.
	eventually(t, "wake fetch and base update for live project", 5*time.Second, func() bool {
		wt, ok := h.store.Snapshot().Worktree(liveProj.ID, liveFix.project)
		return ok && wt.Status.BaseBehind == 1 && cr.count("fetch") > fetchesBefore && cr.count("worktree") > worktreeBefore
	})

	// Idle project must NOT have been force-fetched by wake (only the 1 live project fetched).
	time.Sleep(100 * time.Millisecond)
	fetchDelta := cr.count("fetch") - fetchesBefore
	revParseDelta := cr.count("rev-parse") - revParseBefore
	worktreeDelta := cr.count("worktree") - worktreeBefore
	t.Logf("AFTER [project_wake]: fetch_delta=%d rev_parse_delta=%d worktree_delta=%d",
		fetchDelta, revParseDelta, worktreeDelta)
	if fetchDelta != 1 {
		t.Errorf("fetch_delta = %d, want 1 (live project only, not idle project)", fetchDelta)
	}
	if worktreeDelta < 1 {
		t.Errorf("worktree_delta = %d, want >= 1 (reconcile on wake)", worktreeDelta)
	}
	if revParseDelta < 1 {
		t.Errorf("rev_parse_delta = %d, want >= 1 (base refresh on wake)", revParseDelta)
	}
}
