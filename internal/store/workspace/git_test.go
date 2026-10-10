package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// End to end against real git through the real repo store.

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s (in %s): %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestWithGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// web has an origin; api is local-only.
	origin := filepath.Join(base, "web.git")
	gitCmd(t, base, "init", "-q", "--bare", "-b", "main", origin)
	for _, name := range []string{"web", "api"} {
		dir := filepath.Join(base, name)
		gitCmd(t, base, "init", "-q", "-b", "main", dir)
		if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		gitCmd(t, dir, "add", ".")
		gitCmd(t, dir, "commit", "-q", "-m", "init")
	}
	web, api := filepath.Join(base, "web"), filepath.Join(base, "api")
	gitCmd(t, web, "remote", "add", "origin", origin)
	gitCmd(t, web, "push", "-q", "-u", "origin", "main")
	gitCmd(t, web, "remote", "set-head", "origin", "main")

	ctx := context.Background()
	d, err := db.Open(ctx, filepath.Join(base, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	b := bus.New()
	repos, err := repo.Start(ctx, repo.Options{DB: d, Bus: b, WorktreeRoot: filepath.Join(base, "worktrees"),
		FetchInterval: -1, PollInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repos.Close() }()
	for _, p := range []string{web, api} {
		if _, err := repos.Register(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	var threads []Thread
	m, err := New(ctx, Options{DB: d, Repos: repos, Bus: b, Threads: func() []Thread { return threads }})
	if err != nil {
		t.Fatal(err)
	}

	// The second member fails (its branch is checked out elsewhere): the first
	// member's worktree and new branch are rolled back.
	gitCmd(t, api, "worktree", "add", "-q", "-b", "cf/busy", filepath.Join(base, "busy"))
	if _, err := m.Create(ctx, CreateOptions{Name: "busy", Members: []MemberSpec{{Repo: "web"}, {Repo: "api"}}, Fetch: true}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("create with a busy branch: %v", err)
	}
	if out := gitCmd(t, web, "branch", "--list", "cf/busy"); out != "" {
		t.Fatalf("rollback left branch %q in web", out)
	}
	if _, err := os.Stat(filepath.Join(base, "worktrees", "_local", "web", "cf-busy")); !os.IsNotExist(err) {
		t.Fatalf("rollback left the web worktree: %v", err)
	}

	w, err := m.Create(ctx, CreateOptions{Name: "login", Members: []MemberSpec{{Repo: "web"}, {Repo: api}}, Fetch: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, mem := range w.Members {
		if got := gitCmd(t, mem.WorktreePath, "branch", "--show-current"); got != "cf/login" {
			t.Fatalf("%s is on %q", mem.WorktreePath, got)
		}
	}
	webWT, apiWT := w.Members[0].WorktreePath, w.Members[1].WorktreePath
	// web branches from origin/main without tracking it.
	if up, err := exec.Command("git", "-C", webWT, "rev-parse", "--abbrev-ref", "@{u}").Output(); err == nil {
		t.Fatalf("web worktree tracks %s", up)
	}
	ms, err := m.Members(ctx, Ref{Cwd: filepath.Join(apiWT, ".")})
	if err != nil || len(ms.Members) != 2 || !ms.Members[1].Current || ms.Members[1].RepoName != "api" || ms.Members[0].Missing {
		t.Fatalf("members = %+v, %v", ms, err)
	}

	// Remove api: refused while a thread runs there, then by git while dirty.
	threads = []Thread{{ID: "s-1", Cwd: apiWT}}
	if _, err := m.RemoveRepo(ctx, RemoveRepoOptions{Ref: Ref{Workspace: "login"}, Repo: "api"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("remove with a live thread: %v", err)
	}
	threads = nil
	if err := os.WriteFile(filepath.Join(apiWT, "wip.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RemoveRepo(ctx, RemoveRepoOptions{Ref: Ref{Workspace: "login"}, Repo: "api"}); !errors.Is(err, ErrFailedPrecondition) ||
		!strings.Contains(err.Error(), "--force") {
		t.Fatalf("remove dirty: %v", err)
	}
	// Remove of the whole workspace refuses before touching web.
	if err := m.Remove(ctx, RemoveOptions{Workspace: "login"}); err == nil || !strings.Contains(err.Error(), "uncommitted changes in api") {
		t.Fatalf("remove workspace with a dirty member: %v", err)
	}
	if _, err := os.Stat(webWT); err != nil {
		t.Fatalf("web worktree removed: %v", err)
	}
	if _, err := m.RemoveRepo(ctx, RemoveRepoOptions{Ref: Ref{Workspace: "login"}, Repo: "api", Force: true, DeleteBranch: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(apiWT); !os.IsNotExist(err) {
		t.Fatalf("api worktree still there: %v", err)
	}
	if out := gitCmd(t, api, "branch", "--list", "cf/login"); out != "" {
		t.Fatalf("branch not deleted: %q", out)
	}

	// Add it back: same branch name, new worktree.
	w, err = m.AddRepo(ctx, AddRepoOptions{Ref: Ref{Cwd: webWT}, Member: MemberSpec{Repo: "api"}, Fetch: true})
	if err != nil || len(w.Members) != 2 {
		t.Fatalf("add repo: %+v, %v", w, err)
	}
	if err := m.Remove(ctx, RemoveOptions{Workspace: w.ID}); err != nil {
		t.Fatal(err)
	}
	for _, mem := range w.Members {
		if _, err := os.Stat(mem.WorktreePath); !os.IsNotExist(err) {
			t.Fatalf("%s still there: %v", mem.WorktreePath, err)
		}
	}
	if len(m.Snapshot().Workspaces) != 0 {
		t.Fatalf("snapshot = %+v", m.Snapshot())
	}
}
