package daemon

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"syscall"
)

// ErrAlreadyRunning is returned by Run when another daemon holds the lock for the same
// config home.
var ErrAlreadyRunning = errors.New("another daemon is already running for this config home")

// instanceLock is an exclusive flock(2) on the lock file. The kernel releases it when the
// process exits, so a crashed daemon never leaves a stale lock behind.
type instanceLock struct{ f *os.File }

func acquireLock(path string) (*instanceLock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrAlreadyRunning
		}
		return nil, fmt.Errorf("flock %s: %w", path, err)
	}
	// Record the owner's pid for humans; correctness relies only on the flock.
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return &instanceLock{f: f}, nil
}

// release unlocks and closes. The file is left in place: unlinking a lock file after
// unlocking races with a new daemon that has already opened it.
func (l *instanceLock) release() error {
	if err := syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN); err != nil {
		_ = l.f.Close()
		return fmt.Errorf("unlock: %w", err)
	}
	return l.f.Close()
}
