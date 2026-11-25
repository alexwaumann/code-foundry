package project

import (
	"context"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
)

func TestLRUCacheBoundsAndEviction(t *testing.T) {
	c := newLRUCache[string, string](3, 10)
	c.put("a", "1", 4)
	c.put("b", "2", 4)
	if v, ok := c.get("a"); !ok || v != "1" { // touch "a" so "b" is LRU
		t.Fatalf("get(a) = %q, %v", v, ok)
	}
	// Adding "c" (weight 4) pushes total to 12 > 10, evicting LRU "b".
	c.put("c", "3", 4)
	if _, ok := c.get("b"); ok {
		t.Fatalf("b should have been evicted by byte limit")
	}
	if _, ok := c.get("a"); !ok {
		t.Fatalf("a should remain")
	}
	// Entry count limit (3): add "d" (weight 1) -> 3 entries (a, c, d, total 9);
	// add "e" (weight 1) -> evicts LRU "c".
	c.put("d", "4", 1)
	c.put("e", "5", 1)
	if _, ok := c.get("c"); ok {
		t.Fatalf("c should have been evicted by entry limit")
	}
	// Oversized item is skipped without corrupting existing entries.
	c.put("huge", "x", 99)
	if _, ok := c.get("huge"); ok {
		t.Fatalf("oversized entry should not be cached")
	}
	c.deleteFunc(func(k string) bool { return k == "d" })
	if _, ok := c.get("d"); ok {
		t.Fatalf("d should have been deleted")
	}
}

