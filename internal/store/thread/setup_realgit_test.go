package thread

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// realRepo is a project with real git behind a thread env: what a fake cannot show is
// what a killed git leaves on disk.
type realRepo struct {
	t          *testing.T
	store      *project.Git
	id, path   string
	root       string // the worktree root
	originPath string
}

func (r *realRepo) git(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.path
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// worktrees are the paths git lists, the main checkout first.
func (r *realRepo) worktrees() []string {
	r.t.Helper()
	var out []string
	for line := range strings.Lines(r.git("worktree", "list", "--porcelain")) {
		if p, ok := strings.CutPrefix(strings.TrimSpace(line), "worktree "); ok {
			out = append(out, p)
		}
	}
	return out
}

// clean fails unless only the main checkout and branch main are left, on disk too.
func (r *realRepo) clean() {
	r.t.Helper()
	if got := r.worktrees(); len(got) != 1 {
		r.t.Errorf("worktrees: %q", got)
	}
	if got := r.git("branch", "--format=%(refname:short)"); got != "main" {
		r.t.Errorf("branches: %q", got)
	}
	var left []string
	_ = filepath.WalkDir(r.root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			left = append(left, p)
		}
		return nil
	})
	if len(left) > 0 {
		r.t.Errorf("left on disk: %q", left)
	}
}

// newRealGit is a thread env with one registered project, r.id, whose origin is a bare
// repository.
func newRealGit(t *testing.T, mutate ...func(*Options)) (*env, *realRepo) {
	t.Helper()
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
	r := &realRepo{t: t, path: filepath.Join(base, "proj"), root: filepath.Join(base, "worktrees"), originPath: filepath.Join(base, "origin.git")}
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", r.originPath).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if out, err := exec.Command("git", "init", "-q", "-b", "main", r.path).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if err := os.WriteFile(filepath.Join(r.path, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.git("add", ".")
	r.git("commit", "-q", "-m", "init")
	r.git("remote", "add", "origin", r.originPath)
	r.git("push", "-q", "-u", "origin", "main")
	r.git("remote", "set-head", "origin", "main")
	d, err := db.Open(context.Background(), dbtest.Path(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r.store, err = project.Start(context.Background(), project.Options{DB: d, Bus: bus.New(), WorktreeRoot: r.root, AllowedRoot: base,
		FetchInterval: -1, PollInterval: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.store.Close() })
	p, err := r.store.Register(context.Background(), r.path)
	if err != nil {
		t.Fatal(err)
	}
	r.id = p.ID
	e := newEnv(t, append([]func(*Options){func(o *Options) {
		o.Projects = r.store
		o.SlugTimeout = 300 * time.Millisecond
	}}, mutate...)...)
	return e, r
}

// waitPidIn waits for a pid in the file.
func waitPidIn(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no pid in %s", path)
	return 0
}

func waitProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("process %d outlived the cancel", pid)
}

// A cancel during a real `git worktree add`, half way through its checkout: git is
// killed, and neither the directory, its entry nor the new branch stays. Try again works.
func TestCancelKillsARealWorktreeAdd(t *testing.T) {
	e, r := newRealGit(t)
	pidFile := filepath.Join(t.TempDir(), "smudge.pid")
	if err := os.WriteFile(filepath.Join(r.path, ".gitattributes"), []byte("slow.txt filter=slow\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.path, "slow.txt"), []byte("slow\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.git("add", ".")
	r.git("commit", "-q", "-m", "slow")
	r.git("push", "-q", "origin", "main")
	r.git("config", "filter.slow.smudge", "sh -c 'echo $$ > "+pidFile+"; sleep 60; cat'")

	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "cf/real"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	pid := waitPidIn(t, pidFile)
	if got := r.git("worktree", "list", "--porcelain"); !strings.Contains(got, "locked") {
		t.Fatalf("not half way:\n%s", got)
	}
	got, kept, err := e.m.CancelSetup(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Setup.Phase != SetupCancelled || got.Setup.Made != nil || got.Setup.Adding != nil || len(kept) != 0 {
		t.Errorf("setup %+v, kept %q", got.Setup, kept)
	}
	waitProcessGone(t, pid)
	r.clean()

	r.git("config", "--unset", "filter.slow.smudge")
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.Branch != "cf/real" || !isDir(done.WorktreePath) {
		t.Errorf("placed on %q at %q", done.Branch, done.WorktreePath)
	}
	if got := r.worktrees(); len(got) != 2 {
		t.Errorf("worktrees %q", got)
	}
	e.waitUserText("do x")
}

// A cancel during a real fetch from a remote that never answers: the fetch goes, with what
// it started, at once.
func TestCancelKillsARealFetch(t *testing.T) {
	e, r := newRealGit(t)
	pidFile := filepath.Join(t.TempDir(), "remote.pid")
	script := filepath.Join(t.TempDir(), "remote.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho $$ > "+pidFile+"\nsleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.git("config", "protocol.ext.allow", "always")
	r.git("remote", "set-url", "origin", "ext::"+script)
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	pid := waitPidIn(t, pidFile)
	start := time.Now()
	if _, _, err := e.m.CancelSetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("the cancel took %v", took)
	}
	waitProcessGone(t, pid)
	r.clean()
}

// What a failed start left behind: anyone can work in a worktree once the placement landed.
// So a cleanup asks git, without force, and work stays with its branch; a clean worktree
// goes, and a branch with commits outlives it.
func TestCleanupOfARealWorktree(t *testing.T) {
	ends := []struct {
		name string
		end  func(t *testing.T, e *env, id string) []string
	}{
		{"discard", func(t *testing.T, e *env, id string) []string {
			d, err := e.m.DiscardSetup(e.ctx(), id)
			if err != nil {
				t.Fatal(err)
			}
			return d.Kept
		}},
		{"remove", func(t *testing.T, e *env, id string) []string {
			if err := e.m.Remove(e.ctx(), id); err != nil {
				t.Fatal(err)
			}
			return nil
		}},
	}
	works := []struct {
		name                     string
		work                     func(r *realRepo, path string)
		wantWorktree, wantBranch bool
	}{
		{name: "untouched"},
		{name: "an untracked file", wantWorktree: true, wantBranch: true, work: func(r *realRepo, path string) {
			if err := os.WriteFile(filepath.Join(path, "note.txt"), []byte("mine\n"), 0o644); err != nil {
				r.t.Fatal(err)
			}
		}},
		{name: "a changed file", wantWorktree: true, wantBranch: true, work: func(r *realRepo, path string) {
			if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("mine\n"), 0o644); err != nil {
				r.t.Fatal(err)
			}
		}},
		{name: "a commit", wantBranch: true, work: func(r *realRepo, path string) {
			if err := os.WriteFile(filepath.Join(path, "c.txt"), []byte("mine\n"), 0o644); err != nil {
				r.t.Fatal(err)
			}
			for _, args := range [][]string{{"add", "."}, {"commit", "-q", "-m", "mine"}} {
				if out, err := exec.Command("git", append([]string{"-C", path}, args...)...).CombinedOutput(); err != nil {
					r.t.Fatalf("%v\n%s", err, out)
				}
			}
		}},
	}
	for _, end := range ends {
		for _, w := range works {
			t.Run(end.name+" with "+w.name, func(t *testing.T) {
				e, r := newRealGit(t, func(o *Options) { o.Claude = "/nonexistent/claude" })
				s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "cf/mine"}, BackgroundSetup: true})
				if err != nil {
					t.Fatal(err)
				}
				s = e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
				if !isDir(s.WorktreePath) {
					t.Fatalf("no worktree: %+v", s.Setup)
				}
				if w.work != nil {
					w.work(r, s.WorktreePath)
				}
				kept := end.end(t, e, s.ID)
				if got := isDir(s.WorktreePath); got != w.wantWorktree {
					t.Errorf("worktree there = %v, want %v", got, w.wantWorktree)
				}
				if got := strings.Contains(r.git("branch", "--list", "cf/mine"), "cf/mine"); got != w.wantBranch {
					t.Errorf("branch there = %v, want %v", got, w.wantBranch)
				}
				if end.name == "discard" && w.wantWorktree != slices.Contains(kept, s.WorktreePath) {
					t.Errorf("kept %q", kept)
				}
			})
		}
	}
}

