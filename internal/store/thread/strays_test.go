package thread

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/procscan"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

func TestPickStrays(t *testing.T) {
	vite := procscan.Proc{PID: 7938, PPID: 1, PGID: 7918, Exe: "/opt/homebrew/bin/node"}
	sh := procscan.Proc{PID: 7920, PPID: 1, PGID: 7918, Exe: "/bin/sh"}
	server := procscan.Proc{PID: 8100, PPID: 1, PGID: 8100, Exe: "/usr/bin/python3"}
	code := procscan.Proc{PID: 9000, PPID: 1, PGID: 9000, Exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"}
	tests := []struct {
		name       string
		procs      []procscan.Proc
		wantPgids  []int
		wantSpared []int
	}{
		{name: "nothing", procs: nil},
		{name: "one server", procs: []procscan.Proc{server}, wantPgids: []int{8100}},
		{name: "one group once", procs: []procscan.Proc{vite, sh}, wantPgids: []int{7918}},
		{name: "an app bundle is spared", procs: []procscan.Proc{code}, wantSpared: []int{9000}},
		{name: "mixed", procs: []procscan.Proc{vite, code, server}, wantPgids: []int{7918, 8100}, wantSpared: []int{9000}},
		{name: "unknown executable is stopped", procs: []procscan.Proc{{PID: 5, PPID: 1, PGID: 5}}, wantPgids: []int{5}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pgids, stop, spared := pickStrays(tt.procs)
			if !slices.Equal(pgids, tt.wantPgids) {
				t.Errorf("pgids = %v, want %v", pgids, tt.wantPgids)
			}
			var sp []int
			for _, p := range spared {
				sp = append(sp, p.PID)
			}
			if !slices.Equal(sp, tt.wantSpared) {
				t.Errorf("spared = %v, want %v", sp, tt.wantSpared)
			}
			if len(stop)+len(spared) != len(tt.procs) {
				t.Errorf("stop %d + spared %d != %d", len(stop), len(spared), len(tt.procs))
			}
		})
	}
}

