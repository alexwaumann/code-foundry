package project

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// upstreamFixture is a project with three worktrees: main (tracking origin/main),
// side (tracking origin/side, one commit ahead of it) and plain (no upstream), its
// store registered and settled, the fake stream's baseline taken.
type upstreamFixture struct {
	f                 fixture
	h                 *harness
	dr                *dirRunner
	id                string
	main, side, plain string
}

func newUpstreamFixture(t *testing.T) *upstreamFixture {
	t.Helper()
	f := newFixture(t)
	x := &upstreamFixture{f: f, main: f.project, side: filepath.Join(f.base, "side"), plain: filepath.Join(f.base, "plain")}
	git(t, f.project, "worktree", "add", "-q", "-b", "side", x.side, "main")
	git(t, x.side, "push", "-q", "-u", "origin", "side")
	writeFile(t, filepath.Join(x.side, "own.txt"), "own\n")
	git(t, x.side, "add", ".")
	git(t, x.side, "commit", "-q", "-m", "own")
	git(t, f.project, "worktree", "add", "-q", "-b", "plain", x.plain, "main")

	x.dr = &dirRunner{next: ExecRunner{}, n: map[[2]string]int{}}
	x.h = startHarness(t, "", Options{Runner: x.dr})
	r, err := x.h.store.Register(context.Background(), f.project)
	if err != nil {
		t.Fatal(err)
	}
	x.id = r.ID
	x.h.settle()
	x.h.fsChanged()
	x.h.settle()
	if w := x.worktree(t, x.side); w.Status.Upstream != "origin/side" || w.Status.Ahead != 1 {
		t.Fatalf("side starts at %+v", w.Status)
	}
	return x
}

func (x *upstreamFixture) worktree(t *testing.T, path string) Worktree {
	t.Helper()
	w, ok := x.h.store.Snapshot().Worktree(x.id, path)
	if !ok {
		t.Fatalf("no worktree %s", path)
	}
	return w
}

// statuses returns the status runs per worktree since before (nil: since the start).
func (x *upstreamFixture) statuses(before map[string]int) map[string]int {
	out := map[string]int{}
	for _, p := range []string{x.main, x.side, x.plain} {
		out[filepath.Base(p)] = x.dr.count("status", p) - before[filepath.Base(p)]
	}
	return out
}

// A packed-refs or config rewrite refreshes only the worktrees whose upstream it
// changed: a pack-refs (what auto maintenance runs after a fetch or commit since git
// 2.54) none, a pruned packed remote-tracking ref the worktree tracking it, `git
// branch -u` the worktree whose branch it is. Each costs one for-each-ref, beside the
// reconcile.
func TestUpstreamCheckRefreshesOnlyChangedUpstreams(t *testing.T) {
	x := newUpstreamFixture(t)
	t0 := x.statuses(nil)
	forEachRef := func() int {
		n := 0
		for _, p := range []string{x.main} {
			n += x.dr.count("for-each-ref", p)
		}
		return n
	}

	// pack-refs: every loose ref goes into packed-refs, no value changes.
	fer := forEachRef()
	git(t, x.f.project, "pack-refs", "--all", "--prune")
	x.h.fsChanged()
	x.h.settle()
	if got := x.statuses(t0); got["proj"]+got["side"]+got["plain"] != 0 {
		t.Fatalf("pack-refs ran statuses %v, want none", got)
	}
	if n := forEachRef() - fer; n != 1 {
		t.Fatalf("pack-refs ran for-each-ref %d times, want 1", n)
	}

	// origin/side is only in packed-refs now: a prune rewrites packed-refs alone. Side's
	// upstream is gone, so it is no longer ahead of it.
	t1 := x.statuses(nil)
	git(t, x.f.other, "push", "-q", "origin", "--delete", "side")
	git(t, x.f.project, "-c", "maintenance.auto=false", "fetch", "-q", "--prune")
	x.h.fsChanged()
	eventually(t, "side's upstream gone after a prune", 5*time.Second, func() bool {
		w := x.worktree(t, x.side)
		return w.Status.Upstream == "origin/side" && w.Status.Ahead == 0
	})
	x.h.settle()
	if got := x.statuses(t1); got["proj"] != 0 || got["side"] != 1 || got["plain"] != 0 {
		t.Fatalf("a pruned packed remote ref ran statuses %v, want side only", got)
	}

	// `git branch -u`: a config rewrite, plain's upstream only.
	t2 := x.statuses(nil)
	git(t, x.plain, "branch", "-q", "-u", "origin/main")
	x.h.fsChanged()
	eventually(t, "plain's new upstream", 5*time.Second, func() bool {
		return x.worktree(t, x.plain).Status.Upstream == "origin/main"
	})
	x.h.settle()
	if got := x.statuses(t2); got["proj"] != 0 || got["side"] != 0 || got["plain"] != 1 {
		t.Fatalf("branch -u ran statuses %v, want plain only", got)
	}

	// A loose remote-tracking ref pruned: its removal goes through the same check.
	git(t, x.side, "push", "-q", "-u", "origin", "side")
	writeFile(t, filepath.Join(x.side, "own2.txt"), "own\n")
	git(t, x.side, "add", ".")
	git(t, x.side, "commit", "-q", "-m", "own2")
	x.h.fsChanged()
	eventually(t, "side ahead of its pushed upstream", 5*time.Second, func() bool {
		w := x.worktree(t, x.side)
		return w.Status.Upstream == "origin/side" && w.Status.Ahead == 1
	})
	x.h.settle()
	t4 := x.statuses(nil)
	git(t, x.f.other, "push", "-q", "origin", "--delete", "side")
	git(t, x.f.project, "-c", "maintenance.auto=false", "fetch", "-q", "--prune")
	x.h.fsChanged()
	eventually(t, "side's loose upstream gone after a prune", 5*time.Second, func() bool {
		return x.worktree(t, x.side).Status.Ahead == 0
	})
	x.h.settle()
	if got := x.statuses(t4); got["proj"] != 0 || got["side"] != 1 || got["plain"] != 0 {
		t.Fatalf("a pruned loose remote ref ran statuses %v, want side only", got)
	}

	// What the check reads agrees with what git status published, for an upstream on a
	// remote, a gone one and the base ref: a check now finds nothing to refresh.
	t3 := x.statuses(nil)
	x.h.store.upstreamsCheck(context.Background(), x.id)
	x.h.settle()
	if got := x.statuses(t3); got["proj"]+got["side"]+got["plain"] != 0 {
		t.Fatalf("an upstream check with nothing changed ran statuses %v", got)
	}
}

