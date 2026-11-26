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
// origin/main fetched outside the store, (c) the refs packed, as git's auto
// maintenance does after a fetch or commit since git 2.54, and (d) a fetch that brings
// nothing. The numbers are the measurement in docs/notes/project-rescan-idle-poll.md,
// project-lazy-base-counts.md and project-packed-refs-upstream-check.md.
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

	// (b) origin/main moves; the fetch's events reach the store. Auto maintenance is
	// off for this fetch so the part measures the base move alone on every git: since
	// git 2.54 the fetch's auto maintenance also packs the refs here (41 loose
	// branches), which part (c) measures on its own.
	writeFile(t, filepath.Join(f.other, "moved.txt"), "moved\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "moved")
	git(t, f.other, "push", "-q")
	git(t, f.project, "-c", "maintenance.auto=false", "fetch", "-q")
	before = cr.snapshot()
	h.fsChanged()
	h.settle()
	move, moveTotal := cr.countsSince(before)
	t.Logf("one base move, 1 live + %d idle worktrees: %s", idle, formatCounts(move, moveTotal))
	// The live worktree's status and base counts (before: every worktree's, 41 and
	// 41); one for-each-ref for the 40 others; still a merge check for each diverged
	// worktree but main.
	if move["status"] != 1 || move["rev-list"] != 1 || move["for-each-ref"] != 1 || move["merge-tree"] != diverged || moveTotal != 24 {
		t.Errorf("a base move ran status %d, rev-list %d, for-each-ref %d, merge-tree %d times (total %d), want 1, 1, 1, %d (24)",
			move["status"], move["rev-list"], move["for-each-ref"], move["merge-tree"], moveTotal, diverged)
	}
	for i, p := range paths {
		w, _ := h.store.Snapshot().Worktree(r.ID, p)
		want := baseFields{"origin/main", 0, 1, false}
		if i < diverged {
			want.ahead = 1
		}
		if got := fieldsOf(w); got != want {
			t.Errorf("%s after the base move: %+v, want %+v", filepath.Base(p), got, want)
		}
	}
	w, _ := h.store.Snapshot().Worktree(r.ID, paths[idle-1])
	if w.Status.BaseBehind != 1 {
		t.Fatalf("an idle worktree after the base move: %+v", w.Status)
	}

	// (c) The refs are packed: what auto maintenance runs after a fetch, commit, merge
	// or rebase since git 2.54 once enough loose refs piled up (`pack-refs --all
	// --prune --auto`), and gc. packed-refs is rewritten and every loose ref removed,
	// no value changes: a reconcile, the base re-resolved for the removed loose
	// origin/main, and one upstream check (before: the reconcile and a status of every
	// worktree, 41, with 41 rev-list when it came with a base move).
	before = cr.snapshot()
	git(t, f.project, "pack-refs", "--all", "--prune")
	h.fsChanged()
	h.settle()
	pack, packTotal := cr.countsSince(before)
	t.Logf("pack-refs, 1 live + %d idle worktrees: %s", idle, formatCounts(pack, packTotal))
	if pack["status"] != 0 || pack["for-each-ref"] != 1 || pack["worktree"] != 1 || packTotal != 7 {
		t.Errorf("pack-refs ran status %d, for-each-ref %d, worktree %d times (total %d), want 0, 1, 1 (7)",
			pack["status"], pack["for-each-ref"], pack["worktree"], packTotal)
	}

	// (d) A fetch that brings nothing, auto maintenance on: FETCH_HEAD alone, one base
	// re-resolution. (The refs are packed, so maintenance packs nothing; with enough
	// loose refs on git 2.54+ it would add part (c).)
	before = cr.snapshot()
	git(t, f.project, "fetch", "-q")
	h.fsChanged()
	h.settle()
	noop, noopTotal := cr.countsSince(before)
	t.Logf("a fetch with nothing new, 1 live + %d idle worktrees: %s", idle, formatCounts(noop, noopTotal))
	if noop["rev-parse"] != 1 || noopTotal != 1 {
		t.Errorf("a no-op fetch ran %s, want rev-parse=1 (total 1)", formatCounts(noop, noopTotal))
	}
}
