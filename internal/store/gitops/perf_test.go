package gitops

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

type fakeGitHub struct {
	mu  sync.Mutex
	prs map[string]struct {
		url string
		num int
	} // "slug|branch" -> PR
	notified []string // "slug|branch"
	openHits int
}

func (f *fakeGitHub) OpenBranchPR(slug, branch string) (string, int, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if pr, ok := f.prs[strings.ToLower(slug)+"|"+branch]; ok {
		f.openHits++
		return pr.url, pr.num, true
	}
	return "", 0, false
}

func (f *fakeGitHub) NotifyBranchChanged(_ context.Context, slug, branch string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notified = append(f.notified, strings.ToLower(slug)+"|"+branch)
}

func (f *fakeGitHub) notifications() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.notified)
}

func (f *fakeRunner) countByBase(base string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if filepath.Base(c.Name) == base {
			n++
		}
	}
	return n
}

func TestOpenPRCacheHitAndMiss(t *testing.T) {
	const cachedURL = "https://github.com/me/a/pull/42"
	const fallbackURL = "https://github.com/me/a/pull/99"

	t.Run("cache hit spawns zero git and zero gh subprocesses", func(t *testing.T) {
		fr := &fakeRunner{}
		ghBridge := &fakeGitHub{
			prs: map[string]struct {
				url string
				num int
			}{
				"me/a|main": {url: cachedURL, num: 42},
			},
		}
		// Gh intentionally points to a nonexistent path to prove gh is never invoked.
		w := newWorld(t, Options{Runner: fr, Gh: "/nonexistent/gh", GitHub: ghBridge})
		op := mustOp(t)(w.m.OpenPR(context.Background(), w.a))
		wantOK(t, op, "opened pull request #42")
		if op.URL != cachedURL {
			t.Errorf("url = %q, want %q", op.URL, cachedURL)
		}
		if got := fr.countByBase("git"); got != 0 {
			t.Errorf("git subprocesses = %d, want 0", got)
		}
		if got := fr.countByBase("gh"); got != 0 {
			t.Errorf("gh subprocesses = %d, want 0", got)
		}
		if open := fr.called("open"); len(open) != 1 || !slices.Equal(open[0].Args, []string{cachedURL}) {
			t.Errorf("open calls = %+v, want [%s]", open, cachedURL)
		}
		_ = w.m.Close()
		if len(w.projects.Calls) != 0 {
			t.Errorf("OpenPR triggered project refreshes: %v", w.projects.Calls)
		}
	})

	t.Run("cache miss falls back to gh pr view with zero git subprocesses", func(t *testing.T) {
		fr := &fakeRunner{reply: map[string]Result{"gh pr view": {Stdout: fallbackURL + "\n"}}}
		ghBridge := &fakeGitHub{prs: map[string]struct {
			url string
			num int
		}{}}
		w := newWorld(t, Options{Runner: fr, Gh: "gh", GitHub: ghBridge})
		op := mustOp(t)(w.m.OpenPR(context.Background(), w.a))
		wantOK(t, op, "opened pull request #99")
		if op.URL != fallbackURL {
			t.Errorf("url = %q, want %q", op.URL, fallbackURL)
		}
		if got := fr.countByBase("git"); got != 0 {
			t.Errorf("git subprocesses = %d, want 0", got)
		}
		if got := len(fr.called("gh pr view")); got != 1 {
			t.Errorf("gh pr view calls = %d, want 1", got)
		}
	})

	t.Run("detached HEAD fails fast without calling GitHub cache or gh", func(t *testing.T) {
		fr := &fakeRunner{}
		ghBridge := &fakeGitHub{
			prs: map[string]struct {
				url string
				num int
			}{
				"me/a|main": {url: cachedURL, num: 42},
			},
		}
		w := newWorld(t, Options{Runner: fr, Gh: "gh", GitHub: ghBridge})
		git(t, w.a, "switch", "-q", "--detach")
		op := mustOp(t)(w.m.OpenPR(context.Background(), w.a))
		wantFailed(t, op, "detached")
		if got := fr.countByBase("git"); got != 0 {
			t.Errorf("git subprocesses = %d, want 0", got)
		}
		if got := fr.countByBase("gh"); got != 0 {
			t.Errorf("gh subprocesses = %d, want 0", got)
		}
	})
}

