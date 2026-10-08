package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// startPTY starts cmd on a new PTY of the given size and returns the master.
//
// The master is made non-blocking and wrapped in a fresh *os.File so it is registered
// with Go's poller. That makes Close interrupt a blocked Read (needed when a background
// process keeps the slave open after the main process exits) and keeps reads from
// tying up OS threads. creack/pty opens /dev/ptmx in blocking mode, and its Setsize
// calls File.Fd(), which would switch the file back to blocking, so resize goes through
// setWinsize below instead.
func startPTY(cmd *exec.Cmd, cols, rows uint16) (*os.File, error) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		return nil, fmt.Errorf("open pty: %w", err)
	}
	defer func() { _ = tty.Close() }()

	if err := pty.Setsize(tty, &pty.Winsize{Cols: cols, Rows: rows}); err != nil {
		_ = ptmx.Close()
		return nil, fmt.Errorf("set pty size: %w", err)
	}
	master, err := pollable(ptmx)
	if err != nil {
		return nil, err
	}

	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	// New session with the PTY as controlling terminal (fd 0 in the child). The child is
	// the session and process-group leader, so Kill can signal the whole group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("start %s: %w", cmd.Path, err)
	}
	return master, nil
}

// pollable replaces f with a non-blocking, close-on-exec duplicate wrapped by
// os.NewFile, which registers non-blocking descriptors with the runtime poller. f is
// closed.
func pollable(f *os.File) (*os.File, error) {
	defer func() { _ = f.Close() }()
	var fd int
	var dupErr error
	rc, err := f.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("pty syscall conn: %w", err)
	}
	if err := rc.Control(func(old uintptr) {
		fd, dupErr = unix.FcntlInt(old, unix.F_DUPFD_CLOEXEC, 0)
	}); err != nil {
		return nil, fmt.Errorf("pty control: %w", err)
	}
	if dupErr != nil {
		return nil, fmt.Errorf("dup pty master: %w", dupErr)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("set pty master non-blocking: %w", err)
	}
	return os.NewFile(uintptr(fd), "/dev/ptmx"), nil
}

// setWinsize applies TIOCSWINSZ to the master without leaving non-blocking mode. The
// kernel delivers SIGWINCH to the foreground process group.
func setWinsize(f *os.File, cols, rows uint16) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return fmt.Errorf("pty syscall conn: %w", err)
	}
	var ioErr error
	if err := rc.Control(func(fd uintptr) {
		ioErr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
	}); err != nil {
		return fmt.Errorf("pty control: %w", err)
	}
	if ioErr != nil {
		return fmt.Errorf("TIOCSWINSZ: %w", ioErr)
	}
	return nil
}

// signalGroup sends sig to the process group led by pid, falling back to pid alone.
func signalGroup(pid int, sig syscall.Signal) error {
	err := syscall.Kill(-pid, sig)
	if errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.EPERM) {
		err = syscall.Kill(pid, sig)
	}
	if errors.Is(err, syscall.ESRCH) {
		return nil // already gone
	}
	return err
}

// exitCode maps a process state to a shell-style exit code: the exit status, or
// 128+signal when killed by a signal.
func exitCode(ps *os.ProcessState) int {
	if ps == nil {
		return -1
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return ps.ExitCode()
}
