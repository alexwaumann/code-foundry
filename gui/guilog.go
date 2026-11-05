package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
)

// guiLogMost is how large the GUI's log may start: past it, it starts again. A second launch
// only appends a few lines before it hands over to the first, so there is no rotation to race.
const guiLogMost = 5 << 20

// keepStderr sends this process's stderr to path, unless a terminal is reading it. It works on
// the descriptor, not on os.Stderr, so the Go runtime's crash output lands there too.
func keepStderr(path string, log *slog.Logger) {
	if stderrIsTerminal() {
		return
	}
	if err := redirectStderr(path); err != nil {
		log.Warn("keep the GUI's log", "path", path, "err", err)
	}
}

// stderrIsTerminal: a character device that is not /dev/null, which is what a launch from
// Finder gets.
func stderrIsTerminal() bool {
	fi, err := os.Stderr.Stat()
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	null, err := os.Stat(os.DevNull)
	return err != nil || !os.SameFile(fi, null)
}

func redirectStderr(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if fi, err := os.Stat(path); err == nil && fi.Size() > guiLogMost {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return syscall.Dup2(int(f.Fd()), int(os.Stderr.Fd()))
}
