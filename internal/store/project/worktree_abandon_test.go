package project

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// slowCheckout makes checking out slow.txt hang in a smudge filter, which writes its pid to
// the file it returns first: a `git worktree add` that stops half way.
func slowCheckout(t *testing.T, f fixture) (pidFile string) {
	t.Helper()
	pidFile = filepath.Join(t.TempDir(), "smudge.pid")
	writeFile(t, filepath.Join(f.project, ".gitattributes"), "slow.txt filter=slow\n")
	writeFile(t, filepath.Join(f.project, "slow.txt"), "slow\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "a slow file")
	git(t, f.project, "push", "-q", "origin", "main")
	git(t, f.project, "config", "filter.slow.smudge", "sh -c 'echo $$ > "+pidFile+"; sleep 60; cat'")
	return pidFile
}

// waitPid waits for the file to hold a pid.
func waitPid(t *testing.T, path string) int {
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

// waitGone waits for process pid to be gone.
func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("process %d outlived its git", pid)
}

// nothingLeft fails unless no trace of a worktree at path on branch is on disk.
func nothingLeft(t *testing.T, f fixture, path, branch string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("%s is still there: %v", path, err)
	}
	if out := git(t, f.project, "worktree", "list", "--porcelain"); strings.Contains(out, path) {
		t.Errorf("git still lists it:\n%s", out)
	}
	if out := git(t, f.project, "branch", "--list", branch); out != "" {
		t.Errorf("branch stays: %s", out)
	}
}

// A cancelled `git worktree add` dies with what it started and leaves nothing: no
// directory, no entry, no branch. So the same add works at once.
func TestCreateWorktreeKilledLeavesNothing(t *testing.T) {
	f := newFixture(t)
	pidFile := slowCheckout(t, f)
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), f.project)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var path string
	errc := make(chan error, 1)
	go func() {
		_, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/killed", BaseRef: "main",
			Progress: func(ev WorktreeEvent) {
				if ev.Kind == WorktreeAdding {
					path = ev.Path
				}
			}})
		errc <- err
	}()
	pid := waitPid(t, pidFile)
	if out := git(t, f.project, "worktree", "list", "--porcelain"); !strings.Contains(out, "locked") {
		t.Fatalf("the add is not half way:\n%s", out)
	}
	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("CreateWorktree succeeded")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("CreateWorktree outlived its ctx")
	}
	waitGone(t, pid)
	nothingLeft(t, f, path, "cf/killed")

	git(t, f.project, "config", "--unset", "filter.slow.smudge")
	if _, err := h.store.CreateWorktree(context.Background(), CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/killed", BaseRef: "main"}); err != nil {
		t.Errorf("the same add again: %v", err)
	}
}

// lostAdd runs `git worktree add` to the middle of its checkout and kills it the way a
// daemon's death does, with nobody there to clean up. The env is the test's.
func lostAdd(t *testing.T, f fixture, pidFile, path, branch string) {
	t.Helper()
	cmd := exec.Command("git", "worktree", "add", "--no-track", "-b", branch, path, "main")
	cmd.Dir = f.project
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitPid(t, pidFile)
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	if err := os.Remove(pidFile); err != nil {
		t.Fatal(err)
	}
}

