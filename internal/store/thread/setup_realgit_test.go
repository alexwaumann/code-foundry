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
	"sync/atomic"
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
// it started, at once. A named branch has a fetch of its own, to ask origin about it.
func TestCancelKillsARealFetch(t *testing.T) {
	tests := []struct {
		name string
		wt   NewWorktree
	}{{"of the base", NewWorktree{}}, {"of a named branch", NewWorktree{Branch: "cf/named"}}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, r := newRealGit(t)
			pidFile := filepath.Join(t.TempDir(), "remote.pid")
			script := filepath.Join(t.TempDir(), "remote.sh")
			if err := os.WriteFile(script, []byte("#!/bin/sh\necho $$ > "+pidFile+"\nsleep 60\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			r.git("config", "protocol.ext.allow", "always")
			r.git("remote", "set-url", "origin", "ext::"+script)
			s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &tt.wt, BackgroundSetup: true})
			if err != nil {
				t.Fatal(err)
			}
			pid := waitPidIn(t, pidFile)
			start := time.Now()
			got, _, err := e.m.CancelSetup(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if took := time.Since(start); took > 3*time.Second { // the runner's WaitDelay bounds it
				t.Errorf("the cancel took %v", took)
			}
			waitProcessGone(t, pid)
			r.clean()
			if slices.ContainsFunc(got.Setup.Steps, func(st SetupStep) bool { return st.Status == SetupStepWarning }) {
				t.Errorf("a cancel reads as an unreachable remote: %+v", got.Setup.Steps)
			}
		})
	}
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

// The user fixes what stopped the setup, and tries again at once: the retry looks at the
// repository, not at what the project store last saw of it.
func TestRetrySeesWhatTheUserJustFixed(t *testing.T) {
	e, r := newRealGit(t)
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "main"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	s = e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if !strings.Contains(s.Setup.Error, "main checkout") {
		t.Fatalf("error %q", s.Setup.Error)
	}
	r.git("switch", "-q", "-c", "elsewhere")
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to end", func(s Thread) bool { return s.Setup.Phase != SetupRunning })
	if done.Setup.Phase != SetupDone || done.Branch != "main" {
		t.Errorf("setup %+v", done.Setup)
	}
}

// flakyGit is the real project store with a worktree add that fails on demand: a first run
// that fails after naming, with git as it is.
type flakyGit struct {
	*project.Git
	fail atomic.Bool
}

func (f *flakyGit) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	if f.fail.Load() {
		return project.Worktree{}, &project.GitError{Stderr: "fatal: not today\n", ExitCode: 128}
	}
	return f.Git.CreateWorktree(ctx, o)
}

// newFlakyGit is newRealGit with adds failing until healed.
func newFlakyGit(t *testing.T) (*env, *realRepo, *flakyGit) {
	t.Helper()
	var fg *flakyGit
	e, r := newRealGit(t, func(o *Options) {
		fg = &flakyGit{Git: o.Projects.(*project.Git)}
		fg.fail.Store(true)
		o.Projects = fg
	})
	return e, r, fg
}

// onOrigin puts branch on origin with a commit of its own, and nowhere here, not even as a
// remote-tracking ref: pushed from another clone. It returns the commit.
func (r *realRepo) onOrigin(branch string) string {
	r.t.Helper()
	r.git("switch", "-q", "-c", branch)
	if err := os.WriteFile(filepath.Join(r.path, "theirs.txt"), []byte("theirs\n"), 0o644); err != nil {
		r.t.Fatal(err)
	}
	r.git("add", ".")
	r.git("commit", "-q", "-m", "theirs")
	tip := r.git("rev-parse", "HEAD")
	r.git("push", "-q", "origin", branch)
	r.git("switch", "-q", "main")
	r.git("branch", "-q", "-D", branch)
	r.git("update-ref", "-d", "refs/remotes/origin/"+branch)
	return tip
}

