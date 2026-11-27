package daemon

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// gatedRunner holds every git command until release is closed, then runs it for real:
// the window between a start (the snapshot hydrated from the last run's cache) and the
// first live reconcile, held open for as long as a test needs.
type gatedRunner struct{ release <-chan struct{} }

func (r gatedRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	select {
	case <-r.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return project.NewExecRunner().Run(ctx, dir, args...)
}

// TestGatesWaitForLiveReconcile runs the real project store across a restart. The first
// run caches a project whose default branch is main and a worktree on feat/a. While the
// daemon is down the worktree switches to feat/b and origin's default branch becomes
// trunk. On the next start, before the first live reconcile, the snapshot is the cached
// one: the branch links, the settling of old links and the notifications' settle gate
// must all wait, then decide on what is on disk.
func TestGatesWaitForLiveReconcile(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	origin, seed, repo := filepath.Join(base, "origin.git"), filepath.Join(base, "seed"), filepath.Join(base, "repo")
	gitIn(t, base, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, base, "clone", "-q", origin, seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, seed, "add", ".")
	gitIn(t, seed, "commit", "-q", "-m", "one")
	gitIn(t, seed, "push", "-q", "origin", "main", "main:trunk")
	gitIn(t, base, "clone", "-q", origin, repo)
	// No fetch runs (FetchInterval -1), so a GitHub URL that is never reached is fine.
	gitIn(t, repo, "remote", "set-url", "origin", "https://github.com/acme/proj.git")
	wt := filepath.Join(base, "wt-a")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feat/a", wt)

	d, err := db.Open(context.Background(), dbtest.Path(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	opts := project.Options{
		DB: d, Bus: bus.New(), WorktreeRoot: filepath.Join(base, "worktrees"), AllowedRoot: base,
		FetchInterval: -1, PollInterval: -1,
	}
	first, err := project.Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	p, err := first.Register(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Refresh(context.Background(), p.ID); err != nil {
		t.Fatal(err)
	}
	if w, ok := first.Snapshot().Worktree(p.ID, wt); !ok || w.Branch != "feat/a" {
		t.Fatalf("first run: worktree %+v", w)
	}
	if err := first.Close(); err != nil { // flushes the snapshot cache
		t.Fatal(err)
	}

	// While the daemon is down.
	gitIn(t, wt, "switch", "-q", "-c", "feat/b")
	gitIn(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")

	release := make(chan struct{})
	b := bus.New()
	events := bus.Subscribe[project.Event](b, 256)
	defer events.Close()
	opts.Bus, opts.Runner = b, gatedRunner{release}
	second, err := project.Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })

	th := thread.Thread{ID: "t", ProjectID: p.ID, WorktreePath: wt, CreatedAt: branchT0}
	old := oldBranchLink("acme/proj", 3) // a link from before heads were recorded
	threadsWith := func(links ...thread.LinkedPullRequest) *thread.Snapshot {
		t := th
		t.LinkedPullRequests = links
		return &thread.Snapshot{Threads: []thread.Thread{t}}
	}
	idx := prsByHead([]gh.PullRequest{branchPR("acme/proj", 1, "feat/a"), branchPR("acme/proj", 2, "feat/b")})
	known := map[gh.PullRequestRef]prHead{{Slug: "acme/proj", Number: 3}: {head: "trunk"}}
	now := branchT0.Add(time.Hour)

	// Before the first live reconcile: the cached snapshot (feat/a, main).
	cached := second.Snapshot()
	if w, ok := cached.Worktree(p.ID, wt); !ok || w.Branch != "feat/a" {
		t.Fatalf("hydrated worktree %+v; want the cached feat/a", w)
	}
	if r, _ := cached.Project(p.ID); r.DefaultBranch != "main" {
		t.Fatalf("hydrated default branch %q; want the cached main", r.DefaultBranch)
	}
	if got := branchFacts(t, branchLinksFor(threadsWith(), cached, idx, now), now); len(got) != 0 {
		t.Errorf("branch links before the first live reconcile: %q; want none", got)
	}
	if ids, _, _ := settleBranchLinks(unsettledBranchLinks(threadsWith(old)), cached, known); len(ids) != 0 {
		t.Errorf("settled %q before the first live reconcile; want it to wait", ids)
	}
	if projectsSettled(cached) {
		t.Error("projects settled before the first live reconcile")
	}

	close(release)
	timeout := time.After(10 * time.Second)
	live := cached
	for !reconciledLive(live, p.ID) {
		select {
		case <-events.C():
			live = second.Snapshot()
		case <-timeout:
			t.Fatalf("no live reconcile: %+v", live.Projects)
		}
	}
	if w, ok := live.Worktree(p.ID, wt); !ok || w.Branch != "feat/b" {
		t.Fatalf("live worktree %+v; want feat/b in the reconcile's own snapshot", w)
	}
	if got := branchFacts(t, branchLinksFor(threadsWith(), live, idx, now), now); len(got) != 1 || got[0] != "t: acme/proj#2@2" {
		t.Errorf("branch links after the live reconcile: %q; want feat/b's #2", got)
	}
	_, out, _ := settleBranchLinks(unsettledBranchLinks(threadsWith(old)), live, known)
	if s := out["t"]; s == nil || len(s.drop) != 1 || len(s.heads) != 0 {
		t.Errorf("settlement after the live reconcile: %+v; want #3 dropped (its head is the default branch, trunk)", s)
	}
	if !projectsSettled(live) {
		t.Error("projects not settled after the live reconcile")
	}
}

// reconciledLive reports whether project id has been reconciled live in s.
func reconciledLive(s *project.Snapshot, id string) bool {
	r, ok := s.Project(id)
	return ok && !r.Cached
}
