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

type b1Fixture struct {
	h          *harness
	id, path   string
	baseSHA    string
	headSHA    string
	files      []string
	cleanPath  string
	countFile  string
	gitWrapper string
}

func startHarnessForBench(tb testing.TB, opts Options) *harness {
	tb.Helper()
	dbPath := filepath.Join(tb.TempDir(), "bench.db")
	d, err := db.Open(context.Background(), dbPath)
	if err != nil {
		tb.Fatal(err)
	}
	b := bus.New()
	sub := bus.Subscribe[Event](b, 1024)
	opts.DB, opts.Bus = d, b
	if opts.WorktreeRoot == "" {
		opts.WorktreeRoot = filepath.Join(tb.TempDir(), "worktrees")
	}
	if opts.AllowedRoot == "" {
		opts.AllowedRoot = os.TempDir()
	}
	opts.Debounce = 50 * time.Millisecond
	if opts.TreeDebounce == 0 {
		opts.TreeDebounce = 50 * time.Millisecond
	}
	if opts.FetchInterval == 0 {
		opts.FetchInterval = -1
	}
	if opts.PollInterval == 0 {
		opts.PollInterval = -1
	}
	if opts.IdleFetchInterval == 0 {
		opts.IdleFetchInterval = opts.FetchInterval
	}
	if opts.IdlePollInterval == 0 {
		opts.IdlePollInterval = opts.PollInterval
	}
	var fake *fakeStream
	if opts.streams == nil {
		fake = newFakeStream()
		opts.streams = fake.source
	}
	s, err := Start(context.Background(), opts)
	if err != nil {
		tb.Fatal(err)
	}
	h := &harness{store: s, bus: b, sub: sub, db: d, fake: fake}
	tb.Cleanup(h.close)
	return h
}