// checkedOutOrigins fails unless branch is origin's commit, tracking it, in the worktree.
func (r *realRepo) checkedOutOrigins(s Thread, branch, tip string) {
	r.t.Helper()
	if s.Branch != branch {
		r.t.Errorf("branch %q", s.Branch)
	}
	if got := r.git("rev-parse", branch); got != tip {
		r.t.Errorf("%s is at %s, origin's at %s: made anew from the base", branch, got, tip)
	}
	if got := r.git("rev-parse", "--abbrev-ref", branch+"@{upstream}"); got != "origin/"+branch {
		r.t.Errorf("upstream %q", got)
	}
	if _, err := os.Stat(filepath.Join(s.WorktreePath, "theirs.txt")); err != nil {
		r.t.Errorf("origin's work is not there: %v", err)
	}
}

// A branch on origin only, with a base given: the first run saw it existed and dropped the
// base, and a retry must not forget that.
func TestRetryChecksOutOriginsBranch(t *testing.T) {
	e, r, fg := newFlakyGit(t)
	tip := r.onOrigin("feat/x")
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "feat/x", BaseRef: "main"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	s = e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if !s.Setup.step(SetupStepName, "").Existing {
		t.Fatalf("name step %+v", s.Setup.step(SetupStepName, ""))
	}
	fg.fail.Store(false)
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	r.checkedOutOrigins(e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase != SetupRunning }), "feat/x", tip)
}

// The same for a typed branch that appeared on origin after the first run: it is what a
// first run now would check out.
func TestRetryChecksOutATypedBranchThatAppeared(t *testing.T) {
	e, r, fg := newFlakyGit(t)
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{Branch: "feat/y", BaseRef: "main"}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	s = e.waitFor(s.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if s.Setup.step(SetupStepName, "").Existing {
		t.Fatalf("name step %+v", s.Setup.step(SetupStepName, ""))
	}
	tip := r.onOrigin("feat/y")
	fg.fail.Store(false)
	if _, err := e.m.RetrySetup(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(s.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase != SetupRunning })
	r.checkedOutOrigins(done, "feat/y", tip)
	if !done.Setup.step(SetupStepName, "").Existing {
		t.Errorf("name step %+v", done.Setup.step(SetupStepName, ""))
	}
}

// A fails after naming fix/login, an unrelated thread gets the same name and lands: Try
// again on A must not land in B's worktree.
func TestRetryDoesNotLandInAnUnrelatedThreadsWorktree(t *testing.T) {
	e, r, fg := newFlakyGit(t)
	e.namer = func(string) (string, error) { return "Title: Fix login\nBranch: fix/login", nil }
	a, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: r.id, InitialPrompt: "do x", NewWorktree: &NewWorktree{}, BackgroundSetup: true})
	if err != nil {
		t.Fatal(err)
	}
	a = e.waitFor(a.ID, "the setup to fail", func(s Thread) bool { return s.Setup.Phase == SetupFailed })
	if got := a.Setup.step(SetupStepName, "").Branch; got != "fix/login" {
		t.Fatalf("named %q", got)
	}
	fg.fail.Store(false)
	b := e.create(CreateOptions{ProjectID: r.id, InitialPrompt: "do y", NewWorktree: &NewWorktree{}})
	if b.Branch != "fix/login" {
		t.Fatalf("B on %q", b.Branch)
	}
	if _, err := e.m.RetrySetup(e.ctx(), a.ID); err != nil {
		t.Fatal(err)
	}
	done := e.waitFor(a.ID, "the retry to land", func(s Thread) bool { return s.Setup.Phase != SetupRunning })
	if done.Branch != "fix/login-2" || done.WorktreePath == b.WorktreePath {
		t.Errorf("A on %q at %q, B at %q", done.Branch, done.WorktreePath, b.WorktreePath)
	}
	for _, kind := range []SetupStepKind{SetupStepName, SetupStepWorktree} {
		pid := ""
		if kind == SetupStepWorktree {
			pid = r.id
		}
		if st := done.Setup.step(kind, pid); st == nil || st.Branch != "fix/login-2" {
			t.Errorf("step %+v", st)
		}
	}
	if got := r.worktrees(); len(got) != 3 {
		t.Errorf("worktrees %q", got)
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
