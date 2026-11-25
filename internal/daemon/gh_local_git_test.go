package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

type countingRawRunner struct {
	mu      sync.Mutex
	calls   int
	latency time.Duration
	diff    string
	file    string
}

func (r *countingRawRunner) GraphQL(context.Context, string, map[string]any) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func (r *countingRawRunner) AuthStatus(context.Context) (gh.AuthStatus, error) {
	return gh.AuthStatus{LoggedIn: true, Login: "tester"}, nil
}

func (r *countingRawRunner) RESTRaw(ctx context.Context, p string, _ map[string]string, accept string, _ int64) (gh.RawResponse, error) {
	r.mu.Lock()
	r.calls++
	lat := r.latency
	diff, file := r.diff, r.file
	r.mu.Unlock()
	if lat > 0 {
		select {
		case <-time.After(lat):
		case <-ctx.Done():
			return gh.RawResponse{}, ctx.Err()
		}
	}
	if strings.Contains(accept, ".diff") {
		return gh.RawResponse{Body: []byte(diff), ContentType: accept}, nil
	}
	return gh.RawResponse{Body: []byte(file), ContentType: accept}, nil
}

func (r *countingRawRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func runGitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestGhLocalGitBridgeEndToEndAndPerf(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repoDir := filepath.Join(root, "repo")
	wtRoot := filepath.Join(root, "worktrees")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repoDir, "init", "-q", "-b", "main")
	runGitTest(t, repoDir, "config", "user.name", "Test")
	runGitTest(t, repoDir, "config", "user.email", "test@example.com")
	runGitTest(t, repoDir, "remote", "add", "origin", "https://github.com/acme/foundry.git")
	if err := os.WriteFile(filepath.Join(repoDir, "app.go"), []byte("package app\n\nfunc Hello() string { return \"old\" }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repoDir, "add", ".")
	runGitTest(t, repoDir, "commit", "-q", "-m", "initial")

	runGitTest(t, repoDir, "checkout", "-q", "-b", "feat/fast")
	if err := os.WriteFile(filepath.Join(repoDir, "app.go"), []byte("package app\n\nfunc Hello() string { return \"new\" }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repoDir, "add", ".")
	runGitTest(t, repoDir, "commit", "-q", "-m", "update hello")
	headSHA := runGitTest(t, repoDir, "rev-parse", "HEAD")

	// Advance main so merge-base != baseHead.
	runGitTest(t, repoDir, "checkout", "-q", "main")
	if err := os.WriteFile(filepath.Join(repoDir, "main.txt"), []byte("unrelated main commit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repoDir, "add", ".")
	runGitTest(t, repoDir, "commit", "-q", "-m", "advance main")
	baseSHA := runGitTest(t, repoDir, "rev-parse", "HEAD")

	sqldb, err := db.Open(ctx, dbtest.Path(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sqldb.Close() }()

	b := bus.New()
	proj, err := project.Start(ctx, project.Options{
		DB:            sqldb,
		Bus:           b,
		WorktreeRoot:  wtRoot,
		AllowedRoot:   root,
		FetchInterval: -1,
		PollInterval:  -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = proj.Close() }()
	if _, err := proj.Register(ctx, repoDir); err != nil {
		t.Fatal(err)
	}

	// Seed cached FullPullRequest in SQLite gh_activity so Store.PullRequestDiff knows base+head.
	seedFull := func(slug string, number int, base, head string) {
		payload := fmt.Sprintf(`{"v":3,"data":{"pullRequest":{"number":%d,"repo":%q,"baseSha":%q,"headSha":%q,"state":"OPEN"},"fetchedAt":"2026-11-25T00:00:00Z"}}`,
			number, slug, base, head)
		if _, err := sqldb.ExecContext(ctx,
			`INSERT INTO gh_activity (key, fetched_at, payload) VALUES (?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
			fmt.Sprintf("pr_detail:%s#%d", slug, number), time.Now().UnixMilli(), payload); err != nil {
			t.Fatal(err)
		}
	}
	seedFull("acme/foundry", 12, baseSHA, headSHA)
	seedFull("uncloned/fork", 99, strings.Repeat("1", 40), strings.Repeat("2", 40))

	startGhStore := func(local gh.LocalGitProvider, runner *countingRawRunner) (*gh.Store, func()) {
		s, err := gh.New(ctx, gh.Options{
			DB:           sqldb,
			Runner:       runner,
			LocalGit:     local,
			MinGap:       50 * time.Millisecond,
			UserGap:      25 * time.Millisecond,
			PollInterval: time.Hour,
			IdleInterval: time.Hour,
		})
		if err != nil {
			t.Fatal(err)
		}
		runCtx, stopRun := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = s.Run(runCtx)
		}()
		return s, func() { stopRun(); <-done }
	}

	// 1. BEFORE baseline: LocalGit=nil (GitHub REST with realistic 40ms RTT + pacing).
	runnerBefore := &countingRawRunner{latency: 40 * time.Millisecond, diff: "diff --git a/app.go b/app.go\n+new\n", file: "package app\n"}
	sBefore, stopBefore := startGhStore(nil, runnerBefore)
	t0 := time.Now()
	if _, err := sBefore.PullRequestDiff(ctx, "acme/foundry", 12, false); err != nil {
		t.Fatal(err)
	}
	beforeDiffDur := time.Since(t0)
	t1 := time.Now()
	if _, err := sBefore.PullRequestFile(ctx, "acme/foundry", headSHA, "app.go"); err != nil {
		t.Fatal(err)
	}
	beforeFileDur := time.Since(t1)
	beforeCalls := runnerBefore.count()
	stopBefore()

	// Clear SQLite diff row so AFTER tests real local-git execution (not SQLite).
	if _, err := sqldb.ExecContext(ctx, `DELETE FROM gh_pr_diffs`); err != nil {
		t.Fatal(err)
	}

	// 2. AFTER: wired local-git bridge (*project.Git -> ghLocalGitBridge -> *gh.Store).
	runnerAfter := &countingRawRunner{latency: 40 * time.Millisecond, diff: "diff --git a/fork.go b/fork.go\n+fork\n", file: "fallback"}
	sAfter, stopAfter := startGhStore(newGhLocalGit(proj), runnerAfter)

	// Warm catFilePool once for steady-state file read measurement, and also measure cold diff.
	t2 := time.Now()
	dLocal, err := sAfter.PullRequestDiff(ctx, "acme/foundry", 12, false)
	if err != nil {
		t.Fatal(err)
	}
	afterDiffDur := time.Since(t2)
	if !strings.Contains(dLocal.Diff, `func Hello() string { return "new" }`) || strings.Contains(dLocal.Diff, "main.txt") {
		t.Fatalf("unexpected local diff:\n%s", dLocal.Diff)
	}

	t3 := time.Now()
	fLocal, err := sAfter.PullRequestFile(ctx, "acme/foundry", headSHA, "app.go")
	if err != nil {
		t.Fatal(err)
	}
	afterFileColdDur := time.Since(t3)
	if !strings.Contains(string(fLocal.Contents), `return "new"`) || fLocal.Binary || fLocal.NotFound {
		t.Fatalf("unexpected local file: %+v", fLocal)
	}
	// Second file (same commit, warm catFilePool, uncached path) to measure warm pooled cat-file.
	t4 := time.Now()
	fMissing, err := sAfter.PullRequestFile(ctx, "acme/foundry", headSHA, "absent.go")
	if err != nil || !fMissing.NotFound {
		t.Fatalf("absent local file: %+v, err=%v", fMissing, err)
	}
	afterFileWarmDur := time.Since(t4)
	if runnerAfter.count() != 0 {
		t.Fatalf("expected 0 REST calls for local repo diff+files, got %d", runnerAfter.count())
	}

	// 3. Uncloned/fork PR falls back to REST and persists to SQLite.
	t5 := time.Now()
	dFork1, err := sAfter.PullRequestDiff(ctx, "uncloned/fork", 99, false)
	if err != nil {
		t.Fatal(err)
	}
	forkFirstDur := time.Since(t5)
	if runnerAfter.count() != 1 || !strings.Contains(dFork1.Diff, "+fork") {
		t.Fatalf("fork first fetch: calls=%d diff=%q", runnerAfter.count(), dFork1.Diff)
	}
	stopAfter()

	// 4. Restart gh.Store on same DB: uncloned/fork PR diff now hits SQLite with 0 REST calls.
	runnerRestart := &countingRawRunner{latency: 40 * time.Millisecond, diff: "should-not-call"}
	sRestart, stopRestart := startGhStore(newGhLocalGit(proj), runnerRestart)
	defer stopRestart()
	t6 := time.Now()
	dFork2, err := sRestart.PullRequestDiff(ctx, "uncloned/fork", 99, false)
	if err != nil {
		t.Fatal(err)
	}
	forkRestartDur := time.Since(t6)
	if runnerRestart.count() != 0 || dFork2.Diff != dFork1.Diff {
		t.Fatalf("fork post-restart: calls=%d diff=%q", runnerRestart.count(), dFork2.Diff)
	}

	t.Logf("METRIC local_pr_diff: before=%v (rest_calls=%d) after=%v (rest_calls=0)", beforeDiffDur, beforeCalls/2, afterDiffDur)
	t.Logf("METRIC local_pr_file: before=%v (rest_calls=%d) after_cold=%v after_warm=%v (rest_calls=0)", beforeFileDur, beforeCalls/2, afterFileColdDur, afterFileWarmDur)
	t.Logf("METRIC non_local_pr_diff_restart: before_rest=%v (rest_calls=1) after_sqlite=%v (rest_calls=0)", forkFirstDur, forkRestartDur)
}
