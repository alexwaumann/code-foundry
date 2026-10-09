package repo

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

// recordingRunner records a short label per git command (see gitLabel).
type recordingRunner struct {
	next Runner
	mu   sync.Mutex
	cmds []string
}

func (r *recordingRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	r.mu.Lock()
	r.cmds = append(r.cmds, gitLabel(args))
	r.mu.Unlock()
	return r.next.Run(ctx, dir, args...)
}

// take returns and clears the commands recorded so far.
func (r *recordingRunner) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.cmds
	r.cmds = nil
	return c
}

// gitLabel names a git command by its subcommand and the flag that tells same-named
// commands apart: "diff --name-status", "rev-list --count".
func gitLabel(args []string) string {
	switch args[0] {
	case "diff":
		for _, a := range args {
			if a == "--name-status" || a == "--numstat" {
				return "diff " + a
			}
		}
	case "rev-list":
		return "rev-list " + args[1]
	}
	return args[0]
}

const (
	gStatus     = "status"
	gRevParse   = "rev-parse"
	gAheadBhd   = "rev-list --left-right"
	gMergeBase  = "merge-base"
	gNameStatus = "diff --name-status"
	gLog        = "log"
	gLogTotal   = "rev-list --count"
	gLsFiles    = "ls-files"
	gNumstat    = "diff --numstat"
)

// headOnly is what a changed (HEAD, base) key costs a clean worktree's detail.
var headOnly = []string{gMergeBase, gNameStatus, gLog, gLogTotal, gNumstat}

// workingTree is what every recompute of a dirty worktree's detail costs.
var workingTree = []string{gNameStatus, gLsFiles, gNumstat}

// cacheStep is one round of the jobs a poll runs for a watched worktree: jobBase, the
// status job, and the detail job, in order. mutate runs first.
type cacheStep struct {
	name   string
	mutate func(t *testing.T, c *cacheCase)
	// The git commands each job ran, in order.
	wantBase, wantStatus, wantDetail []string
	// Whether WorktreeUpdated / WorktreeDetailUpdated were published.
	wantWorktreeEv, wantDetailEv bool
	check                        func(t *testing.T, wt Worktree, d WorktreeDetail)
}

// cacheCase is a live store with one watched worktree whose jobs the test runs by
// hand (the scheduler is closed, so nothing else runs them).
type cacheCase struct {
	f      fixture
	h      *harness
	rec    *recordingRunner
	repoID string
	wt     string // worktree under test
}

func (c *cacheCase) round(t *testing.T) (base, status, detail []string, wtEv, detailEv bool) {
	t.Helper()
	for len(c.h.sub.C()) > 0 {
		<-c.h.sub.C()
	}
	ctx := context.Background()
	c.rec.take()
	c.h.store.resolveBase(ctx, c.repoID)
	base = c.rec.take()
	c.h.store.status(ctx, c.repoID, c.wt)
	status = c.rec.take()
	c.h.store.detail(ctx, c.repoID, c.wt)
	detail = c.rec.take()
	for len(c.h.sub.C()) > 0 {
		switch ev := (<-c.h.sub.C()).(type) {
		case WorktreeUpdated:
			wtEv = wtEv || ev.Worktree.Path == c.wt
		case WorktreeDetailUpdated:
			detailEv = detailEv || ev.Path == c.wt
		}
	}
	return base, status, detail, wtEv, detailEv
}

func (c *cacheCase) current(t *testing.T) (Worktree, WorktreeDetail) {
	t.Helper()
	wt := *c.h.store.slot(c.repoID, c.wt).cur.Load()
	c.h.store.details.mu.Lock()
	d := c.h.store.details.cache[wtKey{c.repoID, c.wt}]
	c.h.store.details.mu.Unlock()
	return wt, d
}

// featureWorktree: the fixture repo with a feat/x worktree one commit (a.txt) ahead of
// origin/main.
func featureWorktree(t *testing.T, c *cacheCase) {
	ctx := context.Background()
	r, err := c.h.store.Register(ctx, c.f.repo)
	if err != nil {
		t.Fatal(err)
	}
	c.repoID = r.ID
	w, err := c.h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "feat/x"})
	if err != nil {
		t.Fatal(err)
	}
	c.wt = w.Path
	writeFile(t, filepath.Join(c.wt, "a.txt"), "1\n2\n")
	git(t, c.wt, "add", "a.txt")
	git(t, c.wt, "commit", "-q", "-m", "add a")
}