func TestAbandonWorktree(t *testing.T) {
	f := newFixture(t)
	pidFile := slowCheckout(t, f)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	head := git(t, f.project, "rev-parse", "main")
	path := h.store.DefaultWorktreePath(r.ID, "cf/lost")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("a killed add", func(t *testing.T) {
		lostAdd(t, f, pidFile, path, "cf/lost")
		if out := git(t, f.project, "worktree", "list", "--porcelain"); !strings.Contains(out, path) || !strings.Contains(out, "locked") {
			t.Fatalf("the add left no locked entry:\n%s", out)
		}
		if err := h.store.AbandonWorktree(ctx, AbandonWorktreeOptions{ProjectID: r.ID, Path: path, Branch: "cf/lost", Head: strings.TrimSpace(head)}); err != nil {
			t.Fatal(err)
		}
		nothingLeft(t, f, path, "cf/lost")
	})

	t.Run("a branch someone moved stays", func(t *testing.T) {
		lostAdd(t, f, pidFile, path, "cf/lost")
		if err := h.store.AbandonWorktree(ctx, AbandonWorktreeOptions{ProjectID: r.ID, Path: path, Branch: "cf/lost", Head: "0000000000000000000000000000000000000000"}); err != nil {
			t.Fatal(err)
		}
		if out := git(t, f.project, "branch", "--list", "cf/lost"); out == "" {
			t.Error("the branch went")
		}
		git(t, f.project, "branch", "-D", "cf/lost")
	})

	git(t, f.project, "config", "--unset", "filter.slow.smudge")
	t.Run("a whole worktree with work in it stays", func(t *testing.T) {
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/whole", BaseRef: "main"})
		if err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(w.Path, "work.txt"), "work\n")
		if err := h.store.AbandonWorktree(ctx, AbandonWorktreeOptions{ProjectID: r.ID, Path: w.Path, Branch: "cf/whole", Head: strings.TrimSpace(head)}); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(w.Path, "work.txt")); err != nil {
			t.Errorf("the work went: %v", err)
		}
		if out := git(t, f.project, "branch", "--list", "cf/whole"); out == "" {
			t.Error("the branch went")
		}
	})

	t.Run("outside the worktree root", func(t *testing.T) {
		dir := t.TempDir()
		err := h.store.AbandonWorktree(ctx, AbandonWorktreeOptions{ProjectID: r.ID, Path: dir})
		if !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("AbandonWorktree = %v", err)
		}
		if _, err := os.Stat(dir); err != nil {
			t.Errorf("it took %s: %v", dir, err)
		}
	})
}

// DeleteMadeBranch: the branch goes with its worktree while nobody committed to it. A
// worktree with changes stays, and so does its branch.
func TestRemoveWorktreeDeleteMadeBranch(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	// A base no default branch has: an unmerged branch all the same.
	git(t, f.project, "branch", "base")
	writeFile(t, filepath.Join(f.project, "base.txt"), "base\n")
	git(t, f.project, "switch", "-q", "base")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "base work")
	git(t, f.project, "switch", "-q", "main")
	cases := []struct {
		name                 string
		work                 func(t *testing.T, path string)
		wantErr, branchStays bool
	}{
		{name: "untouched"},
		{name: "committed to", branchStays: true, work: func(t *testing.T, path string) {
			writeFile(t, filepath.Join(path, "w.txt"), "w\n")
			git(t, path, "add", ".")
			git(t, path, "commit", "-q", "-m", "work")
		}},
		{name: "with an untracked file", wantErr: true, branchStays: true, work: func(t *testing.T, path string) {
			writeFile(t, filepath.Join(path, "w.txt"), "w\n")
		}},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			branch := "cf/made-" + strconv.Itoa(i)
			w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: branch, BaseRef: "base"})
			if err != nil {
				t.Fatal(err)
			}
			if c.work != nil {
				c.work(t, w.Path)
			}
			err = h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path, DeleteMadeBranch: branch})
			var dirty *UncommittedError
			if c.wantErr != errors.As(err, &dirty) {
				t.Fatalf("RemoveWorktree = %v", err)
			}
			if !c.wantErr && err != nil {
				t.Fatalf("RemoveWorktree = %v", err)
			}
			if _, err := os.Stat(w.Path); c.wantErr != (err == nil) {
				t.Errorf("worktree: %v", err)
			}
			if got := git(t, f.project, "branch", "--list", branch) != ""; got != c.branchStays {
				t.Errorf("branch stays = %v, want %v", got, c.branchStays)
			}
		})
	}
}

// A cancelled command takes its children with it.
func TestRunnerKillsTheWholeGroup(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	script := filepath.Join(dir, "fake-git")
	writeFile(t, script, "#!/bin/sh\nsh -c 'echo $$ > "+pidFile+"; sleep 60' &\nwait\n")
	if err := os.Chmod(script, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errc := make(chan error, 1)
	go func() {
		_, err := ExecRunner{Git: script}.Run(ctx, dir, "fetch")
		errc <- err
	}()
	pid := waitPid(t, pidFile)
	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("Run succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run outlived its ctx")
	}
	waitGone(t, pid)
}
