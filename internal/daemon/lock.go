package daemon

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ErrAlreadyRunning is returned by Run when another daemon holds the lock for the same
// config home.
var ErrAlreadyRunning = errors.New("another daemon is already running for this config home")

// lockRetry is how often a waiting daemon tries the lock again.
const lockRetry = 50 * time.Millisecond

// instanceLock is an exclusive flock(2) on the lock file. The kernel releases it when the
// process exits, so a crashed daemon never leaves a stale lock behind.
type instanceLock struct{ f *os.File }

// lockWait is what acquireLock waited for: whether the lock was busy at first, for how
// long, and the holder's pid.
type lockWait struct {
	busy   bool
	waited time.Duration
	holder int
}

// acquireLock takes the lock at path. With wait > 0 (an auto-started daemon) a busy
// lock is retried for up to wait while no daemon answers on socket: the previous
// daemon removes its socket before it closes its stores and lets go of the lock, so a
// client that finds no socket during that window starts the next daemon early. A
// holder that does answer (it won a start race, or it is hung but still accepting)
// fails at once, as without wait.
func acquireLock(ctx context.Context, path, socket string, wait time.Duration) (*instanceLock, lockWait, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, lockWait{}, fmt.Errorf("open lock %s: %w", path, err)
	}
	start := time.Now()
	var w lockWait
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			_ = f.Close()
			return nil, lockWait{}, fmt.Errorf("flock %s: %w", path, err)
		}
		w = lockWait{busy: true, waited: time.Since(start), holder: lockHolder(f)}
		if wait <= 0 || socketAnswers(socket) {
			_ = f.Close()
			return nil, w, ErrAlreadyRunning
		}
		if w.waited >= wait {
			_ = f.Close()
			return nil, w, fmt.Errorf("%w: %s is still held by pid %d after %s and no daemon answers (the previous daemon is still shutting down, or hung)",
				ErrAlreadyRunning, path, w.holder, w.waited.Round(time.Millisecond))
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, lockWait{}, ctx.Err()
		case <-time.After(lockRetry):
		}
	}
	if w.busy {
		w.waited = time.Since(start)
	}
	// Record the owner's pid for humans; correctness relies only on the flock.
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return &instanceLock{f: f}, w, nil
}

// lockHolder is the pid the lock file records (0 when unreadable).
func lockHolder(f *os.File) int {
	b := make([]byte, 32)
	n, _ := f.ReadAt(b, 0)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b[:n])))
	return pid
}

// socketAnswers reports whether something accepts connections on the daemon socket.
func socketAnswers(socket string) bool {
	c, err := net.DialTimeout("unix", socket, 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
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
