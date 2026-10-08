package repo

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/db"
)

// isolateGit points git at a throwaway global config so the developer's config
// (signing, hooks, default branch, fsmonitor) cannot affect the tests. The store's
// runner inherits this environment.
func isolateGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	content := "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n"
	if err := os.WriteFile(cfg, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s (in %s): %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// fixture is a repo "proj" with one commit pushed to a bare "origin", plus a second
// clone ("other") that can push to origin. All paths are symlink-resolved.
type fixture struct {
	base, origin, repo, other string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	isolateGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := fixture{
		base:   base,
		origin: filepath.Join(base, "origin.git"),
		repo:   filepath.Join(base, "proj"),
		other:  filepath.Join(base, "other"),
	}
	git(t, base, "init", "-q", "--bare", "-b", "main", f.origin)
	git(t, base, "init", "-q", "-b", "main", f.repo)
	writeFile(t, filepath.Join(f.repo, "README.md"), "hello\n")
	if err := os.MkdirAll(filepath.Join(f.repo, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.repo, "sub", "x.txt"), "x\n")
	git(t, f.repo, "add", ".")
	git(t, f.repo, "commit", "-q", "-m", "init")
	git(t, f.repo, "remote", "add", "origin", f.origin)
	git(t, f.repo, "push", "-q", "-u", "origin", "main")
	git(t, f.repo, "remote", "set-head", "origin", "main")
	git(t, base, "clone", "-q", f.origin, f.other)
	return f
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

type harness struct {
	t     *testing.T
	store *Git
	bus   *bus.Bus
	sub   *bus.Subscription[Event]
	db    *sql.DB
}

func startHarness(t *testing.T, dbPath string, opts Options) *harness {
	t.Helper()
	if dbPath == "" {
		dbPath = filepath.Join(t.TempDir(), "db.sqlite")
	}
	d, err := db.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	sub := bus.Subscribe[Event](b, 1024)
	opts.DB, opts.Bus = d, b
	opts.Debounce = 50 * time.Millisecond
	if opts.FetchInterval == 0 {
		opts.FetchInterval = -1
	}
	if opts.PollInterval == 0 {
		opts.PollInterval = -1
	}
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, store: s, bus: b, sub: sub, db: d}
	t.Cleanup(h.close)
	return h
}

func (h *harness) close() {
	if h.store != nil {
		_ = h.store.Close()
		h.store = nil
		h.sub.Close()
		_ = h.db.Close()
	}
}

// waitFor returns the first event matching pred, failing after timeout.
func (h *harness) waitFor(what string, pred func(Event) bool) Event {
	h.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev := <-h.sub.C():
			if pred(ev) {
				return ev
			}
		case <-deadline:
			h.t.Fatalf("timed out waiting for %s", what)
			return nil
		}
	}
}

func worktreeUpdated(path string, pred func(Worktree) bool) func(Event) bool {
	return func(ev Event) bool {
		u, ok := ev.(WorktreeUpdated)
		return ok && u.Worktree.Path == path && pred(u.Worktree)
	}
}

