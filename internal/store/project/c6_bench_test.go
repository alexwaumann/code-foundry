package project

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
)

type c6Fixture struct {
	base       string
	dbPath     string
	wtRoot     string
	projIDs    []string
	projPaths  []string
	countFile  string
	gitWrapper string
}

func newC6Fixture(tb testing.TB, numProjects, extraWorktreesPerProject int) c6Fixture {
	tb.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		tb.Skip("git not installed")
	}
	cfg := filepath.Join(tb.TempDir(), "gitconfig")
	content := "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n"
	if err := os.WriteFile(cfg, []byte(content), 0o600); err != nil {
		tb.Fatal(err)
	}
	tb.Setenv("GIT_CONFIG_GLOBAL", cfg)
	tb.Setenv("GIT_CONFIG_NOSYSTEM", "1")

	base, err := filepath.EvalSymlinks(tb.TempDir())
	if err != nil {
		tb.Fatal(err)
	}
	dbPath := filepath.Join(base, "c6.db")
	wtRoot := filepath.Join(base, "wt")

	runGit := func(dir string, args ...string) {
		tb.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			tb.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}

	projPaths := make([]string, 0, numProjects)
	for i := range numProjects {
		origin := filepath.Join(base, fmt.Sprintf("origin-%d.git", i))
		proj := filepath.Join(base, fmt.Sprintf("proj-%d", i))
		runGit(base, "init", "-q", "--bare", "-b", "main", origin)
		runGit(base, "init", "-q", "-b", "main", proj)
		if err := os.WriteFile(filepath.Join(proj, "README.md"), fmt.Appendf(nil, "# proj-%d\n", i), 0o644); err != nil {
			tb.Fatal(err)
		}
		runGit(proj, "add", ".")
		runGit(proj, "commit", "-q", "-m", "initial commit")
		runGit(proj, "remote", "add", "origin", origin)
		runGit(proj, "push", "-q", "-u", "origin", "main")
		runGit(proj, "remote", "set-head", "origin", "main")
		// Set GitHub URL after pushing so GitHubSlug is populated without network calls.
		runGit(proj, "remote", "set-url", "origin", fmt.Sprintf("https://github.com/acme/proj-%d.git", i))
		projPaths = append(projPaths, proj)
	}

	gitBin, err := exec.LookPath("git")
	if err != nil {
		tb.Fatal(err)
	}
	countFile := filepath.Join(base, "git-spawns.log")
	gitWrapper := filepath.Join(base, "git-wrap.sh")
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %q\nexec %q \"$@\"\n", countFile, gitBin)
	if err := os.WriteFile(gitWrapper, []byte(script), 0o755); err != nil {
		tb.Fatal(err)
	}

	// Seed the DB with all projects and worktrees, then close cleanly so the cache flushes.
	d, err := db.Open(context.Background(), dbPath)
	if err != nil {
		tb.Fatal(err)
	}
	b := bus.New()
	fake := newFakeStream()
	s, err := Start(context.Background(), Options{
		DB:                d,
		Bus:               b,
		WorktreeRoot:      wtRoot,
		AllowedRoot:       base,
		FetchInterval:     -1,
		PollInterval:      -1,
		IdleFetchInterval: -1,
		IdlePollInterval:  -1,
		streams:           fake.source,
	})
	if err != nil {
		_ = d.Close()
		tb.Fatal(err)
	}
	ctx := context.Background()
	projIDs := make([]string, 0, numProjects)
	for i, p := range projPaths {
		r, err := s.Register(ctx, p)
		if err != nil {
			tb.Fatal(err)
		}
		projIDs = append(projIDs, r.ID)
		for j := range extraWorktreesPerProject {
			if _, err := s.CreateWorktree(ctx, CreateWorktreeOptions{
				ProjectID: r.ID,
				Branch:    fmt.Sprintf("feat/p%d-wt%d", i, j),
			}); err != nil {
				tb.Fatal(err)
			}
		}
		if err := s.Refresh(ctx, r.ID); err != nil {
			tb.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		tb.Fatal(err)
	}
	if err := d.Close(); err != nil {
		tb.Fatal(err)
	}

	return c6Fixture{
		base:       base,
		dbPath:     dbPath,
		wtRoot:     wtRoot,
		projIDs:    projIDs,
		projPaths:  projPaths,
		countFile:  countFile,
		gitWrapper: gitWrapper,
	}
}

func (f c6Fixture) resetSpawns(tb testing.TB) {
	tb.Helper()
	if err := os.WriteFile(f.countFile, nil, 0o644); err != nil {
		tb.Fatal(err)
	}
}

func (f c6Fixture) spawns(tb testing.TB) (int, []string) {
	tb.Helper()
	b, err := os.ReadFile(f.countFile)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		tb.Fatal(err)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return 0, nil
	}
	lines := strings.Split(s, "\n")
	return len(lines), lines
}

func snapshotPopulated(snap *Snapshot, wantProjects, wantWorktrees int) (projectsReady, worktreesReady int, ok bool) {
	if snap == nil {
		return 0, 0, false
	}
	for _, p := range snap.Projects {
		if p.GitHubSlug != "" && p.DefaultBranch != "" && len(p.Worktrees) > 0 {
			projectsReady++
		}
		for _, w := range p.Worktrees {
			if w.Branch != "" && w.Head != "" {
				worktreesReady++
			}
		}
	}
	return projectsReady, worktreesReady, projectsReady == wantProjects && worktreesReady == wantWorktrees
}