func dirtyFile(name string) func(*testing.T, *cacheCase) {
	return func(t *testing.T, c *cacheCase) { writeFile(t, filepath.Join(c.wt, name), "x\n") }
}

func TestDetailCache(t *testing.T) {
	commitFile := func(name string) func(*testing.T, *cacheCase) {
		return func(t *testing.T, c *cacheCase) {
			writeFile(t, filepath.Join(c.wt, name), "c\n")
			git(t, c.wt, "add", name)
			git(t, c.wt, "commit", "-q", "-m", "add "+name)
		}
	}
	noop := func(*testing.T, *cacheCase) {}
	tests := []struct {
		name  string
		setup func(t *testing.T, c *cacheCase) // registers the repo, sets repoID and wt
		steps []cacheStep
	}{
		{
			name:  "clean, key unchanged",
			setup: featureWorktree,
			steps: []cacheStep{{
				name: "unchanged", mutate: noop,
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus},
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if wt.Status.BaseAhead != 1 || d.LogTotal != 1 ||
						!slices.Equal(d.Files, []FileChange{{Path: "a.txt", Status: "A", Added: 2}}) {
						t.Errorf("status %+v, detail %+v", wt.Status, d)
					}
				},
			}},
		},
		{
			name: "dirty, key unchanged",
			setup: func(t *testing.T, c *cacheCase) {
				featureWorktree(t, c)
				dirtyFile("b.txt")(t, c)
			},
			steps: []cacheStep{{
				name: "same untracked file", mutate: noop,
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus}, wantDetail: workingTree,
			}, {
				name: "another untracked file", mutate: dirtyFile("c.txt"),
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus}, wantDetail: workingTree,
				wantWorktreeEv: true, wantDetailEv: true,
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if wt.Status.Untracked != 2 || len(d.Files) != 3 || d.LogTotal != 1 {
						t.Errorf("status %+v, files %+v", wt.Status, d.Files)
					}
				},
			}},
		},
		{
			name:  "HEAD moved",
			setup: featureWorktree,
			steps: []cacheStep{{
				name: "commit", mutate: commitFile("c.txt"),
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus, gAheadBhd}, wantDetail: headOnly,
				wantWorktreeEv: true, wantDetailEv: true,
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if wt.Status.BaseAhead != 2 || d.Head != wt.Head || d.LogTotal != 2 || len(d.Files) != 2 {
						t.Errorf("status %+v, detail %+v", wt.Status, d)
					}
				},
			}, {
				name: "settled", mutate: noop,
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus},
			}},
		},
		{
			name:  "base moved by fetch",
			setup: featureWorktree,
			steps: []cacheStep{{
				name: "fetch",
				mutate: func(t *testing.T, c *cacheCase) {
					writeFile(t, filepath.Join(c.f.other, "o.txt"), "o\n")
					git(t, c.f.other, "add", ".")
					git(t, c.f.other, "commit", "-q", "-m", "other")
					git(t, c.f.other, "push", "-q")
					git(t, c.f.repo, "fetch", "-q")
				},
				// Everything is recomputed for the new base sha; the merge base, files,
				// and log come out the same, so only the status announces a change.
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus, gAheadBhd}, wantDetail: headOnly,
				wantWorktreeEv: true, wantDetailEv: false,
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if wt.Status.BaseAhead != 1 || wt.Status.BaseBehind != 1 || d.LogTotal != 1 ||
						!slices.Equal(d.Files, []FileChange{{Path: "a.txt", Status: "A", Added: 2}}) {
						t.Errorf("status %+v, detail %+v", wt.Status, d)
					}
				},
			}},
		},
		{
			name: "dirty then clean, key unchanged",
			setup: func(t *testing.T, c *cacheCase) {
				featureWorktree(t, c)
				dirtyFile("b.txt")(t, c)
			},
			steps: []cacheStep{{
				name: "clean again",
				mutate: func(t *testing.T, c *cacheCase) {
					if err := os.Remove(filepath.Join(c.wt, "b.txt")); err != nil {
						t.Fatal(err)
					}
				},
				// The head part is reused; only the clean file list is new.
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus}, wantDetail: []string{gNumstat},
				wantWorktreeEv: true, wantDetailEv: true,
			}, {
				name: "settled", mutate: noop,
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus},
			}},
		},
		{
			name: "unborn branch",
			setup: func(t *testing.T, c *cacheCase) {
				fresh := filepath.Join(c.f.base, "fresh")
				git(t, c.f.base, "init", "-q", "-b", "main", fresh)
				writeFile(t, filepath.Join(fresh, "a.txt"), "1\n")
				git(t, fresh, "add", "a.txt")
				r, err := c.h.store.Register(context.Background(), fresh)
				if err != nil {
					t.Fatal(err)
				}
				c.repoID, c.wt = r.ID, fresh
			},
			steps: []cacheStep{{
				name: "unchanged", mutate: noop,
				// No origin: the base does not resolve, and nothing compares with it.
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus}, wantDetail: workingTree,
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if d.BaseRef != "" || d.Head != "" || wt.Status.BaseRef != "" ||
						!slices.Equal(d.Files, []FileChange{{Path: "a.txt", Status: "A", Added: 1, Uncommitted: true}}) {
						t.Errorf("status %+v, detail %+v", wt.Status, d)
					}
				},
			}},
		},
		{
			name: "no base",
			setup: func(t *testing.T, c *cacheCase) {
				git(t, c.f.repo, "remote", "remove", "origin")
				r, err := c.h.store.Register(context.Background(), c.f.repo)
				if err != nil {
					t.Fatal(err)
				}
				c.repoID, c.wt = r.ID, c.f.repo
			},
			steps: []cacheStep{{
				name: "clean", mutate: noop,
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus},
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if d.BaseRef != "" || d.MergeBase != "" || len(d.Files) != 0 || wt.Status.BaseRef != "" {
						t.Errorf("status %+v, detail %+v", wt.Status, d)
					}
				},
			}, {
				name: "dirty", mutate: dirtyFile("b.txt"),
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus}, wantDetail: workingTree,
				wantWorktreeEv: true, wantDetailEv: true,
			}},
		},
		{
			name: "local default branch as base",
			setup: func(t *testing.T, c *cacheCase) {
				git(t, c.f.repo, "remote", "remove", "origin")
				featureWorktree(t, c)
			},
			steps: []cacheStep{{
				name: "unchanged", mutate: noop,
				// The local base is resolved per detail; the head part is reused.
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus}, wantDetail: []string{gRevParse},
				check: func(t *testing.T, wt Worktree, d WorktreeDetail) {
					if d.BaseRef != "main" || d.LogTotal != 1 || wt.Status.BaseRef != "" {
						t.Errorf("status %+v, detail %+v", wt.Status, d)
					}
				},
			}, {
				name: "main moved",
				mutate: func(t *testing.T, c *cacheCase) {
					writeFile(t, filepath.Join(c.f.repo, "m.txt"), "m\n")
					git(t, c.f.repo, "add", "m.txt")
					git(t, c.f.repo, "commit", "-q", "-m", "main moves")
				},
				wantBase: []string{gRevParse}, wantStatus: []string{gStatus},
				wantDetail:   append([]string{gRevParse}, headOnly...),
				wantDetailEv: false, // same merge base, files, and log
			}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &cacheCase{f: newFixture(t), rec: &recordingRunner{next: ExecRunner{}}}
			c.h = startHarness(t, "", Options{Runner: c.rec})
			tt.setup(t, c)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := c.h.store.Refresh(ctx, c.repoID); err != nil {
				t.Fatal(err)
			}
			if _, err := c.h.store.WorktreeDetail(ctx, c.repoID, c.wt); err != nil {
				t.Fatal(err)
			}
			// From here the test runs the jobs; fs events and polls are dropped.
			c.h.store.sched.close()
			c.round(t) // settle: memoize whatever the setup left uncached
			for _, s := range tt.steps {
				s.mutate(t, c)
				base, status, detail, wtEv, detailEv := c.round(t)
				if !slices.Equal(base, s.wantBase) || !slices.Equal(status, s.wantStatus) || !slices.Equal(detail, s.wantDetail) {
					t.Errorf("%s: git ran\n base   %q (want %q)\n status %q (want %q)\n detail %q (want %q)",
						s.name, base, s.wantBase, status, s.wantStatus, detail, s.wantDetail)
				}
				if wtEv != s.wantWorktreeEv || detailEv != s.wantDetailEv {
					t.Errorf("%s: events WorktreeUpdated=%v WorktreeDetailUpdated=%v, want %v %v",
						s.name, wtEv, detailEv, s.wantWorktreeEv, s.wantDetailEv)
				}
				if s.check != nil {
					wt, d := c.current(t)
					s.check(t, wt, d)
				}
			}
		})
	}
}

