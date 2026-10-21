package procscan

import (
	"context"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
	"time"
)

func TestParseLsof(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want map[int]string
	}{
		{"empty", "", map[int]string{}},
		{"two processes", "p7938\nfcwd\nn/wt/cf-a\np8100\nfcwd\nn/wt/cf-a/web\n", map[int]string{7938: "/wt/cf-a", 8100: "/wt/cf-a/web"}},
		{"a path with spaces", "p1\nfcwd\nn/Users/u/My Projects/app\n", map[int]string{1: "/Users/u/My Projects/app"}},
		{"a name before any pid", "n/x\np2\nn/y\n", map[int]string{2: "/y"}},
		{"blank lines", "\np3\n\nn/z\n", map[int]string{3: "/z"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseLsof([]byte(tt.out)); !maps.Equal(got, tt.want) {
				t.Errorf("parseLsof = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestInside(t *testing.T) {
	tests := []struct {
		p, root string
		want    bool
	}{
		{"/wt/cf-a", "/wt/cf-a", true},
		{"/wt/cf-a/web", "/wt/cf-a", true},
		{"/wt/cf-a/web", "/wt/cf-a/", true},
		{"/wt/cf-a-2", "/wt/cf-a", false},
		{"/wt", "/wt/cf-a", false},
		{"", "/wt", false},
		{"/wt", "", false},
	}
	for _, tt := range tests {
		if got := Inside(tt.p, tt.root); got != tt.want {
			t.Errorf("Inside(%q, %q) = %v, want %v", tt.p, tt.root, got, tt.want)
		}
	}
}

// In finds a process by its working directory, with its executable; StopGroups ends its
// group.
func TestInAndStopGroups(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir()) // /var is /private/var
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/sleep", "60")
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	pid := cmd.Process.Pid
	mine := func(p Proc) bool { return p.PID == pid || p.PPID == os.Getpid() }

	other := t.TempDir()
	if got, err := In(context.Background(), other, mine); err != nil || len(got) != 0 {
		t.Fatalf("In(another dir) = %+v, %v", got, err)
	}
	got, err := In(context.Background(), filepath.Dir(dir), mine) // a parent of its cwd
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(got, func(p Proc) bool { return p.PID == pid })
	if i < 0 {
		t.Fatalf("In = %+v, want pid %d", got, pid)
	}
	if p := got[i]; p.PGID != pid || p.Exe != "/bin/sleep" || p.Name() != "sleep" || !Inside(p.Cwd, filepath.Dir(dir)) || p.Start.IsZero() {
		t.Errorf("proc = %+v", p)
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	StopGroups(context.Background(), []int{pid, 0, 1, syscall.Getpgrp()}, time.Second)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the group was not stopped")
	}
	if cmd.ProcessState.Sys().(syscall.WaitStatus).Signal() != syscall.SIGTERM {
		t.Errorf("ended by %v, want SIGTERM", cmd.ProcessState)
	}
}