// A setup that made a local branch of origin's goes back to not having it: it was this
// setup's, while origin's stays.
func TestCleanupTakesALocalBranchOfOrigins(t *testing.T) {
	e, r := newRealGit(t, func(o *Options) { o.Claude = "/nonexistent/claude" })
	r.git("branch", "feature")
	r.git("push", "-q", "origin", "feature")
	r.git("branch", "-D", "feature")
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "feature"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if _, err := e.m.DiscardSetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	r.clean()
	if got := r.git("branch", "-r", "--list", "origin/feature"); got == "" {
		t.Error("origin's branch went")
	}
}

// Work left in a worktree after a failed start is there when the setup is tried again: the
// placement stands, and nothing touches it.
func TestRetryAfterAFailedStartKeepsTheWorktree(t *testing.T) {
	e, r := newRealGit(t, func(o *Options) { o.Claude = "/nonexistent/claude" })
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "cf/mine"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	s = e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	note := filepath.Join(s.WorktreePath, "note.txt")
	if err := os.WriteFile(note, []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.m.opts.Claude = fakeClaudeBin
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase == SetupDone })
	if done.WorktreePath != s.WorktreePath {
		t.Errorf("cwd %q, was %q", done.WorktreePath, s.WorktreePath)
	}
	if _, err := os.Stat(note); err != nil {
		t.Errorf("the note went: %v", err)
	}
}