// A worktree whose status job is running when the check reaches it may have read the
// refs before the rewrite: the check waits for that run and compares what it
// published, so a stale status is refreshed and a current one is not run again.
func TestUpstreamCheckBusySlot(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "stale"}[stale], func(t *testing.T) {
			x := newUpstreamFixture(t)
			g := x.h.store
			slot := g.slot(x.id, x.side)
			slot.mu.Lock() // as a running status job does
			before := x.statuses(nil)
			done := make(chan struct{})
			go func() {
				g.upstreamsCheck(context.Background(), x.id)
				close(done)
			}()
			eventually(t, "the check reading the refs", 5*time.Second, func() bool {
				return x.dr.count("for-each-ref", x.main) > 0 && func() bool {
					select {
					case <-done:
						return false
					default:
						return true
					}
				}()
			})
			if stale {
				// The running status read the refs before the rewrite and publishes an
				// upstream git no longer reports.
				w := *slot.cur.Load()
				w.Status.Ahead = 7
				slot.cur.Store(&w)
			}
			slot.mu.Unlock()
			<-done
			x.h.settle()
			want := 0
			if stale {
				want = 1
			}
			if got := x.statuses(before); got["proj"] != 0 || got["side"] != want || got["plain"] != 0 {
				t.Fatalf("statuses %v, want side %d", got, want)
			}
			if w := x.worktree(t, x.side); stale && w.Status.Ahead != 1 {
				t.Fatalf("side after the check: %+v", w.Status)
			}
		})
	}
}

func TestParseUpstreams(t *testing.T) {
	out := []byte("refs/heads/a\x00aaa\x00origin/a\x00ahead 2, behind 3\n" +
		"refs/heads/b\x00bbb\x00origin/b\x00ahead 1\n" +
		"refs/heads/c\x00ccc\x00main\x00behind 4\n" +
		"refs/heads/d\x00ddd\x00origin/d\x00gone\n" +
		"refs/heads/e\x00eee\x00\x00\n")
	got, err := parseUpstreams(out)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]upstreamInfo{
		"refs/heads/a": {true, "aaa", "origin/a", 2, 3},
		"refs/heads/b": {true, "bbb", "origin/b", 1, 0},
		"refs/heads/c": {true, "ccc", "main", 0, 4},
		"refs/heads/d": {true, "ddd", "origin/d", 0, 0},
		"refs/heads/e": {true, "eee", "", 0, 0},
	}
	if len(got) != len(want) {
		t.Fatalf("parseUpstreams = %v", got)
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s: %+v, want %+v", k, got[k], w)
		}
	}
	for _, bad := range []string{"refs/heads/a\x00aaa\x00origin/a\n", "refs/heads/a\x00aaa\x00origin/a\x00ahead x\n", "refs/heads/a\x00aaa\x00origin/a\x00voraus 1\n"} {
		if _, err := parseUpstreams([]byte(bad)); err == nil {
			t.Errorf("parseUpstreams(%q) succeeded", bad)
		}
	}
}

func TestUpstreamMatches(t *testing.T) {
	w := func(head, up string, ahead, behind int) *Worktree {
		return &Worktree{Head: head, Branch: "b", Status: Status{Upstream: up, Ahead: ahead, Behind: behind}}
	}
	tests := []struct {
		name string
		w    *Worktree
		u    upstreamInfo
		want bool
	}{
		{"same", w("h", "origin/b", 1, 2), upstreamInfo{true, "h", "origin/b", 1, 2}, true},
		{"no upstream", w("h", "", 0, 0), upstreamInfo{true, "h", "", 0, 0}, true},
		{"not listed", w("h", "", 0, 0), upstreamInfo{}, false},
		{"branch moved", w("h", "origin/b", 0, 0), upstreamInfo{true, "h2", "origin/b", 0, 0}, false},
		{"upstream set", w("h", "", 0, 0), upstreamInfo{true, "h", "origin/main", 0, 0}, false},
		{"upstream unset", w("h", "origin/b", 0, 0), upstreamInfo{true, "h", "", 0, 0}, false},
		{"counts moved", w("h", "origin/b", 1, 0), upstreamInfo{true, "h", "origin/b", 0, 0}, false},
		// the base ref's counts are the base jobs' (they may not have run yet)
		{"base ref, counts differ", w("h", "origin/main", 0, 0), upstreamInfo{true, "h", "origin/main", 0, 1}, true},
		{"base ref named only", w("h", "origin/b", 0, 0), upstreamInfo{true, "h", "origin/main", 0, 1}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := upstreamMatches(tt.w, tt.u, "origin/main"); got != tt.want {
				t.Fatalf("upstreamMatches = %v, want %v", got, tt.want)
			}
		})
	}
}
