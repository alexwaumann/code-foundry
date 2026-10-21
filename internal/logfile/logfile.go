// Package logfile is a log file with a size cap and one rotation: when a write would
// take <path> past the cap, <path> becomes <path>.1 (replacing the previous one) and a
// new <path> starts. The daemon log and every plugin's log use it.
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// File is an append-only log file with one rotation. Safe for concurrent use.
type File struct {
	path     string
	maxBytes int64
	// onRotate, when set, is called with the new file after each rotation (under the
	// lock; it must not write to f).
	onRotate func(*os.File)

	mu   sync.Mutex
	f    *os.File
	size int64
}

// Option configures Open.
type Option func(*File)

// OnRotate calls fn with the new file after every rotation.
func OnRotate(fn func(*os.File)) Option { return func(f *File) { f.onRotate = fn } }

// New returns the log at path, capped at maxBytes. It opens the file on the first
// write, creating its directory.
func New(path string, maxBytes int64, opts ...Option) *File {
	f := &File{path: path, maxBytes: maxBytes}
	for _, o := range opts {
		o(f)
	}
	return f
}

// Open is New, opening the file now (rotating it first when it is already over the
// cap), so the caller learns at once that the log cannot be written.
func Open(path string, maxBytes int64, opts ...Option) (*File, error) {
	f := New(path, maxBytes, opts...)
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.open(); err != nil {
		return nil, err
	}
	if f.size >= f.maxBytes {
		if err := f.rotate(); err != nil {
			return nil, err
		}
	}
	return f, nil
}

// Path is the live file's path.
func (f *File) Path() string { return f.path }

// Write appends p, rotating first when it would take the file past the cap. One call
// is never split across the two files.
func (f *File) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.f == nil {
		if err := f.open(); err != nil {
			return 0, err
		}
	}
	if f.size > 0 && f.size+int64(len(p)) > f.maxBytes {
		if err := f.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := f.f.Write(p)
	f.size += int64(n)
	return n, err
}

// Close closes the file; a later Write opens it again.
func (f *File) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.f == nil {
		return nil
	}
	err := f.f.Close()
	f.f = nil
	return err
}

// open opens the live file for appending. f.mu held.
func (f *File) open() error {
	if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}
	h, err := os.OpenFile(f.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open log %s: %w", f.path, err)
	}
	f.f, f.size = h, 0
	if fi, err := h.Stat(); err == nil {
		f.size = fi.Size()
	}
	return nil
}

// rotate moves the live file to <path>.1 and starts a new one. f.mu held, f.f open.
func (f *File) rotate() error {
	_ = f.f.Close()
	f.f = nil
	_ = os.Rename(f.path, f.path+".1")
	h, err := os.OpenFile(f.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open log %s: %w", f.path, err)
	}
	f.f, f.size = h, 0
	if fi, err := h.Stat(); err == nil {
		f.size = fi.Size() // another writer (a spawning client) may have recreated it
	}
	if f.onRotate != nil {
		f.onRotate(h)
	}
	return nil
}