// A detail computed while the worktree was dirty and one computed clean agree on the
// committed part, and the clean one equals a from-scratch computation.
func TestDetailCacheMatchesFreshComputation(t *testing.T) {
	c := &cacheCase{f: newFixture(t), rec: &recordingRunner{next: ExecRunner{}}}
	c.h = startHarness(t, "", Options{Runner: c.rec})
	featureWorktree(t, c)
	ctx := context.Background()
	if err := c.h.store.Refresh(ctx, c.repoID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.h.store.WorktreeDetail(ctx, c.repoID, c.wt); err != nil {
		t.Fatal(err)
	}
	c.h.store.sched.close()
	c.round(t)
	_, cached := c.current(t)
	// Drop the head part and recompute everything.
	c.h.store.details.mu.Lock()
	delete(c.h.store.details.heads, wtKey{c.repoID, c.wt})
	c.h.store.details.mu.Unlock()
	_, _, detail, _, detailEv := c.round(t)
	_, fresh := c.current(t)
	if !slices.Equal(detail, headOnly) || detailEv || !sameDetail(cached, fresh) {
		t.Errorf("fresh recompute ran %q (event %v)\ncached %+v\nfresh  %+v", detail, detailEv, cached, fresh)
	}
}

// An unchanged status leaves the snapshot alone (no rebuild); the first one, which
// makes RefreshedAt known, and a changed one replace it.
func TestUnchangedStatusSkipsSnapshotRebuild(t *testing.T) {
	c := &cacheCase{f: newFixture(t), rec: &recordingRunner{next: ExecRunner{}}}
	c.h = startHarness(t, "", Options{Runner: c.rec})
	ctx := context.Background()
	r, err := c.h.store.Register(ctx, c.f.repo)
	if err != nil {
		t.Fatal(err)
	}
	c.repoID, c.wt = r.ID, c.f.repo
	c.h.store.sched.close()
	before := c.h.store.Snapshot()
	if w, _ := before.Worktree(r.ID, c.wt); w.Status.RefreshedAt.IsZero() {
		t.Fatal("first status did not publish RefreshedAt")
	}
	c.h.store.status(ctx, r.ID, c.wt)
	if c.h.store.Snapshot() != before {
		t.Error("an unchanged status rebuilt the snapshot")
	}
	if slot := c.h.store.slot(r.ID, c.wt).cur.Load(); !slot.Status.RefreshedAt.After(time.Time{}) {
		t.Error("slot RefreshedAt not kept current")
	}
	writeFile(t, filepath.Join(c.wt, "new.txt"), "n\n")
	c.h.store.status(ctx, r.ID, c.wt)
	if w, _ := c.h.store.Snapshot().Worktree(r.ID, c.wt); w.Status.Untracked != 1 {
		t.Errorf("changed status not in snapshot: %+v", w.Status)
	}
}

// The first status of a worktree whose status equals the zero Status (clean, no
// upstream, no base) still makes RefreshedAt known in the snapshot.
func TestFirstStatusPublishesRefreshedAt(t *testing.T) {
	isolateGit(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, dir, "init", "-q", "-b", "main", "solo")
	solo := filepath.Join(dir, "solo")
	writeFile(t, filepath.Join(solo, "a"), "a\n")
	git(t, solo, "add", "a")
	git(t, solo, "commit", "-q", "-m", "a")
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), solo)
	if err != nil {
		t.Fatal(err)
	}
	if w := r.Worktrees[0]; w.Status.RefreshedAt.IsZero() || w.Status.Upstream != "" || w.Status.BaseRef != "" {
		t.Errorf("status = %+v", w.Status)
	}
}
