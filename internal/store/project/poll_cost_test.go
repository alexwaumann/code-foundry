package project

import (
	"context"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// testClock is a settable Options.Now.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// stepTimer is a tier loop's timer driven by the test: fire hands the loop one tick
// and returns once the loop has finished the round it started (the loop re-arms its
// timer at the end of every round).
type stepTimer struct {
	c      chan time.Time
	resets chan time.Duration
}

func newStepTimer() *stepTimer {
	return &stepTimer{c: make(chan time.Time), resets: make(chan time.Duration, 16)}
}

func (t *stepTimer) C() <-chan time.Time { return t.c }
func (t *stepTimer) Reset(d time.Duration) {
	t.resets <- d
}
func (t *stepTimer) Stop() {}

func (t *stepTimer) fire(tb testing.TB) {
	tb.Helper()
	select {
	case t.c <- time.Time{}:
	case <-time.After(10 * time.Second):
		tb.Fatal("the poll loop did not take its tick")
	}
	select {
	case <-t.resets:
	case <-time.After(30 * time.Second):
		tb.Fatal("the poll loop did not finish its round")
	}
}

// snapshotCounts copies a countingRunner's counts.
func (c *countingRunner) snapshot() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.n)
}

// countsSince is the commands run since before, by subcommand, and their total.
func (c *countingRunner) countsSince(before map[string]int) (map[string]int, int) {
	now := c.snapshot()
	out := map[string]int{}
	total := 0
	for k, v := range now {
		if d := v - before[k]; d > 0 {
			out[k] = d
			total += d
		}
	}
	return out, total
}

func formatCounts(m map[string]int, total int) string {
	var b strings.Builder
	for _, k := range slices.Sorted(maps.Keys(m)) {
		fmt.Fprintf(&b, "%s=%d ", k, m[k])
	}
	fmt.Fprintf(&b, "(total %d)", total)
	return b.String()
}

// TestIdleWorktreeGitCost measures the git commands the store runs for a project with
// one live worktree and 40 idle ones (10 of them with a commit of their own, so they
// diverge from origin/main once it moves): (a) one hour of backstop polls at the
// default intervals, driven by a test clock with no fs event, and (b) one move of
// origin/main fetched outside the store. The numbers are the measurement in
// docs/notes/project-rescan-idle-poll.md and project-lazy-base-counts.md.
func TestIdleWorktreeGitCost(t *testing.T) {
	if testing.Short() {
		t.Skip("creates 40 worktrees")
	}
	f := newFixture(t)
	const idle, diverged = 40, 10
	paths := make([]string, idle)
	for i := range idle {
		paths[i] = filepath.Join(f.base, "wts", fmt.Sprintf("wt-%02d", i))
		git(t, f.project, "worktree", "add", "-q", "-b", fmt.Sprintf("wt-%02d", i), paths[i], "main")
		if i < diverged {
			writeFile(t, filepath.Join(paths[i], fmt.Sprintf("own-%02d.txt", i)), "own\n")
			git(t, paths[i], "add", ".")
			git(t, paths[i], "commit", "-q", "-m", "own")
		}
	}
	live := paths[0] // a worktree with a live thread; it has a commit of its own

	clk := &testClock{t: time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)}
	poll := newStepTimer()
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{
		Runner:           cr,
		Now:              clk.Now,
		PollInterval:     DefaultPollInterval,
		IdlePollInterval: DefaultIdlePollInterval,
		loopTimers: func(name string, d time.Duration) tierTimer {
			if name == "poll" {
				return poll
			}
			return stdTimer{time.NewTimer(d)}
		},
	})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(h.store.Snapshot().Projects[0].Worktrees); n != idle+1 {
		t.Fatalf("project has %d worktrees, want %d", n, idle+1)
	}
	h.settle()
	h.store.SetLiveWorktrees([]string{live})
	nudged(h.store.pollNudge) // the loop is checked by the ticks below

	// (a) One hour of polls, one tick a minute.
	before := cr.snapshot()
	for range 60 {
		clk.advance(time.Minute)
		poll.fire(t)
		h.settle()
	}
	hour, hourTotal := cr.countsSince(before)
	t.Logf("one hour of polls, 1 live + %d idle worktrees: %s", idle, formatCounts(hour, hourTotal))
	// The live worktree every 5 min, the idle ones every 15 min (before: all 41 every
	// 5 min, 492), and the project's reconcile every 5 min.
	if hour["status"] != 12+4*idle || hour["worktree"] != 12 {
		t.Errorf("an hour of polls ran status %d times and %d reconciles, want %d and 12", hour["status"], hour["worktree"], 12+4*idle)
	}

	// (b) origin/main moves; the fetch's events reach the store.
	writeFile(t, filepath.Join(f.other, "moved.txt"), "moved\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "moved")
	git(t, f.other, "push", "-q")
	git(t, f.project, "fetch", "-q")
	before = cr.snapshot()
	h.fsChanged()
	h.settle()
	move, moveTotal := cr.countsSince(before)
	t.Logf("one base move, 1 live + %d idle worktrees: %s", idle, formatCounts(move, moveTotal))
	// Every worktree's status and base counts; a merge check for each diverged one.
	if move["status"] != idle+1 || move["rev-list"] != idle+1 || move["merge-tree"] != diverged {
		t.Errorf("a base move ran status %d, rev-list %d, merge-tree %d times, want %d, %d, %d",
			move["status"], move["rev-list"], move["merge-tree"], idle+1, idle+1, diverged)
	}
	w, _ := h.store.Snapshot().Worktree(r.ID, paths[idle-1])
	if w.Status.BaseBehind != 1 {
		t.Fatalf("an idle worktree after the base move: %+v", w.Status)
	}
}