func TestPushAndCreatePRNotifyGitHub(t *testing.T) {
	ctx := context.Background()

	t.Run("successful Push notifies GitHub bridge", func(t *testing.T) {
		ghBridge := &fakeGitHub{}
		w := newWorld(t, Options{GitHub: ghBridge})
		git(t, w.a, "switch", "-q", "-c", "feat/notify")
		commit(t, w.a, "n.txt", "1\n", "feat: notify")
		op := mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a}))
		wantOK(t, op, "pushed feat/notify to origin (new branch)")
		_ = w.m.Close()
		if got := ghBridge.notifications(); !slices.Equal(got, []string{"me/a|feat/notify"}) {
			t.Errorf("notifications = %v, want [me/a|feat/notify]", got)
		}
	})

	t.Run("failed Push does not notify GitHub bridge", func(t *testing.T) {
		ghBridge := &fakeGitHub{}
		w := newWorld(t, Options{GitHub: ghBridge})
		git(t, w.a, "switch", "-q", "--detach")
		wantFailed(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "detached")
		_ = w.m.Close()
		if got := ghBridge.notifications(); len(got) != 0 {
			t.Errorf("notifications after failed Push = %v, want none", got)
		}
	})

	t.Run("successful CreatePR notifies GitHub bridge", func(t *testing.T) {
		const prURL = "https://github.com/me/a/pull/7"
		fr := &fakeRunner{reply: map[string]Result{"gh pr create": {Stdout: prURL + "\n"}}}
		ghBridge := &fakeGitHub{}
		w := newWorld(t, Options{Runner: fr, Gh: "gh", GitHub: ghBridge})
		git(t, w.a, "switch", "-q", "-c", "feat/pr")
		commit(t, w.a, "p.txt", "1\n", "feat: pr")
		op := mustOp(t)(w.m.CreatePR(ctx, CreatePROptions{WorktreePath: w.a}))
		wantOK(t, op, "created pull request #7")
		_ = w.m.Close()
		if got := ghBridge.notifications(); !slices.Equal(got, []string{"me/a|feat/pr"}) {
			t.Errorf("notifications = %v, want [me/a|feat/pr]", got)
		}
	})

	t.Run("failed CreatePR does not notify GitHub bridge", func(t *testing.T) {
		fr := &fakeRunner{reply: map[string]Result{"gh pr create": {Combined: "GraphQL: failure\n", Err: errExit}}}
		ghBridge := &fakeGitHub{}
		w := newWorld(t, Options{Runner: fr, Gh: "gh", GitHub: ghBridge})
		git(t, w.a, "switch", "-q", "-c", "feat/fail-pr")
		commit(t, w.a, "p.txt", "1\n", "feat: fail")
		wantFailed(t, mustOp(t)(w.m.CreatePR(ctx, CreatePROptions{WorktreePath: w.a})), "GraphQL: failure")
		_ = w.m.Close()
		if got := ghBridge.notifications(); len(got) != 0 {
			t.Errorf("notifications after failed CreatePR = %v, want none", got)
		}
	})
}

func TestOpenEditorAndRevealZeroGitExecsAndNoRefresh(t *testing.T) {
	fr := &fakeRunner{}
	w := newWorld(t, Options{Runner: fr, Editor: func() string { return "zed" }})
	w.m.opts.editorEnv = &editorEnv{
		getenv:   func(string) string { return "" },
		lookPath: func(n string) (string, error) { return "/opt/bin/" + n, nil },
	}
	w.m.opts.Root = filepath.Dir(w.a)
	ctx := context.Background()

	wantOK(t, mustOp(t)(w.m.OpenEditor(ctx, OpenOptions{WorktreePath: w.a})), "opened a in zed")
	wantOK(t, mustOp(t)(w.m.OpenEditor(ctx, OpenOptions{WorktreePath: w.a, File: "README", Line: 1})), "opened README in zed")
	wantOK(t, mustOp(t)(w.m.Reveal(ctx, OpenOptions{WorktreePath: w.a})), "opened "+w.a+" in Finder")
	wantOK(t, mustOp(t)(w.m.Reveal(ctx, OpenOptions{WorktreePath: w.a, File: "README"})), "opened "+filepath.Join(w.a, "README")+" in Finder")

	if got := fr.countByBase("git"); got != 0 {
		t.Errorf("OpenEditor/Reveal spawned %d git subprocesses, want 0", got)
	}
	_ = w.m.Close()
	if len(w.projects.Calls) != 0 {
		t.Errorf("OpenEditor/Reveal triggered project refreshes: %v", w.projects.Calls)
	}
}