func TestCatFilePoolRestartIdleReapAndClose(t *testing.T) {
	f := newCompareFixture(t)
	ctx := ctx20(t)
	pool := f.h.store.catFiles
	if pool == nil {
		t.Fatal("expected catFilePool to be enabled for default ExecRunner")
	}
	headSHA := git(t, f.path, "rev-parse", "HEAD")

	// First read spawns a worker and returns it to idle pool.
	v, fallback, err := pool.readRevSide(ctx, f.fixture.project, filepath.Join(f.fixture.project, ".git"), headSHA, "keep.txt")
	if err != nil || fallback || !v.Present || string(v.Contents) != "one\nTWO\nthree\n" {
		t.Fatalf("readRevSide = %+v fallback=%v err=%v", v, fallback, err)
	}
	if got := pool.idleCount(); got != 1 {
		t.Fatalf("idleCount = %d, want 1", got)
	}

	// Kill the pooled worker externally to simulate broken pipe / crash; next call
	// must transparently restart a fresh worker and succeed.
	pool.mu.Lock()
	killedPID := pool.repos[f.fixture.project].idle[0].pid
	pool.mu.Unlock()
	if err := syscall.Kill(-killedPID, syscall.SIGKILL); err != nil {
		t.Fatalf("kill worker %d: %v", killedPID, err)
	}
	// Give the kernel a moment to deliver SIGKILL before the write hits broken pipe.
	time.Sleep(20 * time.Millisecond)

	v2, fallback, err := pool.readRevSide(ctx, f.fixture.project, filepath.Join(f.fixture.project, ".git"), headSHA, "keep.txt")
	if err != nil || fallback || !v2.Present || string(v2.Contents) != "one\nTWO\nthree\n" {
		t.Fatalf("readRevSide after kill = %+v fallback=%v err=%v", v2, fallback, err)
	}
	pool.mu.Lock()
	restartedPID := pool.repos[f.fixture.project].idle[0].pid
	pool.mu.Unlock()
	if restartedPID == killedPID {
		t.Fatalf("expected new worker pid after kill, still got %d", restartedPID)
	}

	// Verify idle reaping closes and reaps the worker with no zombie left behind.
	pool.mu.Lock()
	pool.idleTimeout = 40 * time.Millisecond
	pool.repos[f.fixture.project].idle[0].idleSince = time.Now().Add(-time.Second)
	pool.scheduleReaperLocked()
	pool.mu.Unlock()

	eventually(t, "idle worker reaped", 3*time.Second, func() bool {
		return pool.idleCount() == 0
	})
	eventually(t, "reaped worker pid gone (no zombie)", 3*time.Second, func() bool {
		return syscall.Kill(restartedPID, 0) == syscall.ESRCH
	})

	// Unregister closes idle workers for that project cleanly.
	if _, _, err := pool.readRevSide(ctx, f.fixture.project, filepath.Join(f.fixture.project, ".git"), headSHA, "keep.txt"); err != nil {
		t.Fatal(err)
	}
	pool.mu.Lock()
	unregPID := pool.repos[f.fixture.project].idle[0].pid
	pool.mu.Unlock()
	if err := f.h.store.Unregister(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	if got := pool.idleCount(); got != 0 {
		t.Fatalf("idleCount after Unregister = %d, want 0", got)
	}
	eventually(t, "unregistered worker pid gone", 3*time.Second, func() bool {
		return syscall.Kill(unregPID, 0) == syscall.ESRCH
	})
}

func TestCompareCachesImmutableAndDefensiveCopies(t *testing.T) {
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	f := newCompareFixtureWith(t, Options{Runner: cr})
	ctx := ctx20(t)
	baseSHA := git(t, f.path, "rev-parse", "origin/main")
	headSHA := git(t, f.path, "rev-parse", "HEAD")

	// CompareWorktree commit-to-commit: second call hits LRU cache (0 git calls) and
	// mutating the returned slice does not corrupt cached entries.
	w1 := f.compare(t, sourceRef(baseSHA), sourceRef(headSHA))
	if len(w1.Files) == 0 {
		t.Fatal("expected diff files")
	}
	origPath := w1.Files[0].Path
	w1.Files[0].Path = "MUTATED"

	before := cr.total()
	w2 := f.compare(t, sourceRef(baseSHA), sourceRef(headSHA))
	if cr.total() != before {
		t.Fatalf("cached CompareWorktree ran %d git commands, want 0", cr.total()-before)
	}
	if w2.Files[0].Path != origPath {
		t.Fatalf("cached CompareWorktree mutated: got %q, want %q", w2.Files[0].Path, origPath)
	}

	// CompareFile commit-to-commit: second call hits LRU cache (0 git calls) and
	// mutating Contents does not corrupt cached bytes.
	s1 := f.sides(t, sourceRef(baseSHA), sourceRef(headSHA), "keep.txt", "")
	if len(s1.Old.Contents) == 0 || len(s1.New.Contents) == 0 {
		t.Fatal("expected keep.txt contents")
	}
	origOld, origNew := string(s1.Old.Contents), string(s1.New.Contents)
	s1.Old.Contents[0] = 'X'
	s1.New.Contents[0] = 'Y'

	before = cr.total()
	s2 := f.sides(t, sourceRef(baseSHA), sourceRef(headSHA), "keep.txt", "")
	if cr.total() != before {
		t.Fatalf("cached CompareFile ran %d git commands, want 0", cr.total()-before)
	}
	if string(s2.Old.Contents) != origOld || string(s2.New.Contents) != origNew {
		t.Fatalf("cached CompareFile mutated: old=%q new=%q", s2.Old.Contents, s2.New.Contents)
	}

	// CompareCommits commit-to-commit: second call hits LRU cache (0 git calls) and
	// mutating Commits does not corrupt cache.
	c1, err := f.h.store.CompareCommits(ctx, CompareCommitsRequest{
		ProjectID: f.id, Path: f.path, Base: sourceRef(baseSHA), Head: sourceRef(headSHA),
	})
	if err != nil || len(c1.Commits) == 0 {
		t.Fatalf("CompareCommits = %+v, %v", c1, err)
	}
	origSubj := c1.Commits[0].Subject
	c1.Commits[0].Subject = "MUTATED"

	before = cr.total()
	c2, err := f.h.store.CompareCommits(ctx, CompareCommitsRequest{
		ProjectID: f.id, Path: f.path, Base: sourceRef(baseSHA), Head: sourceRef(headSHA),
	})
	if err != nil {
		t.Fatal(err)
	}
	if cr.total() != before {
		t.Fatalf("cached CompareCommits ran %d git commands, want 0", cr.total()-before)
	}
	if c2.Commits[0].Subject != origSubj {
		t.Fatalf("cached CompareCommits mutated: got %q, want %q", c2.Commits[0].Subject, origSubj)
	}

	// CompareCommitBody: second call hits LRU cache (0 git calls).
	git(t, f.path, "commit", "-q", "--allow-empty", "-m", "subj\n\nbody text")
	bodySHA := git(t, f.path, "rev-parse", "HEAD")
	m1, err := f.h.store.CompareCommitBody(ctx, CompareCommitRequest{ProjectID: f.id, Path: f.path, SHA: bodySHA})
	if err != nil || m1.Body != "body text" {
		t.Fatalf("CompareCommitBody = %+v, %v", m1, err)
	}
	before = cr.total()
	m2, err := f.h.store.CompareCommitBody(ctx, CompareCommitRequest{ProjectID: f.id, Path: f.path, SHA: bodySHA})
	if err != nil || m2.Body != "body text" {
		t.Fatalf("cached CompareCommitBody = %+v, %v", m2, err)
	}
	if cr.total() != before {
		t.Fatalf("cached CompareCommitBody ran %d git commands, want 0", cr.total()-before)
	}
}

func TestCompareWorktreeSkipsRedundantLsFilesAndReusesLineMemo(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := ctx20(t)
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/clean"})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(wt.Path, "a.txt"), "1\n2\n")
	git(t, wt.Path, "add", "a.txt")
	git(t, wt.Path, "commit", "-q", "-m", "add a")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}

	// Clean worktree with fresh status: skips both ls-files --unmerged and ls-files --others.
	beforeLS := cr.count("ls-files")
	cmpRes, err := h.store.CompareWorktree(ctx, CompareRequest{
		ProjectID: r.ID, Path: wt.Path,
		Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := rows(cmpRes.Files); !slices.Equal(got, []string{"A a.txt +2 -0"}) {
		t.Fatalf("files = %v", got)
	}
	if got := cr.count("ls-files") - beforeLS; got != 0 {
		t.Fatalf("clean worktree ran ls-files %d times, want 0", got)
	}

	// Add an untracked file and refresh: Conflicted == 0 skips --unmerged, runs only
	// --others (1 ls-files), and populates details.lines memo.
	uPath := filepath.Join(wt.Path, "u.txt")
	writeFile(t, uPath, "line1\nline2\nline3\n")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	beforeLS = cr.count("ls-files")
	cmpRes, err = h.store.CompareWorktree(ctx, CompareRequest{
		ProjectID: r.ID, Path: wt.Path,
		Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := cr.count("ls-files") - beforeLS; got != 1 {
		t.Fatalf("dirty untracked worktree ran ls-files %d times, want 1", got)
	}
	if lm := h.store.getLineMemo(wtKey{r.ID, wt.Path}); lm["u.txt"].lines != 3 {
		t.Fatalf("lineMemo for u.txt = %+v, want 3 lines", lm["u.txt"])
	}
	// Editing u.txt updates size/mtime and recounts accurately.
	writeFile(t, uPath, "line1\nline2\nline3\nline4\nline5\n")
	cmpRes, err = h.store.CompareWorktree(ctx, CompareRequest{
		ProjectID: r.ID, Path: wt.Path,
		Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(rows(cmpRes.Files), "? u.txt +5 -0") {
		t.Fatalf("edited untracked file not recounted: %v", rows(cmpRes.Files))
	}
}

func TestListRefsCacheAndInvalidation(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := ctx20(t)
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}

	// First call populates cache.
	before := cr.count("for-each-ref")
	r1, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := cr.count("for-each-ref") - before; got != 1 {
		t.Fatalf("first ListRefs ran for-each-ref %d times, want 1", got)
	}
	// Mutating returned slice does not corrupt cache.
	origLocal := slices.Clone(r1.Local)
	if len(r1.Local) > 0 {
		r1.Local[0] = "MUTATED"
	}

	// Repeat call hits cache (0 git calls).
	before = cr.count("for-each-ref")
	r2, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := cr.count("for-each-ref") - before; got != 0 {
		t.Fatalf("cached ListRefs ran for-each-ref %d times, want 0", got)
	}
	if !slices.Equal(r2.Local, origLocal) {
		t.Fatalf("cached ListRefs mutated: %v, want %v", r2.Local, origLocal)
	}

	// FSEvents event under refs/heads/ invalidates cache.
	git(t, f.project, "branch", "fs-branch")
	h.store.onEvents([]fsevents.Event{{
		Path:  filepath.Join(f.project, ".git", "refs", "heads", "fs-branch"),
		Flags: fsevents.ItemCreated | fsevents.ItemIsFile,
	}})
	r3, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r3.Local, "fs-branch") {
		t.Fatalf("ListRefs after refs/heads FSEvent missing fs-branch: %v", r3.Local)
	}

	// CreateWorktree invalidates cache.
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "wt-branch"})
	if err != nil {
		t.Fatal(err)
	}
	r4, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r4.Local, "wt-branch") {
		t.Fatalf("ListRefs after CreateWorktree missing wt-branch: %v", r4.Local)
	}

	// RemoveWorktree + DeleteBranch invalidates cache.
	if err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: wt.Path, DeleteBranch: true}); err != nil {
		t.Fatal(err)
	}
	r5, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(r5.Local, "wt-branch") {
		t.Fatalf("ListRefs after RemoveWorktree still has wt-branch: %v", r5.Local)
	}

	// DeleteBranch invalidates cache.
	if _, err := h.store.DeleteBranch(ctx, DeleteBranchOptions{ProjectID: r.ID, Branch: "fs-branch"}); err != nil {
		t.Fatal(err)
	}
	r6, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(r6.Local, "fs-branch") {
		t.Fatalf("ListRefs after DeleteBranch still has fs-branch: %v", r6.Local)
	}

	// packed-refs and FETCH_HEAD FSEvents invalidate cache.
	for _, name := range []string{"packed-refs", "FETCH_HEAD"} {
		before = cr.count("for-each-ref")
		h.store.onEvents([]fsevents.Event{{
			Path:  filepath.Join(f.project, ".git", name),
			Flags: fsevents.ItemModified | fsevents.ItemIsFile,
		}})
		if _, err := h.store.ListRefs(ctx, r.ID); err != nil {
			t.Fatal(err)
		}
		if got := cr.count("for-each-ref") - before; got != 1 {
			t.Fatalf("ListRefs after %s FSEvent ran for-each-ref %d times, want 1", name, got)
		}
	}
}