func TestC6Metrics(t *testing.T) {
	if os.Getenv("RUN_C6_METRICS") == "" {
		t.Skip("set RUN_C6_METRICS=1 to measure C6 cold-start and reconcile metrics")
	}
	const (
		numProjects = 5
		extraWTs    = 2 // 3 worktrees per project = 15 total
		totalWTs    = numProjects * (1 + extraWTs)
	)
	f := newC6Fixture(t, numProjects, extraWTs)
	ctx := context.Background()

	// 1. Cold daemon restart: Start() -> first populated Snapshot() across 5 projects / 15 worktrees.
	d, err := db.Open(ctx, f.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	b := bus.New()
	fake := newFakeStream()
	f.resetSpawns(t)

	t0 := time.Now()
	s, err := Start(ctx, Options{
		DB:                d,
		Bus:               b,
		WorktreeRoot:      f.wtRoot,
		AllowedRoot:       f.base,
		Runner:            ExecRunner{Git: f.gitWrapper},
		FetchInterval:     -1,
		PollInterval:      -1,
		IdleFetchInterval: -1,
		IdlePollInterval:  -1,
		streams:           fake.source,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	startDur := time.Since(t0)
	spawnsAtStart, _ := f.spawns(t)
	initProj, initWT, readyAtStart := snapshotPopulated(s.Snapshot(), numProjects, totalWTs)

	var populatedDur time.Duration
	var spawnsAtPopulated int
	if readyAtStart {
		populatedDur = startDur
		spawnsAtPopulated = spawnsAtStart
	} else {
		deadline := time.Now().Add(15 * time.Second)
		for {
			_, _, ok := snapshotPopulated(s.Snapshot(), numProjects, totalWTs)
			if ok {
				populatedDur = time.Since(t0)
				spawnsAtPopulated, _ = f.spawns(t)
				break
			}
			if time.Now().After(deadline) {
				p, w, _ := snapshotPopulated(s.Snapshot(), numProjects, totalWTs)
				t.Fatalf("timed out waiting for populated snapshot: got %d/%d projects, %d/%d worktrees", p, numProjects, w, totalWTs)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	t.Logf("Cold start (5 projects, 15 worktrees):")
	t.Logf("  Start() return:           %v (projects=%d/%d, worktrees=%d/%d, ready=%v, git spawns=%d)",
		startDur.Round(100*time.Microsecond), initProj, numProjects, initWT, totalWTs, readyAtStart, spawnsAtStart)
	t.Logf("  First populated Snapshot: %v (git spawns=%d)",
		populatedDur.Round(100*time.Microsecond), spawnsAtPopulated)

	// Wait for all startup jobs to drain before measuring direct reconcile.
	for _, id := range f.projIDs {
		if err := s.Refresh(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	s.sched.close()

	// 2. Reconcile across 5 projects (average over 5 rounds).
	const rounds = 5
	f.resetSpawns(t)
	r0 := time.Now()
	for range rounds {
		for _, id := range f.projIDs {
			s.reconcile(ctx, id)
		}
	}
	recDur := time.Since(r0)
	totalSpawns, lines := f.spawns(t)
	t.Logf("Reconcile (5 projects x %d rounds):", rounds)
	t.Logf("  Avg wall per 5-project round: %v (%.2f ms/project)",
		(recDur / rounds).Round(100*time.Microsecond), float64(recDur.Microseconds())/float64(rounds*numProjects)/1000.0)
	t.Logf("  Git spawns per 5-project round: %d (%.1f/project)",
		totalSpawns/rounds, float64(totalSpawns)/float64(rounds*numProjects))
	if len(lines) > 0 {
		t.Logf("  Sample spawns: %v", lines[:min(10, len(lines))])
	}
}

func BenchmarkC6Reconcile5Projects(b *testing.B) {
	f := newC6Fixture(b, 5, 2)
	ctx := context.Background()
	d, err := db.Open(ctx, f.dbPath)
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	busInst := bus.New()
	fake := newFakeStream()
	s, err := Start(ctx, Options{
		DB:                d,
		Bus:               busInst,
		WorktreeRoot:      f.wtRoot,
		AllowedRoot:       f.base,
		FetchInterval:     -1,
		PollInterval:      -1,
		IdleFetchInterval: -1,
		IdlePollInterval:  -1,
		streams:           fake.source,
	})
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	for _, id := range f.projIDs {
		if err := s.Refresh(ctx, id); err != nil {
			b.Fatal(err)
		}
	}
	s.sched.close()
	b.ResetTimer()
	for range b.N {
		for _, id := range f.projIDs {
			s.reconcile(ctx, id)
		}
	}
}

func BenchmarkC6ColdStart5Projects15Worktrees(b *testing.B) {
	f := newC6Fixture(b, 5, 2)
	ctx := context.Background()
	d, err := db.Open(ctx, f.dbPath)
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = d.Close() }()

	b.ResetTimer()
	for range b.N {
		busInst := bus.New()
		fake := newFakeStream()
		s, err := Start(ctx, Options{
			DB:                d,
			Bus:               busInst,
			WorktreeRoot:      f.wtRoot,
			AllowedRoot:       f.base,
			FetchInterval:     -1,
			PollInterval:      -1,
			IdleFetchInterval: -1,
			IdlePollInterval:  -1,
			streams:           fake.source,
		})
		if err != nil {
			b.Fatal(err)
		}
		for {
			if _, _, ok := snapshotPopulated(s.Snapshot(), 5, 15); ok {
				break
			}
			time.Sleep(time.Millisecond)
		}
		b.StopTimer()
		_ = s.Close()
		b.StartTimer()
	}
}