func TestRegisterReportsRepoWorktreesAndStatus(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()

	// Any path inside the repo works, including a symlinked one.
	link := filepath.Join(f.base, "link")
	if err := os.Symlink(f.repo, link); err != nil {
		t.Fatal(err)
	}
	r, err := h.store.Register(ctx, filepath.Join(link, "sub"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Path != f.repo || r.Name != "proj" || r.ID != repoID(f.repo) || r.DefaultBranch != "main" ||
		r.GitHubSlug != "" || r.Error != "" || r.RegisteredAt.IsZero() {
		t.Fatalf("repo = %+v", r)
	}
	if len(r.Worktrees) != 1 {
		t.Fatalf("worktrees = %+v", r.Worktrees)
	}
	w := r.Worktrees[0]
	want := Status{Upstream: "origin/main", BaseRef: "origin/main"}
	got := w.Status
	got.RefreshedAt = time.Time{}
	if !w.IsMain || w.Path != f.repo || w.Branch != "main" || len(w.Head) != 40 || got != want {
		t.Fatalf("main worktree = %+v", w)
	}
	if _, ok := h.waitFor("RepoUpdated", func(ev Event) bool { _, ok := ev.(RepoUpdated); return ok }).(RepoUpdated); !ok {
		t.Fatal("no RepoUpdated")
	}

	// Registering again (from the .git dir even) is idempotent.
	again, err := h.store.Register(ctx, filepath.Join(f.repo, ".git"))
	if err != nil || again.ID != r.ID || !again.RegisteredAt.Equal(r.RegisteredAt) {
		t.Fatalf("re-register = %+v, %v", again, err)
	}
	if n := len(h.store.Snapshot().Repos); n != 1 {
		t.Fatalf("snapshot has %d repos", n)
	}

	// Edits inside a subdirectory are not seen by the non-recursive watcher, but
	// Refresh picks them up; untracked + modified + staged are counted.
	writeFile(t, filepath.Join(f.repo, "sub", "x.txt"), "changed\n")
	writeFile(t, filepath.Join(f.repo, "sub", "new.txt"), "new\n")
	writeFile(t, filepath.Join(f.repo, "staged.txt"), "s\n")
	git(t, f.repo, "add", "staged.txt")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	wt, _ := h.store.Snapshot().Worktree(r.ID, f.repo)
	if s := wt.Status; s.Modified != 1 || s.Untracked != 1 || s.Staged != 1 || !s.Dirty {
		t.Fatalf("status after edits = %+v", s)
	}
}

func TestWorktreeLifecycleAndWatcher(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}

	// New branch from origin/main at the default path, without tracking origin/main.
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "alex/feat"})
	if err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(f.base, "proj.worktrees", "alex-feat")
	if w.Path != wantPath || w.Branch != "alex/feat" || w.IsMain || w.Status.Upstream != "" ||
		w.Status.BaseRef != "origin/main" || w.Status.BaseAhead != 0 || w.Status.Dirty {
		t.Fatalf("worktree = %+v", w)
	}
	if got := len(h.store.Snapshot().Repos[0].Worktrees); got != 2 {
		t.Fatalf("worktrees in snapshot = %d", got)
	}

	// Top-level file in the worktree root -> watcher -> WorktreeUpdated.
	writeFile(t, filepath.Join(w.Path, "dirty.txt"), "x\n")
	h.waitFor("untracked file", worktreeUpdated(w.Path, func(w Worktree) bool { return w.Status.Untracked == 1 }))

	// Commit inside the worktree: reflog/index in its admin dir -> new head, ahead of base.
	git(t, w.Path, "add", "dirty.txt")
	git(t, w.Path, "commit", "-q", "-m", "wip")
	h.waitFor("commit", worktreeUpdated(w.Path, func(w Worktree) bool {
		return !w.Status.Dirty && w.Status.BaseAhead == 1
	}))

	// Someone else pushes to main; a fetch (run by hand here) moves origin/main and the
	// main worktree goes behind.
	writeFile(t, filepath.Join(f.other, "o.txt"), "o\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "other")
	git(t, f.other, "push", "-q")
	git(t, f.repo, "fetch", "-q")
	h.waitFor("behind after fetch", worktreeUpdated(f.repo, func(w Worktree) bool { return w.Status.Behind == 1 }))

	// The main worktree cannot be removed; a dirty worktree needs force.
	if err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{RepoID: r.ID, Path: f.repo}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("remove main: %v", err)
	}
	writeFile(t, filepath.Join(w.Path, "more.txt"), "m\n")
	if err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{RepoID: r.ID, Path: w.Path}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("remove dirty without force: %v", err)
	}
	if err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{RepoID: r.ID, Path: w.Path, Force: true, DeleteBranch: true}); err != nil {
		t.Fatal(err)
	}
	h.waitFor("WorktreeRemoved", func(ev Event) bool {
		rm, ok := ev.(WorktreeRemoved)
		return ok && rm.Path == w.Path && rm.RepoID == r.ID
	})
	if got := len(h.store.Snapshot().Repos[0].Worktrees); got != 1 {
		t.Fatalf("worktrees after remove = %d", got)
	}
	if out := git(t, f.repo, "branch", "--list", "alex/feat"); out != "" {
		t.Fatalf("branch not deleted: %q", out)
	}
}