type recordingClock struct {
	mu      sync.Mutex
	windows []time.Duration
}

func (c *recordingClock) after(d time.Duration, _ func()) stopper {
	c.mu.Lock()
	c.windows = append(c.windows, d)
	c.mu.Unlock()
	return noopStopper{}
}

func (c *recordingClock) take() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	w := c.windows
	c.windows = nil
	return w
}

type noopStopper struct{}

func (noopStopper) Stop() bool { return true }

func TestActiveWorktreeTreeDebounceWindow(t *testing.T) {
	f := newFixture(t)
	// Start directly with zero TreeDebounce/ActiveTreeDebounce (production defaults).
	d, err := db.Open(context.Background(), dbtest.Path(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	fake := newFakeStream()
	store, err := Start(context.Background(), Options{
		DB:            d,
		Bus:           bus.New(),
		WorktreeRoot:  filepath.Join(f.base, "wt"),
		AllowedRoot:   f.base,
		FetchInterval: -1,
		PollInterval:  -1,
		streams:       fake.source,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := ctx20(t)
	r, err := store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/active"})
	if err != nil {
		t.Fatal(err)
	}

	clk := &recordingClock{}
	store.treeDeb.setClock(clk.after)

	// Inactive worktree gets DefaultTreeDebounce (1s).
	store.onEvents([]fsevents.Event{{
		Path:  filepath.Join(wt.Path, "README.md"),
		Flags: fsevents.ItemModified | fsevents.ItemIsFile,
	}})
	if got := clk.take(); !slices.Equal(got, []time.Duration{DefaultTreeDebounce}) {
		t.Fatalf("inactive worktree tree debounce = %v, want [%v]", got, DefaultTreeDebounce)
	}
	store.treeDeb.cancel(jobKey{kind: jobStatus, projectID: r.ID, path: wt.Path})

	// Active worktree via SetLiveWorktrees gets DefaultActiveTreeDebounce (300ms) for
	// both jobStatus and jobFiles.
	store.SetLiveWorktrees([]string{wt.Path})
	store.onEvents([]fsevents.Event{{
		Path:  filepath.Join(wt.Path, "README.md"),
		Flags: fsevents.ItemModified | fsevents.ItemIsFile,
	}})
	if got := clk.take(); !slices.Equal(got, []time.Duration{DefaultActiveTreeDebounce, DefaultActiveTreeDebounce}) {
		t.Fatalf("live worktree tree debounce = %v, want [%v, %v]", got, DefaultActiveTreeDebounce, DefaultActiveTreeDebounce)
	}
	store.treeDeb.cancel(jobKey{kind: jobStatus, projectID: r.ID, path: wt.Path})
	store.treeDeb.cancel(filesJob(r.ID, wt.Path))

	// Active worktree via WorktreeDetail watch (without live thread) also gets 300ms.
	store.SetLiveWorktrees(nil)
	if _, err := store.WorktreeDetail(ctx, r.ID, wt.Path); err != nil {
		t.Fatal(err)
	}
	store.onEvents([]fsevents.Event{{
		Path:  filepath.Join(wt.Path, "README.md"),
		Flags: fsevents.ItemModified | fsevents.ItemIsFile,
	}})
	if got := clk.take(); !slices.Equal(got, []time.Duration{DefaultActiveTreeDebounce}) {
		t.Fatalf("detail-watched worktree tree debounce = %v, want [%v]", got, DefaultActiveTreeDebounce)
	}

	// Explicit Options.TreeDebounce override (without ActiveTreeDebounce) is preserved.
	h2 := startHarness(t, "", Options{TreeDebounce: 120 * time.Millisecond})
	if h2.store.activeTreeWindow != 120*time.Millisecond || h2.store.treeDeb.window != 120*time.Millisecond {
		t.Fatalf("custom TreeDebounce override: active=%v default=%v, want 120ms/120ms",
			h2.store.activeTreeWindow, h2.store.treeDeb.window)
	}
}