func newB1Fixture(tb testing.TB, countGit bool) b1Fixture {
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
	origin := filepath.Join(base, "origin.git")
	proj := filepath.Join(base, "proj")

	runGit := func(dir string, args ...string) string {
		tb.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			tb.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}

	runGit(base, "init", "-q", "--bare", "-b", "main", origin)
	runGit(base, "init", "-q", "-b", "main", proj)

	// Create 30 base files (~4 KB each).
	bodyBase := strings.Repeat("base line of code for realistic diff benchmark\n", 80)
	var files []string
	for i := range 30 {
		name := fmt.Sprintf("pkg/file_%02d.go", i)
		p := filepath.Join(proj, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			tb.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(fmt.Sprintf("// file %d\n%s", i, bodyBase)), 0o644); err != nil {
			tb.Fatal(err)
		}
		files = append(files, name)
	}
	runGit(proj, "add", ".")
	runGit(proj, "commit", "-q", "-m", "initial commit\n\nDetailed commit body for benchmarking CompareCommitBody.\nLine 2 of commit body.\n")
	runGit(proj, "remote", "add", "origin", origin)
	runGit(proj, "push", "-q", "-u", "origin", "main")
	runGit(proj, "remote", "set-head", "origin", "main")
	baseSHA := runGit(proj, "rev-parse", "HEAD")

	// Add extra branches for ListRefs.
	for i := range 10 {
		runGit(proj, "branch", fmt.Sprintf("feat/branch-%02d", i))
	}

	opts := Options{WorktreeRoot: filepath.Join(base, "wt")}
	var countFile, gitWrapper string
	if countGit {
		gitBin, err := exec.LookPath("git")
		if err != nil {
			tb.Fatal(err)
		}
		countFile = filepath.Join(base, "git-spawns.log")
		gitWrapper = filepath.Join(base, "git-wrap.sh")
		script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %q\nexec %q \"$@\"\n", countFile, gitBin)
		if err := os.WriteFile(gitWrapper, []byte(script), 0o755); err != nil {
			tb.Fatal(err)
		}
		opts.Runner = ExecRunner{Git: gitWrapper}
	}

	h := startHarnessForBench(tb, opts)
	ctx := context.Background()
	r, err := h.store.Register(ctx, proj)
	if err != nil {
		tb.Fatal(err)
	}

	// Dirty worktree with branch changes + untracked files.
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/dirty"})
	if err != nil {
		tb.Fatal(err)
	}
	bodyMod := strings.Repeat("modified line of code for realistic diff benchmark\n", 80)
	for i := range 20 {
		p := filepath.Join(wt.Path, files[i])
		if err := os.WriteFile(p, []byte(fmt.Sprintf("// modified %d\n%s", i, bodyMod)), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	runGit(wt.Path, "add", ".")
	runGit(wt.Path, "commit", "-q", "-m", "feature changes\n\nBody explaining the feature commit in detail.\nSecond paragraph.\n")
	headSHA := runGit(wt.Path, "rev-parse", "HEAD")

	// Add 15 untracked files (~200 lines each) and 1 unstaged edit.
	untrackedBody := strings.Repeat("untracked content line\n", 200)
	for i := range 15 {
		p := filepath.Join(wt.Path, fmt.Sprintf("untracked_%02d.txt", i))
		if err := os.WriteFile(p, []byte(untrackedBody), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(wt.Path, files[0]), []byte("// working tree edit\n"+bodyMod), 0o644); err != nil {
		tb.Fatal(err)
	}

	// Clean worktree with branch commits only.
	cleanWT, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/clean"})
	if err != nil {
		tb.Fatal(err)
	}
	for i := range 10 {
		p := filepath.Join(cleanWT.Path, files[i])
		if err := os.WriteFile(p, []byte(fmt.Sprintf("// clean branch %d\n%s", i, bodyMod)), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	runGit(cleanWT.Path, "add", ".")
	runGit(cleanWT.Path, "commit", "-q", "-m", "clean branch work")

	// Settle statuses & details so Worktree status is fresh (as in real daemon).
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		tb.Fatal(err)
	}
	if _, err := h.store.WorktreeDetail(ctx, r.ID, wt.Path); err != nil {
		tb.Fatal(err)
	}
	if _, err := h.store.WorktreeDetail(ctx, r.ID, cleanWT.Path); err != nil {
		tb.Fatal(err)
	}

	return b1Fixture{
		h:          h,
		id:         r.ID,
		path:       wt.Path,
		baseSHA:    baseSHA,
		headSHA:    headSHA,
		files:      files[:20],
		cleanPath:  cleanWT.Path,
		countFile:  countFile,
		gitWrapper: gitWrapper,
	}
}

func (f b1Fixture) resetSpawns(tb testing.TB) {
	tb.Helper()
	if f.countFile != "" {
		if err := os.WriteFile(f.countFile, nil, 0o644); err != nil {
			tb.Fatal(err)
		}
	}
}

func (f b1Fixture) spawns(tb testing.TB) (int, []string) {
	tb.Helper()
	if f.countFile == "" {
		return 0, nil
	}
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

func TestB1SubprocessCounts(t *testing.T) {
	if os.Getenv("RUN_B1_METRICS") == "" {
		t.Skip("set RUN_B1_METRICS=1 to run baseline/after subprocess measurement")
	}
	f := newB1Fixture(t, true)
	ctx := context.Background()

	// 1a. CompareFile commit-to-commit (10 distinct files, cold pool)
	f.resetSpawns(t)
	for i := range 10 {
		if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{
			ProjectID: f.id, Path: f.path,
			Base: sourceRef(f.baseSHA), Head: sourceRef(f.headSHA),
			File: f.files[i],
		}); err != nil {
			t.Fatal(err)
		}
	}
	n1Cold, lines1Cold := f.spawns(t)
	t.Logf("CompareFile commit-to-commit (10 distinct files, cold pool): %d git spawns (%.1f/call)\n  sample: %v", n1Cold, float64(n1Cold)/10, lines1Cold[:min(8, len(lines1Cold))])

	// 1b. CompareFile commit-to-commit (next 10 distinct files, warm pool, uncached files)
	f.resetSpawns(t)
	for i := 10; i < 20; i++ {
		if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{
			ProjectID: f.id, Path: f.path,
			Base: sourceRef(f.baseSHA), Head: sourceRef(f.headSHA),
			File: f.files[i],
		}); err != nil {
			t.Fatal(err)
		}
	}
	n1Warm, lines1Warm := f.spawns(t)
	t.Logf("CompareFile commit-to-commit (10 distinct files, warm pool): %d git spawns (%.1f/call)\n  sample: %v", n1Warm, float64(n1Warm)/10, lines1Warm[:min(8, len(lines1Warm))])

	// 1c. CompareFile commit-to-commit (10 repeated files, cached)
	f.resetSpawns(t)
	for i := range 10 {
		if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{
			ProjectID: f.id, Path: f.path,
			Base: sourceRef(f.baseSHA), Head: sourceRef(f.headSHA),
			File: f.files[i],
		}); err != nil {
			t.Fatal(err)
		}
	}
	n1Repeat, _ := f.spawns(t)
	t.Logf("CompareFile commit-to-commit (10 repeated files, cached): %d git spawns (%.1f/call)", n1Repeat, float64(n1Repeat)/10)

	// 2. CompareFile merge-base-to-worktree (10 distinct files after CompareWorktree)
	if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
		ProjectID: f.id, Path: f.path,
		Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
	}); err != nil {
		t.Fatal(err)
	}
	f.resetSpawns(t)
	for i := range 10 {
		if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{
			ProjectID: f.id, Path: f.path,
			Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
			File: f.files[i],
		}); err != nil {
			t.Fatal(err)
		}
	}
	n2, lines2 := f.spawns(t)
	t.Logf("CompareFile merge-base-to-worktree (10 files after CompareWorktree): %d git spawns (%.1f/call)\n  sample: %v", n2, float64(n2)/10, lines2[:min(8, len(lines2))])

	// 3. CompareWorktree clean worktree (5 calls)
	f.resetSpawns(t)
	for range 5 {
		if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
			ProjectID: f.id, Path: f.cleanPath,
			Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
		}); err != nil {
			t.Fatal(err)
		}
	}
	n3, lines3 := f.spawns(t)
	t.Logf("CompareWorktree clean worktree (5 calls): %d git spawns (%.1f/call)\n  sample: %v", n3, float64(n3)/5, lines3[:min(8, len(lines3))])

	// 4. CompareWorktree dirty worktree with 15 untracked files (5 calls)
	f.resetSpawns(t)
	for range 5 {
		if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
			ProjectID: f.id, Path: f.path,
			Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
		}); err != nil {
			t.Fatal(err)
		}
	}
	n4, lines4 := f.spawns(t)
	t.Logf("CompareWorktree dirty+untracked (5 calls): %d git spawns (%.1f/call)\n  sample: %v", n4, float64(n4)/5, lines4[:min(8, len(lines4))])

	// 5. CompareWorktree commit-to-commit (5 calls)
	f.resetSpawns(t)
	for range 5 {
		if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
			ProjectID: f.id, Path: f.path,
			Base: sourceRef(f.baseSHA), Head: sourceRef(f.headSHA),
		}); err != nil {
			t.Fatal(err)
		}
	}
	n5, _ := f.spawns(t)
	t.Logf("CompareWorktree commit-to-commit (5 calls): %d git spawns (%.1f/call)", n5, float64(n5)/5)

	// 6. CompareCommitBody repeated (10 calls)
	f.resetSpawns(t)
	for range 10 {
		if _, err := f.h.store.CompareCommitBody(ctx, CompareCommitRequest{
			ProjectID: f.id, Path: f.path, SHA: f.headSHA,
		}); err != nil {
			t.Fatal(err)
		}
	}
	n6, _ := f.spawns(t)
	t.Logf("CompareCommitBody repeated (10 calls): %d git spawns (%.1f/call)", n6, float64(n6)/10)

	// 7. ListRefs repeated (10 calls)
	f.resetSpawns(t)
	for range 10 {
		if _, err := f.h.store.ListRefs(ctx, f.id); err != nil {
			t.Fatal(err)
		}
	}
	n7, _ := f.spawns(t)
	t.Logf("ListRefs repeated (10 calls): %d git spawns (%.1f/call)", n7, float64(n7)/10)
}