func TestCreateWorktreeBranchResolution(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}

	// Existing local branch is checked out as is.
	git(t, f.repo, "branch", "local-only")
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "local-only"})
	if err != nil || w.Branch != "local-only" {
		t.Fatalf("local branch: %+v, %v", w, err)
	}

	// Remote-only branch: git's DWIM creates a local branch tracking origin/<branch>.
	git(t, f.other, "checkout", "-q", "-b", "remote-only")
	git(t, f.other, "push", "-q", "-u", "origin", "remote-only")
	git(t, f.repo, "fetch", "-q")
	explicit := filepath.Join(f.base, "elsewhere", "ro")
	w, err = h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "remote-only", Path: explicit})
	if err != nil || w.Path != explicit || w.Branch != "remote-only" || w.Status.Upstream != "origin/remote-only" {
		t.Fatalf("remote branch: %+v, %v", w, err)
	}

	// Explicit base ref.
	w, err = h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "from-head", BaseRef: "HEAD"})
	if err != nil || w.Branch != "from-head" {
		t.Fatalf("base ref: %+v, %v", w, err)
	}

	// Errors.
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "bad..name"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("bad branch: %v", err)
	}
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "x", Path: "rel/path"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("relative path: %v", err)
	}
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "main"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("branch already checked out: %v", err)
	}
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: "nope", Branch: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown repo: %v", err)
	}
}

func TestExternalWorktreeAddAndRemoveAreDetected(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), f.repo)
	if err != nil {
		t.Fatal(err)
	}
	ext := filepath.Join(f.base, "ext")
	// First linked worktree: creates .git/worktrees (event on the common dir).
	git(t, f.repo, "worktree", "add", "-q", "-b", "ext", ext)
	h.waitFor("RepoUpdated with external worktree", func(ev Event) bool {
		u, ok := ev.(RepoUpdated)
		return ok && u.Repo.ID == r.ID && len(u.Repo.Worktrees) == 2
	})
	// Second one: entry in .git/worktrees.
	ext2 := filepath.Join(f.base, "ext2")
	git(t, f.repo, "worktree", "add", "-q", "--detach", ext2)
	h.waitFor("detached external worktree", func(ev Event) bool {
		u, ok := ev.(RepoUpdated)
		if !ok || len(u.Repo.Worktrees) != 3 {
			return false
		}
		for _, w := range u.Repo.Worktrees {
			if w.Path == ext2 {
				return w.Detached && w.Branch == ""
			}
		}
		return false
	})
	git(t, f.repo, "worktree", "remove", ext)
	h.waitFor("external remove", func(ev Event) bool {
		rm, ok := ev.(WorktreeRemoved)
		return ok && rm.Path == ext
	})
}

func TestUnregisterAndReloadFromDB(t *testing.T) {
	f := newFixture(t)
	second := filepath.Join(f.base, "second")
	git(t, f.base, "init", "-q", "-b", "main", second)
	git(t, second, "remote", "add", "origin", "git@github.com:acme/second.git")

	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r1, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := h.store.Register(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	// Unborn branch: no head, no base comparison, default branch falls back to main.
	if r2.GitHubSlug != "acme/second" || r2.DefaultBranch != "main" || len(r2.Worktrees) != 1 ||
		r2.Worktrees[0].Head != "" || r2.Worktrees[0].Branch != "main" || r2.Worktrees[0].Status.Error != "" {
		t.Fatalf("second = %+v", r2)
	}
	if err := h.store.Unregister(ctx, r1.ID); err != nil {
		t.Fatal(err)
	}
	h.waitFor("RepoRemoved", func(ev Event) bool { rm, ok := ev.(RepoRemoved); return ok && rm.ID == r1.ID })
	if err := h.store.Unregister(ctx, r1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second unregister: %v", err)
	}
	if _, err := os.Stat(f.repo); err != nil {
		t.Fatal("unregister touched the repo on disk")
	}
	h.close()

	// A fresh store on the same DB loads the remaining repo and reconciles it async.
	h2 := startHarness(t, dbPath, Options{})
	snap := h2.store.Snapshot()
	if len(snap.Repos) != 1 || snap.Repos[0].ID != r2.ID || !snap.Repos[0].RegisteredAt.Equal(r2.RegisteredAt) {
		t.Fatalf("reloaded = %+v", snap.Repos)
	}
	h2.waitFor("initial reconcile", func(ev Event) bool {
		u, ok := ev.(RepoUpdated)
		return ok && u.Repo.ID == r2.ID && len(u.Repo.Worktrees) == 1
	})
}

func TestRegisterErrors(t *testing.T) {
	isolateGit(t)
	base, _ := filepath.EvalSymlinks(t.TempDir())
	bare := filepath.Join(base, "bare.git")
	git(t, base, "init", "-q", "--bare", bare)
	h := startHarness(t, "", Options{})
	for _, p := range []string{"", base, bare, filepath.Join(base, "missing")} {
		if _, err := h.store.Register(context.Background(), p); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Register(%q) err = %v, want ErrInvalidArgument", p, err)
		}
	}
	if err := h.store.Refresh(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Refresh(unknown) = %v", err)
	}
}