func TestPushMinimalProjectRefresh(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t, Options{})
	// Set DefaultBranch so feature-branch pushes can use TouchNow instead of full Refresh.
	w.projects.Put(project.Project{
		ID: "ra", Path: w.a, Name: "a", DefaultBranch: "main", GitHubSlug: "me/a",
		Remotes:   []string{"origin"},
		Worktrees: []project.Worktree{{ProjectID: "ra", Path: w.a, Branch: "main", IsMain: true}},
	})

	// Feature branch push: touches only the single worktree.
	git(t, w.a, "switch", "-q", "-c", "feat/minimal")
	commit(t, w.a, "m.txt", "1\n", "feat: minimal")
	wantOK(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "pushed feat/minimal to origin (new branch)")

	// No-op push ("already up to date"): skips both Refresh and TouchNow.
	wantOK(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "already up to date")

	// Wait for background refreshes by closing manager.
	_ = w.m.Close()
	if !slices.Equal(w.projects.Calls, []string{"TouchNow " + w.a}) {
		t.Errorf("project calls for feature push + no-op push = %v, want [TouchNow %s]", w.projects.Calls, w.a)
	}

	// Default branch push: triggers full project Refresh because origin/main moved.
	w2 := newWorld(t, Options{})
	w2.projects.Put(project.Project{
		ID: "ra", Path: w2.a, Name: "a", DefaultBranch: "main", GitHubSlug: "me/a",
		Remotes:   []string{"origin"},
		Worktrees: []project.Worktree{{ProjectID: "ra", Path: w2.a, Branch: "main", IsMain: true}},
	})
	commit(t, w2.a, "m.txt", "2\n", "main: update")
	wantOK(t, mustOp(t)(w2.m.Push(ctx, PushOptions{WorktreePath: w2.a})), "pushed main to origin")
	_ = w2.m.Close()
	if !slices.Equal(w2.projects.Calls, []string{"Refresh ra"}) {
		t.Errorf("project calls for default-branch push = %v, want [Refresh ra]", w2.projects.Calls)
	}
}

