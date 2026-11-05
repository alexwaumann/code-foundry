// Package fsxtest holds helpers for testing reads against a folder someone else can write
// to, as anything on the machine can write to a temp folder.
package fsxtest

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// Maker puts something at name.
type Maker func(name string) error

// File makes a regular file holding s.
func File(s string) Maker {
	return func(name string) error { return os.WriteFile(name, []byte(s), 0o644) }
}

// Link makes a symlink to target.
func Link(target string) Maker {
	return func(name string) error { return os.Symlink(target, name) }
}

// FIFO makes a named pipe, whose open blocks until someone writes to it.
func FIFO() Maker {
	return func(name string) error { return syscall.Mkfifo(name, 0o644) }
}

// Dir makes a folder holding a file called file with contents s.
func Dir(file, s string) Maker {
	return func(name string) error {
		if err := os.Mkdir(name, 0o755); err != nil {
			return err
		}
		return os.WriteFile(name+"/"+file, []byte(s), 0o644)
	}
}

// Flip replaces what is at path with each of makes in turn, as fast as it can, until the
// test ends. It makes each one beside path and renames it there, so the name is rarely
// missing: a rename only fails between a folder and something else.
func Flip(t testing.TB, path string, makes ...Maker) {
	t.Helper()
	stop, done := make(chan struct{}), make(chan struct{})
	staged := path + ".flip"
	go func() {
		defer close(done)
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if err := makes[i%len(makes)](staged); err != nil {
				t.Errorf("flip: %v", err)
				return
			}
			if os.Rename(staged, path) == nil {
				continue
			}
			if err := os.RemoveAll(path); err != nil {
				t.Errorf("flip: %v", err)
				return
			}
			if err := os.Rename(staged, path); err != nil {
				t.Errorf("flip: %v", err)
				return
			}
		}
	}()
	t.Cleanup(func() {
		close(stop)
		<-done
	})
}

// Bounds of Hammer. Reads win a flip within a few dozen tries, so these leave room, and a
// machine under load only makes fewer tries: it can miss a bug, not fail a good build. They
// stay short because a flip is a stream of file events, which the system shares with every
// FSEvents test running beside this one.
const (
	hammerTries = 1000
	hammerTime  = 150 * time.Millisecond
	hammerHang  = 30 * time.Second
)

// Hammer calls try over and over for a moment, and fails the test if a call hangs. try runs
// on another goroutine, so it reports with t.Errorf.
func Hammer(t testing.TB, try func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		end := time.Now().Add(hammerTime)
		for i := 0; i < hammerTries && time.Now().Before(end); i++ {
			try()
		}
	}()
	select {
	case <-done:
	case <-time.After(hammerHang):
		t.Fatal("a read hung")
	}
}
