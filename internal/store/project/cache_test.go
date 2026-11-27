package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// TestSnapshotCacheHydratesImmediatelyOnRestart verifies that after a clean Close, a
// restarted store immediately exposes cached project metadata and worktrees in Snapshot()
// before any git command completes, while keeping transient Error/Operation cleared and
// RefreshedAt/statusStamp unverified until a live git status completes.
func TestSnapshotCacheHydratesImmediatelyOnRestart(t *testing.T) {
	f := newFixture(t)
	git(t, f.project, "remote", "set-url", "origin", "https://github.com/acme/proj.git")
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	wtRoot := filepath.Join(f.base, "wt")

	h := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/cached"})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(wt.Path, "dirty.txt"), "hello\n")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	beforeProj, ok := h.store.Snapshot().Project(r.ID)
	if !ok {
		t.Fatal("missing project before close")
	}
	beforeWT, ok := h.store.Snapshot().Worktree(r.ID, wt.Path)
	if !ok || !beforeWT.Status.Dirty || beforeWT.Status.Untracked != 1 {
		t.Fatalf("worktree before close = %+v", beforeWT)
	}
	h.close()

	// Restart with blockedRunner so NO git command can complete: everything in Snapshot()
	// must come purely from SQLite cold-start hydration.
	h2 := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot, Runner: blockedRunner{}})
	gotProj, ok := h2.store.Snapshot().Project(r.ID)
	if !ok {
		t.Fatal("missing project after restart")
	}
	if !gotProj.Git || gotProj.DefaultBranch != "main" || gotProj.GitHubSlug != "acme/proj" ||
		gotProj.OriginPath != "/acme/proj.git" || !slices.Equal(gotProj.Remotes, []string{"origin"}) ||
		gotProj.Error != "" {
		t.Fatalf("hydrated project = %+v", gotProj)
	}
	if len(gotProj.Worktrees) != 2 {
		t.Fatalf("hydrated worktrees = %d, want 2", len(gotProj.Worktrees))
	}
	gotWT, ok := h2.store.Snapshot().Worktree(r.ID, wt.Path)
	if !ok {
		t.Fatalf("hydrated linked worktree %s missing", wt.Path)
	}
	if gotWT.Branch != "feat/cached" || gotWT.Head != beforeWT.Head || !gotWT.Managed ||
		!gotWT.Status.Dirty || gotWT.Status.Untracked != 1 || gotWT.Status.BaseRef != "origin/main" ||
		gotWT.Status.Error != "" || gotWT.Status.Operation != "" {
		t.Fatalf("hydrated worktree = %+v", gotWT)
	}
	// Hydrated slots keep RefreshedAt zero so CleanupVerdict/clean guards treat them as
	// unverified until the first live git status completes.
	if !gotWT.Status.RefreshedAt.IsZero() {
		t.Errorf("hydrated RefreshedAt = %v, want zero", gotWT.Status.RefreshedAt)
	}
	// Hydrated slots must have nil statusStamp so CompareWorktree never trusts unverified
	// Conflicted == 0 before a live git status completes.
	if slot := h2.store.slot(r.ID, wt.Path); slot == nil || slot.statusStamp.Load() != nil {
		t.Fatalf("hydrated slot statusStamp should be nil, got %v", slot.statusStamp.Load())
	}
	if len(beforeProj.Worktrees) != len(gotProj.Worktrees) {
		t.Fatalf("worktree count mismatch: before=%d after=%d", len(beforeProj.Worktrees), len(gotProj.Worktrees))
	}
}

// TestSnapshotCacheDropsDeletedWorktreesAndReconcilesDrift verifies that directories
// deleted while the daemon was down never ghost on startup, and that live reconcile +
// status still run after hydration to pick up any drift (new commits, dirty files, etc.).
func TestSnapshotCacheDropsDeletedWorktreesAndReconcilesDrift(t *testing.T) {
	f := newFixture(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	wtRoot := filepath.Join(f.base, "wt")

	h := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/gone"})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	h.close()

	// While daemon is stopped: delete the linked worktree and dirty the main checkout.
	git(t, f.project, "worktree", "remove", "--force", wt.Path)
	writeFile(t, filepath.Join(f.project, "offline-edit.txt"), "offline\n")

	// Restart with blockedRunner first to check immediate hydrated snapshot: deleted
	// worktree must already be dropped on load.
	hBlocked := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot, Runner: blockedRunner{}})
	if _, ok := hBlocked.store.Snapshot().Worktree(r.ID, wt.Path); ok {
		t.Fatalf("deleted worktree %s ghosted in hydrated snapshot", wt.Path)
	}
	if _, ok := hBlocked.store.Snapshot().Worktree(r.ID, f.project); !ok {
		t.Fatal("main worktree missing from hydrated snapshot")
	}
	hBlocked.close()

	// Restart with real runner: live startup reconcile + status must pick up offline edit
	// and populate statusStamp.
	hLive := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot})
	hLive.waitFor("offline edit reconciled", worktreeUpdated(f.project, func(w Worktree) bool {
		return w.Status.Dirty && w.Status.Untracked == 1
	}))
	if slot := hLive.store.slot(r.ID, f.project); slot == nil || slot.statusStamp.Load() == nil {
		t.Fatal("expected live status to populate statusStamp after startup")
	}
}