func BenchmarkB1CompareFileCommitToCommitCached(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	req := CompareFileRequest{
		ProjectID: f.id, Path: f.path,
		Base: sourceRef(f.baseSHA), Head: sourceRef(f.headSHA),
		File: f.files[0],
	}
	if _, err := f.h.store.CompareFile(ctx, req); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for range b.N {
		if _, err := f.h.store.CompareFile(ctx, req); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1CompareFileReadRevSide(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := guarded(context.Background())
	// Warm once.
	if _, err := f.h.store.readRevSide(ctx, f.path, f.headSHA, f.files[0]); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := range b.N {
		if _, err := f.h.store.readRevSide(ctx, f.path, f.headSHA, f.files[i%len(f.files)]); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1CompareFileCommitToWorktree(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
		ProjectID: f.id, Path: f.path,
		Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
	}); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := range b.N {
		if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{
			ProjectID: f.id, Path: f.path,
			Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
			File: f.files[i%len(f.files)],
		}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1CompareWorktreeClean(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	b.ResetTimer()
	for range b.N {
		if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
			ProjectID: f.id, Path: f.cleanPath,
			Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
		}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1CompareWorktreeDirtyUntracked(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	b.ResetTimer()
	for range b.N {
		if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{
			ProjectID: f.id, Path: f.path,
			Base: DiffSource{Kind: SourceMergeBase}, Head: sourceWorking,
		}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1CompareWorktreeCommitToCommit(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	req := CompareRequest{
		ProjectID: f.id, Path: f.path,
		Base: sourceRef(f.baseSHA), Head: sourceRef(f.headSHA),
	}
	if _, err := f.h.store.CompareWorktree(ctx, req); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for range b.N {
		if _, err := f.h.store.CompareWorktree(ctx, req); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1CompareCommitBody(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	req := CompareCommitRequest{ProjectID: f.id, Path: f.path, SHA: f.headSHA}
	if _, err := f.h.store.CompareCommitBody(ctx, req); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for range b.N {
		if _, err := f.h.store.CompareCommitBody(ctx, req); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkB1ListRefs(b *testing.B) {
	f := newB1Fixture(b, false)
	ctx := context.Background()
	if _, err := f.h.store.ListRefs(ctx, f.id); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for range b.N {
		if _, err := f.h.store.ListRefs(ctx, f.id); err != nil {
			b.Fatal(err)
		}
	}
}