func TestMissingRepoReportsErrorAndRecovers(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{PollInterval: 100 * time.Millisecond})
	r, err := h.store.Register(context.Background(), f.repo)
	if err != nil {
		t.Fatal(err)
	}
	moved := f.repo + "-moved"
	if err := os.Rename(f.repo, moved); err != nil {
		t.Fatal(err)
	}
	h.waitFor("repo error", func(ev Event) bool {
		u, ok := ev.(RepoUpdated)
		return ok && u.Repo.ID == r.ID && u.Repo.Error != "" && len(u.Repo.Worktrees) == 0
	})
	if err := os.Rename(moved, f.repo); err != nil {
		t.Fatal(err)
	}
	h.waitFor("repo recovered", func(ev Event) bool {
		u, ok := ev.(RepoUpdated)
		return ok && u.Repo.ID == r.ID && u.Repo.Error == "" && len(u.Repo.Worktrees) == 1
	})
}

// countingRunner counts git subcommands.
type countingRunner struct {
	next Runner
	mu   sync.Mutex
	n    map[string]int
}

func (c *countingRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	c.mu.Lock()
	c.n[args[0]]++
	c.mu.Unlock()
	return c.next.Run(ctx, dir, args...)
}

func (c *countingRunner) count(sub string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[sub]
}

// Our own git commands must not trigger the watcher. `git status` would rewrite the
// index (and fire the watcher, forever) without GIT_OPTIONAL_LOCKS=0.
func TestNoSelfTriggeredRefreshLoop(t *testing.T) {
	f := newFixture(t)
	// Make the index stale so a plain `git status` would want to rewrite it.
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(f.repo, "README.md"), future, future); err != nil {
		t.Fatal(err)
	}
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr})
	if _, err := h.store.Register(context.Background(), f.repo); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // let any echo settle
	before := cr.count("status")
	time.Sleep(time.Second)
	if after := cr.count("status"); after != before {
		t.Fatalf("status ran %d more times while idle: refresh loop", after-before)
	}
}

func TestFetchErrorIsNotFatal(t *testing.T) {
	f := newFixture(t)
	git(t, f.repo, "remote", "set-url", "origin", filepath.Join(f.base, "does-not-exist.git"))
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, FetchInterval: 50 * time.Millisecond})
	r, err := h.store.Register(context.Background(), f.repo)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for cr.count("fetch") < 2 {
		if time.Now().After(deadline) {
			t.Fatal("fetch never retried")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := h.store.Refresh(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := h.store.Snapshot().Repo(r.ID)
	if got.Error != "" || len(got.Worktrees) != 1 || got.Worktrees[0].Status.Error != "" {
		t.Fatalf("fetch failure leaked into state: %+v", got)
	}
}

func TestPeriodicFetch(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{FetchInterval: 200 * time.Millisecond})
	if _, err := h.store.Register(context.Background(), f.repo); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.other, "o.txt"), "o\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "other")
	git(t, f.other, "push", "-q")
	h.waitFor("behind via periodic fetch", worktreeUpdated(f.repo, func(w Worktree) bool { return w.Status.Behind == 1 }))
}