func TestReadHeadBranch(t *testing.T) {
	t.Run("parseHeadFile", func(t *testing.T) {
		tests := []struct {
			name         string
			content      string
			wantBranch   string
			wantAttached bool
			wantOK       bool
		}{
			{"main branch", "ref: refs/heads/main\n", "main", true, true},
			{"slashed branch", "ref: refs/heads/perf/gitops-update-gh-bridge\n", "perf/gitops-update-gh-bridge", true, true},
			{"detached sha1", strings.Repeat("a", 40) + "\n", "", false, true},
			{"detached sha256", strings.Repeat("0123456789abcdef", 4) + "\n", "", false, true},
			{"reftable placeholder falls back", "ref: refs/heads/.invalid\n", "", false, false},
			{"non-branch ref falls back", "ref: refs/tags/v1.0.0\n", "", false, false},
			{"empty falls back", "", "", false, false},
			{"garbage falls back", "not-a-sha", "", false, false},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				b, att, ok := parseHeadFile(tt.content)
				if b != tt.wantBranch || att != tt.wantAttached || ok != tt.wantOK {
					t.Errorf("parseHeadFile(%q) = (%q, %v, %v), want (%q, %v, %v)",
						tt.content, b, att, ok, tt.wantBranch, tt.wantAttached, tt.wantOK)
				}
			})
		}
	})

	t.Run("linked worktree and subdirectory", func(t *testing.T) {
		w := newWorld(t, Options{})
		wtDir := filepath.Join(filepath.Dir(w.a), "wt-linked")
		git(t, w.a, "worktree", "add", "-q", "-b", "feat/linked", wtDir)
		sub := filepath.Join(wtDir, "nested", "dir")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		b, att, ok := readHeadBranch(sub)
		if !ok || !att || b != "feat/linked" {
			t.Fatalf("readHeadBranch(%s) = (%q, %v, %v), want (feat/linked, true, true)", sub, b, att, ok)
		}
	})

	t.Run("relative gitdir pointer", func(t *testing.T) {
		root := t.TempDir()
		gitDir := filepath.Join(root, "actual-gitdir")
		wtDir := filepath.Join(root, "wt")
		if err := os.MkdirAll(gitDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(wtDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(gitDir, "HEAD"), []byte("ref: refs/heads/rel-branch\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wtDir, ".git"), []byte("gitdir: ../actual-gitdir\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		b, att, ok := readHeadBranch(wtDir)
		if !ok || !att || b != "rel-branch" {
			t.Fatalf("readHeadBranch(relative) = (%q, %v, %v), want (rel-branch, true, true)", b, att, ok)
		}
	})
}

type countingRunner struct {
	gitCalls atomic.Int64
	ghCalls  atomic.Int64
	open     atomic.Int64
}

func (r *countingRunner) Run(_ context.Context, c Cmd) Result {
	switch filepath.Base(c.Name) {
	case "git":
		r.gitCalls.Add(1)
	case "gh":
		r.ghCalls.Add(1)
	case "open":
		r.open.Add(1)
	}
	return Result{}
}

func BenchmarkOpenPRCacheHit(b *testing.B) {
	root := b.TempDir()
	wt := filepath.Join(root, "repo")
	if err := os.MkdirAll(filepath.Join(wt, ".git"), 0o755); err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wt, ".git", "HEAD"), []byte("ref: refs/heads/feat\n"), 0o644); err != nil {
		b.Fatal(err)
	}
	realWT, err := filepath.EvalSymlinks(wt)
	if err != nil {
		b.Fatal(err)
	}
	cr := &countingRunner{}
	ghBridge := &fakeGitHub{
		prs: map[string]struct {
			url string
			num int
		}{
			"me/a|feat": {url: "https://github.com/me/a/pull/42", num: 42},
		},
	}
	projects := &benchProjects{snap: &project.Snapshot{Projects: []project.Project{{
		ID: "ra", Path: realWT, Name: "a", GitHubSlug: "me/a", Remotes: []string{"origin"},
		Worktrees: []project.Worktree{{ProjectID: "ra", Path: realWT, Branch: "feat", IsMain: true}},
	}}}}
	m := New(Options{Bus: bus.New(), Projects: projects, Runner: cr, GitHub: ghBridge})
	b.Cleanup(func() { _ = m.Close() })

	ctx := context.Background()
	b.ResetTimer()
	for range b.N {
		op, err := m.OpenPR(ctx, realWT)
		if err != nil || !op.OK() {
			b.Fatalf("OpenPR: %v %+v", err, op)
		}
	}
	b.StopTimer()
	if got := cr.gitCalls.Load(); got != 0 {
		b.Fatalf("git subprocesses = %d, want 0", got)
	}
	if got := cr.ghCalls.Load(); got != 0 {
		b.Fatalf("gh subprocesses = %d, want 0", got)
	}
}

func BenchmarkRevealZeroGitExecs(b *testing.B) {
	root := b.TempDir()
	wt := filepath.Join(root, "repo")
	if err := os.MkdirAll(filepath.Join(wt, ".git"), 0o755); err != nil {
		b.Fatal(err)
	}
	realWT, err := filepath.EvalSymlinks(wt)
	if err != nil {
		b.Fatal(err)
	}
	cr := &countingRunner{}
	projects := &benchProjects{snap: &project.Snapshot{Projects: []project.Project{{
		ID: "ra", Path: realWT, Name: "a",
		Worktrees: []project.Worktree{{ProjectID: "ra", Path: realWT, Branch: "main", IsMain: true}},
	}}}}
	m := New(Options{Bus: bus.New(), Projects: projects, Runner: cr})
	b.Cleanup(func() { _ = m.Close() })

	ctx := context.Background()
	b.ResetTimer()
	for range b.N {
		op, err := m.Reveal(ctx, OpenOptions{WorktreePath: realWT})
		if err != nil || !op.OK() {
			b.Fatalf("Reveal: %v %+v", err, op)
		}
	}
	b.StopTimer()
	if got := cr.gitCalls.Load(); got != 0 {
		b.Fatalf("git subprocesses = %d, want 0", got)
	}
}

type benchProjects struct {
	snap *project.Snapshot
}

func (b *benchProjects) Snapshot() *project.Snapshot           { return b.snap }
func (b *benchProjects) Refresh(context.Context, string) error { return nil }
