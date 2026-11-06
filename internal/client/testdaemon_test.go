package client

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

const (
	// envTestDaemon makes the test binary run as a daemon. Its value is the pid of the
	// test process spawning it, which the daemon does not outlive.
	envTestDaemon = "CF_TEST_DAEMON"
	// argDaemonParent makes the test binary stand in for a test run that spawns a
	// daemon and then ends: `client.test daemon-parent <home> <daemon binary> <start timeout>`.
	argDaemonParent = "daemon-parent"

	testHomeRoot   = "/tmp"
	testHomePrefix = "cf-"

	// parentPoll is how often a test daemon checks that its test process is alive.
	parentPoll = 100 * time.Millisecond
	// orphanGrace is how long an orphaned test daemon gets to shut down by itself.
	orphanGrace = 10 * time.Second
)

// testHomes lists every home shortHome made, for removeTestHomes. Nothing in this
// package runs in parallel.
var testHomes []string

// removeTestHomes removes the homes of a finished run again: a daemon still starting
// when its test gave up recreates its home after the test's cleanup removed it, and may
// then exit by itself. A daemon still running does this in runTestDaemon instead.
func removeTestHomes() {
	for _, h := range testHomes {
		_ = os.RemoveAll(h)
	}
}

// spawnsTestDaemon lets Connect spawn this test binary as a daemon that goes when this
// process goes.
func spawnsTestDaemon(t *testing.T) {
	t.Helper()
	t.Setenv(envTestDaemon, strconv.Itoa(os.Getpid()))
}

// isTestHome reports whether home is one shortHome made: the only kind a test daemon
// may serve, because it deletes the home when orphaned.
func isTestHome(home string) bool {
	return filepath.Dir(home) == testHomeRoot && strings.HasPrefix(filepath.Base(home), testHomePrefix)
}

// runTestDaemon is `code-foundry daemon` for the tests, spawned by process parent. It
// stops when parent is gone, however it went, and takes its home with it. Connect
// detaches the daemons it spawns on purpose and only a test that got an answer knows
// the pid, so a test that gives up, panics, times out or is killed cannot stop one.
func runTestDaemon(parent int) int {
	var wait time.Duration
	if len(os.Args) == 4 && os.Args[2] == FlagWaitLock {
		wait, _ = time.ParseDuration(os.Args[3])
	}
	p, err := paths.Resolve()
	if err == nil && !isTestHome(p.Home()) {
		err = fmt.Errorf("test daemon refuses home %s", p.Home())
	}
	if err != nil {
		_, _ = os.Stderr.WriteString("code-foundry: " + err.Error() + "\n")
		return 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for os.Getppid() == parent {
			time.Sleep(parentPoll)
		}
		cancel()
		time.Sleep(orphanGrace) // a start or a shutdown that hangs
		_ = os.RemoveAll(p.Home())
		os.Exit(1)
	}()
	err = daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}, LockWait: wait})
	if os.Getppid() != parent {
		_ = os.RemoveAll(p.Home())
		return 0
	}
	if err != nil {
		_, _ = os.Stderr.WriteString("code-foundry: " + err.Error() + "\n")
		if errors.Is(err, daemon.ErrAlreadyRunning) {
			return ExitLockHeld
		}
		return 1
	}
	return 0
}

// runDaemonParent is a test run in miniature. When Connect fails it removes the home,
// as shortHome's cleanup does, and exits; when Connect answers it waits to be killed.
func runDaemonParent(args []string) int {
	if len(args) != 3 {
		return 2
	}
	home, bin := args[0], args[1]
	start, err := time.ParseDuration(args[2])
	if err != nil {
		return 2
	}
	if err := os.Setenv(envTestDaemon, strconv.Itoa(os.Getpid())); err != nil {
		return 2
	}
	_, err = Connect(context.Background(), paths.New(home), ConnectOptions{DaemonBinary: bin, StartTimeout: start})
	if err != nil {
		_ = os.RemoveAll(home)
		fmt.Println("gave up")
		return 1
	}
	fmt.Println("ready")
	select {}
}

// A daemon must not outlive the test run that spawned it. Five once sat idle for days:
// Connect timed out under load, so the test failed before it knew the pid, and its
// cleanup deleted the home of a daemon that then recreated it and came up.
func TestSpawnedDaemonGoesWithTheTestRun(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a daemon process")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		start time.Duration // Connect's StartTimeout
		want  string        // what the run reports before it ends
	}{
		{name: "Connect gave up while it started", start: 50 * time.Millisecond, want: "gave up\n"},
		{name: "run killed with the daemon up", start: 30 * time.Second, want: "ready\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := shortHome(t)
			dir := t.TempDir()
			// Records the pid (exec keeps it) even if the run ends without learning it.
			pidFile := filepath.Join(dir, "pid")
			bin := filepath.Join(dir, "daemon")
			writeFile(t, bin, fmt.Sprintf("#!/bin/sh\necho $$ > %q\nexec %q \"$@\"\n", pidFile, exe))
			if err := os.Chmod(bin, 0o700); err != nil {
				t.Fatal(err)
			}

			run := exec.Command(exe, argDaemonParent, p.Home(), bin, tt.start.String())
			out, err := run.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := run.Start(); err != nil {
				t.Fatal(err)
			}
			line, _ := bufio.NewReader(out).ReadString('\n')
			_ = run.Process.Kill() // kill -9: no cleanup of any kind runs
			_ = run.Wait()
			if line != tt.want {
				t.Fatalf("run reported %q, want %q", line, tt.want)
			}

			pid := waitForPID(t, pidFile)
			deadline := time.Now().Add(orphanGrace + 10*time.Second)
			for !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
				if time.Now().After(deadline) {
					_ = syscall.Kill(pid, syscall.SIGKILL) // this test's own daemon
					t.Fatalf("daemon %d outlived its test run", pid)
				}
				time.Sleep(20 * time.Millisecond)
			}
			if _, err := os.Stat(p.Home()); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("home %s outlived the daemon (err %v)", p.Home(), err)
			}
		})
	}
}

func waitForPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, err := os.ReadFile(path)
		if pid, perr := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && perr == nil {
			return pid
		}
		if time.Now().After(deadline) {
			t.Fatalf("no daemon pid in %s: %v", path, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestIsTestHome(t *testing.T) {
	tests := []struct {
		home string
		want bool
	}{
		{"/tmp/cf-123", true},
		{"/tmp/cf-123/nested", false},
		{"/tmp/other", false},
		{"/Users/someone/.code-foundry", false},
		{"/var/tmp/cf-123", false},
	}
	for _, tt := range tests {
		if got := isTestHome(tt.home); got != tt.want {
			t.Errorf("isTestHome(%q) = %v, want %v", tt.home, got, tt.want)
		}
	}
}