// TestSnapshotCacheResilientToCorruptJSONAndVersionMismatch verifies that corrupt JSON
// or unknown versions in project_snapshot_cache never fail Start() and are healed once
// reconcile runs.
func TestSnapshotCacheResilientToCorruptJSONAndVersionMismatch(t *testing.T) {
	f := newFixture(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")

	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	h.close()

	cases := []struct {
		name    string
		payload string
	}{
		{"malformed JSON", "{not valid json"},
		{"future version", `{"v":999,"default_branch":"nope","git":true}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hCorrupt := startHarness(t, dbPath, Options{Runner: blockedRunner{}})
			if _, err := hCorrupt.db.ExecContext(ctx,
				`UPDATE project_snapshot_cache SET snapshot_json = ? WHERE project_id = ?`,
				tc.payload, r.ID); err != nil {
				t.Fatal(err)
			}
			hCorrupt.close()

			// Blocked restart must not fail and must treat corrupt row as a cache miss.
			hCheck := startHarness(t, dbPath, Options{Runner: blockedRunner{}})
			p, ok := hCheck.store.Snapshot().Project(r.ID)
			if !ok {
				t.Fatal("project missing")
			}
			if p.DefaultBranch != "" || len(p.Worktrees) != 0 {
				t.Fatalf("corrupt cache should be ignored, got %+v", p)
			}
			hCheck.close()

			// Live restart heals the cache row.
			hLive := startHarness(t, dbPath, Options{})
			if err := hLive.store.Refresh(ctx, r.ID); err != nil {
				t.Fatal(err)
			}
			hLive.close()

			hVerify := startHarness(t, dbPath, Options{Runner: blockedRunner{}})
			p2, ok := hVerify.store.Snapshot().Project(r.ID)
			if !ok || p2.DefaultBranch != "main" || len(p2.Worktrees) != 1 {
				t.Fatalf("healed cache not hydrated: %+v", p2)
			}
			hVerify.close()
		})
	}
}

// TestSnapshotCacheGitFlipAndUnregisterCleanup covers:
// 1. Plain directory turning into a git repo while daemon is stopped (disk wins).
// 2. Unregister cascades and removes the project_snapshot_cache row.
func TestSnapshotCacheGitFlipAndUnregisterCleanup(t *testing.T) {
	dir := newPlainDir(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")

	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	h.close()

	// Initialize git while daemon is stopped.
	git(t, dir, "init", "-q", "-b", "main")
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "init")

	// Restart with blockedRunner: hasDotGit sees true != cached.Git (false), so stale
	// plain-dir cache is ignored while Git=true is reported immediately.
	h2 := startHarness(t, dbPath, Options{Runner: blockedRunner{}})
	p, ok := h2.store.Snapshot().Project(r.ID)
	if !ok || !p.Git || len(p.Worktrees) != 0 {
		t.Fatalf("after offline git init: %+v", p)
	}
	h2.close()

	// Live restart updates cache, then Unregister deletes the cache row via FK cascade.
	h3 := startHarness(t, dbPath, Options{})
	if err := h3.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	h3.close()

	h4 := startHarness(t, dbPath, Options{})
	if err := h4.store.Unregister(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := h4.db.QueryRowContext(ctx, `SELECT count(*) FROM project_snapshot_cache WHERE project_id = ?`, r.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("cache rows after Unregister = %d, want 0", count)
	}
}

// TestSnapshotCacheDeletedProjectDirSkipped ensures a project whose main directory was
// removed while down does not hydrate stale worktrees on startup.
func TestSnapshotCacheDeletedProjectDirSkipped(t *testing.T) {
	f := newFixture(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")

	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	h.close()

	if err := os.RemoveAll(f.project); err != nil {
		t.Fatal(err)
	}
	h2 := startHarness(t, dbPath, Options{Runner: blockedRunner{}})
	p, ok := h2.store.Snapshot().Project(r.ID)
	if !ok {
		t.Fatal("project missing")
	}
	if len(p.Worktrees) != 0 || p.DefaultBranch != "" {
		t.Fatalf("deleted project should not hydrate stale metadata/worktrees: %+v", p)
	}
}

// noStatusRunner runs every git command for real but holds `git status` until its
// context ends, so a test sees what the reconcile alone publishes.
type noStatusRunner struct{ ExecRunner }

func (r noStatusRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if len(args) > 0 && args[0] == "status" {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return r.ExecRunner.Run(ctx, dir, args...)
}

// failRunner fails every git command: a reconcile that cannot read the project.
type failRunner struct{}

func (failRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return nil, errors.New("boom")
}

// A hydrated project is Cached until its first successful reconcile, and the snapshot
// that clears it already carries what the reconcile listed: a worktree that switched
// branch or detached while the daemon was down is reseeded from the listing, not left
// on the cached branch until its status job runs. A failed reconcile leaves it Cached; a
// project registered this run never is.
func TestSnapshotCacheCachedUntilLiveReconcile(t *testing.T) {
	tests := []struct {
		name       string
		whileDown  func(t *testing.T, wt string)
		runner     Runner
		wantCached bool
		wantError  bool
		check      func(t *testing.T, w Worktree)
	}{
		{name: "nothing changed", runner: noStatusRunner{NewExecRunner()},
			check: func(t *testing.T, w Worktree) {
				if w.Branch != "feat/x" || w.Detached || !w.Status.Dirty {
					t.Errorf("worktree %+v; want feat/x with its cached status kept", w)
				}
			}},
		{name: "worktree switched branch", runner: noStatusRunner{NewExecRunner()},
			whileDown: func(t *testing.T, wt string) { git(t, wt, "switch", "-q", "-c", "feat/y") },
			check: func(t *testing.T, w Worktree) {
				if w.Branch != "feat/y" || w.Detached || w.Status.Dirty {
					t.Errorf("worktree %+v; want feat/y, its cached status (of feat/x) dropped", w)
				}
			}},
		{name: "worktree detached", runner: noStatusRunner{NewExecRunner()},
			whileDown: func(t *testing.T, wt string) { git(t, wt, "switch", "-q", "--detach") },
			check: func(t *testing.T, w Worktree) {
				if w.Branch != "" || !w.Detached {
					t.Errorf("worktree %+v; want detached", w)
				}
			}},
		{name: "reconcile failed", runner: failRunner{}, wantCached: true, wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			dbPath := filepath.Join(t.TempDir(), "db.sqlite")
			wtRoot := filepath.Join(f.base, "wt")
			ctx := context.Background()
			h := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot})
			r, err := h.store.Register(ctx, f.project)
			if err != nil {
				t.Fatal(err)
			}
			if p, _ := h.store.Snapshot().Project(r.ID); p.Cached {
				t.Fatal("a project registered this run is Cached")
			}
			wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/x"})
			if err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(wt.Path, "dirty.txt"), "x\n")
			if err := h.store.Refresh(ctx, r.ID); err != nil {
				t.Fatal(err)
			}
			h.close()
			if tt.whileDown != nil {
				git(t, wt.Path, "stash", "-q", "-u") // a clean tree to switch from
				tt.whileDown(t, wt.Path)
			}

			h2 := startHarness(t, dbPath, Options{WorktreeRoot: wtRoot, Runner: tt.runner})
			if p, _ := h2.store.Snapshot().Project(r.ID); !p.Cached {
				t.Fatal("hydrated project not Cached")
			}
			ev := h2.waitFor("the first reconcile's project event", func(ev Event) bool {
				u, ok := ev.(ProjectUpdated)
				return ok && u.Project.ID == r.ID
			})
			p := ev.(ProjectUpdated).Project
			if p.Cached != tt.wantCached || (p.Error != "") != tt.wantError {
				t.Fatalf("after the first reconcile: Cached %v, Error %q", p.Cached, p.Error)
			}
			if tt.check == nil {
				return
			}
			for _, w := range p.Worktrees {
				if w.Path == wt.Path {
					tt.check(t, w)
					return
				}
			}
			t.Fatalf("worktree %s not in the event's project", wt.Path)
		})
	}
}