func TestStrayCandidate(t *testing.T) {
	since := time.Date(2026, 10, 21, 1, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		p    procscan.Proc
		want bool
	}{
		{"orphan started after the thread", procscan.Proc{PPID: 1, Start: since.Add(time.Minute)}, true},
		{"orphan started with the thread", procscan.Proc{PPID: 1, Start: since}, true},
		{"orphan older than the thread", procscan.Proc{PPID: 1, Start: since.Add(-time.Minute)}, false},
		{"someone's child", procscan.Proc{PPID: 4242, Start: since.Add(time.Minute)}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := strayCandidate(since)(tt.p); got != tt.want {
				t.Errorf("strayCandidate = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestStrayDir(t *testing.T) {
	const home = "/Users/u"
	archived := time.Date(2026, 10, 21, 1, 0, 0, 0, time.UTC)
	th := func(id, cwd string) Thread { return Thread{ID: id, WorktreePath: cwd} }
	const root = "/wt" // the daemon's worktree directory
	tests := []struct {
		name     string
		threads  []Thread
		want     string
		wantStop bool
	}{
		{"its worktree", []Thread{th("s1", "/wt/cf-a")}, "/wt/cf-a", true},
		{"a subdirectory of its worktree", []Thread{th("s1", "/wt/cf-a/web")}, "/wt/cf-a/web", true},
		{"a project checkout under home: only logged", []Thread{th("s1", home+"/src/app")}, home + "/src/app", false},
		{"a checkout beside the worktree directory: only logged", []Thread{th("s1", "/wt-other/app")}, "/wt-other/app", false},
		{"the worktree directory itself: only logged", []Thread{th("s1", "/wt")}, "/wt", false},
		{"no project: the home directory", []Thread{th("s1", home)}, "", false},
		{"above home", []Thread{th("s1", "/Users")}, "", false},
		{"no cwd", []Thread{th("s1", "")}, "", false},
		{"relative cwd", []Thread{th("s1", "wt")}, "", false},
		{"unknown thread", []Thread{th("s2", "/wt/cf-a")}, "", false},
		{"another live thread there", []Thread{th("s1", "/wt/cf-a"), th("s2", "/wt/cf-a")}, "", false},
		{"another live thread below", []Thread{th("s1", "/wt/cf-a"), th("s2", "/wt/cf-a/web")}, "", false},
		{"another live thread above", []Thread{th("s1", "/wt/cf-a/web"), th("s2", "/wt/cf-a")}, "", false},
		{"another archived thread there", []Thread{th("s1", "/wt/cf-a"), {ID: "s2", WorktreePath: "/wt/cf-a", ArchivedAt: archived}}, "/wt/cf-a", true},
		{"another thread being removed there", []Thread{th("s1", "/wt/cf-a"), {ID: "s2", WorktreePath: "/wt/cf-a", Removing: true}}, "/wt/cf-a", true},
		{"a sibling with a common prefix", []Thread{th("s1", "/wt/cf-a"), th("s2", "/wt/cf-a-2")}, "/wt/cf-a", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got, stop := strayDir(tt.threads, "s1", home, root); got != tt.want || stop != tt.wantStop {
				t.Errorf("strayDir = %q, %v; want %q, %v", got, stop, tt.want, tt.wantStop)
			}
		})
	}
	if _, stop := strayDir([]Thread{th("s1", "/wt/cf-a")}, "s1", home, ""); stop {
		t.Error("stops with no worktree directory configured")
	}
}

// startOrphan starts, in dir and in a process group of its own (as Claude Code's Bash
// tool does), a shell that leaves `sleep` running in the background and exits: the
// sleep is re-parented to launchd. It returns the sleep's pid.
func startOrphan(t *testing.T, dir string) int {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "(sleep 60 > /dev/null 2>&1 & echo $!)")
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("pid %q", out)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	waitPpid1(t, pid)
	return pid
}

// waitPpid1 waits until pid's parent is launchd.
func waitPpid1(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		procs, err := procscan.List()
		if err != nil {
			t.Fatal(err)
		}
		if i := slices.IndexFunc(procs, func(p procscan.Proc) bool { return p.PID == pid }); i >= 0 && procs[i].PPID == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid %d was not re-parented to launchd", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// running reports whether pid is alive (not a zombie launchd has yet to reap).
func running(pid int) bool {
	procs, err := procscan.List()
	if err != nil {
		return false
	}
	return slices.ContainsFunc(procs, func(p procscan.Proc) bool { return p.PID == pid })
}

func waitGone(t *testing.T, pid int, what string) {
	t.Helper()
	deadline := time.Now().Add(StrayGrace + 5*time.Second)
	for running(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("%s (pid %d) is still running", what, pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestArchiveAndRemoveStopStrays: a server a thread's Bash call left in the background
// in a worktree Code Foundry made dies with the thread's archive or removal. One in a
// project's own checkout stays (only logged), and so do one elsewhere, a child of a
// live process in the worktree, and the strays of a worktree another live thread
// shares.
func TestArchiveAndRemoveStopStrays(t *testing.T) {
	archive := func(e *env, id string) error { _, err := e.m.Archive(e.ctx(), id, true); return err }
	tests := []struct {
		name string
		// end archives or removes the thread.
		end func(e *env, id string) error
		// checkout: the thread works in the project's own checkout, not a new worktree.
		checkout bool
		// shared: a second, live thread works in the same worktree.
		shared   bool
		wantGone bool
	}{
		{name: "archive", end: archive, wantGone: true},
		{name: "remove", end: func(e *env, id string) error { return e.m.Remove(e.ctx(), id) }, wantGone: true},
		{name: "archive in the project's checkout", end: archive, checkout: true},
		{name: "remove in the project's checkout", end: func(e *env, id string) error { return e.m.Remove(e.ctx(), id) }, checkout: true},
		{name: "archive, worktree shared with a live thread", end: archive, shared: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t, func(o *Options) { o.WorktreeRoot = o.Projects.(*projecttest.Fake).WorktreeRoot })
			e.namer = func(string) (string, error) { return "worker", nil }
			o := CreateOptions{Name: "worker", ProjectID: "r1", NewWorktree: &NewWorktree{}}
			if tt.checkout {
				o = CreateOptions{Name: "worker"}
			}
			s := e.connected(o)
			if tt.shared {
				e.connected(CreateOptions{Name: "neighbour", ProjectID: "r1", WorktreePath: s.WorktreePath})
			}
			if !tt.checkout && !project.InsideRoot(s.WorktreePath, e.projects.WorktreeRoot) {
				t.Fatalf("the thread's worktree %s is not under %s", s.WorktreePath, e.projects.WorktreeRoot)
			}
			elsewhere := filepath.Join(t.TempDir(), "elsewhere")
			if err := os.MkdirAll(elsewhere, 0o755); err != nil {
				t.Fatal(err)
			}
			stray := startOrphan(t, s.WorktreePath)
			other := startOrphan(t, elsewhere)
			child := exec.Command("sleep", "60") // the test's own child: not an orphan
			child.Dir = s.WorktreePath
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })

			if err := tt.end(e, s.ID); err != nil {
				t.Fatal(err)
			}
			if tt.wantGone {
				waitGone(t, stray, "the stray in the worktree")
			} else {
				time.Sleep(StrayGrace + 500*time.Millisecond) // past a SIGKILL that should not come
				if !running(stray) {
					t.Error("the stray was stopped")
				}
			}
			if !running(other) {
				t.Error("a process in another directory was stopped")
			}
			if !running(child.Process.Pid) {
				t.Error("a live process's child in the worktree was stopped")
			}
		})
	}
}
