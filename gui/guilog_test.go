package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestRedirectStderrKeepsWhatWasThere(t *testing.T) {
	keep, err := syscallDup(t)
	if err != nil {
		t.Fatal(err)
	}
	defer restoreStderr(t, keep)
	path := filepath.Join(t.TempDir(), "logs", "gui.log")
	if err := redirectStderr(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stderr.WriteString("first\n"); err != nil {
		t.Fatal(err)
	}
	if err := redirectStderr(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stderr.WriteString("second\n"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Fields(string(b)); len(got) != 2 || got[0] != "first" || got[1] != "second" {
		t.Errorf("log %q", b)
	}
}

func TestRedirectStderrStartsAgainWhenLarge(t *testing.T) {
	keep, err := syscallDup(t)
	if err != nil {
		t.Fatal(err)
	}
	defer restoreStderr(t, keep)
	path := filepath.Join(t.TempDir(), "gui.log")
	if err := os.WriteFile(path, make([]byte, guiLogMost+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := redirectStderr(path); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != 0 {
		t.Errorf("size %d, want a new log", fi.Size())
	}
}

func syscallDup(t *testing.T) (int, error) {
	t.Helper()
	return syscall.Dup(int(os.Stderr.Fd()))
}

func restoreStderr(t *testing.T, fd int) {
	t.Helper()
	if err := syscall.Dup2(fd, int(os.Stderr.Fd())); err != nil {
		t.Error(err)
	}
	_ = syscall.Close(fd)
}
