package fsx

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

// File writes for the file viewer (FilesystemService.WriteFile). Contents are often
// secrets: they are never logged and never go into an error.

const (
	// MaxWriteBytes is the largest write, the most the viewer can have read of a text file.
	MaxWriteBytes = MaxReadBytes
	// newFileMode is the mode of a file Write makes: it may be a secret.
	newFileMode fs.FileMode = 0o600
	// tempPattern is the temp file's name. It is not built from the target's name, which
	// may already be as long as a name can be.
	tempPattern = ".cf-write-*"
)

// WriteRequest is one write. Path and BaseDir are as for ReadFile.
type WriteRequest struct {
	BaseDir, Path string
	Contents      []byte
	// ModifiedAt (unix milliseconds) and Size are what the read saw. Ignored with Force
	// or Create.
	ModifiedAt, Size int64
	// Force writes whatever is there now, and writes a file that is gone anew.
	Force bool
	// Create makes a file that does not exist. Not with Force.
	Create bool
}

// WriteResult is Write's result.
type WriteResult struct {
	// Path is the absolute, cleaned path asked for (symlinks not followed).
	Path string
	// Conflict: nothing was written, the file is not what the request expected.
	Conflict bool
	// NotFound, with Conflict: no file is at Path, a symlink leading nowhere included.
	NotFound bool
	// Size and ModifiedAt (unix milliseconds) are the file as written, or as found on a
	// Conflict: the next write's baseline.
	Size, ModifiedAt int64
}

// Writer replaces files under Root (a resolved root, see ResolveRoot).
type Writer struct {
	Root string
	// Protected reports whether an absolute, cleaned path may not be written; it is asked
	// about the path as given and with its symlinks resolved. Nil: nothing is protected.
	Protected func(path string) bool

	// mu makes a check and its write one step, so of two writes from the same baseline
	// the second finds the first's file.
	mu sync.Mutex
	// staged, when set, runs with the temp file complete and the target not yet touched:
	// tests change the target there, as another process could.
	staged func()
}

// Write writes req.Contents atomically: a temp file in the target's directory, its mode
// set before any contents go in and synced, then renamed over the file. The existing
// file's mode stays; a file Write makes is 0600.
//
// A file that differs from the request's baseline, or is gone, is a Conflict and nothing
// is written. Force skips the baseline. Create takes a place where nothing is, as O_EXCL
// would: a temp file linked there cannot replace what appeared meanwhile, and neither can
// Force on a file that was gone, so either may still end in a Conflict.
//
// Symlinks are written through. The file they lead to, or a new file's directory, must be
// under Root and clear of Protected. That, a directory or anything else that is not a
// regular file, contents over MaxWriteBytes, Create with Force, Create or Force without
// the file's directory, and Force on a symlink leading nowhere (replacing it would drop
// the link) wrap ErrInvalidArgument. A write macOS's privacy protection refused is an
// ErrNotPermitted error that says where to allow it.
func (w *Writer) Write(req WriteRequest) (WriteResult, error) {
	switch {
	case len(req.Contents) > MaxWriteBytes:
		return WriteResult{}, fmt.Errorf("%w: contents are %d bytes, at most %d", ErrInvalidArgument, len(req.Contents), MaxWriteBytes)
	case req.Force && req.Create:
		return WriteResult{}, fmt.Errorf("%w: set force or create, not both", ErrInvalidArgument)
	}
	p, err := ResolveReadPath(w.Root, req.BaseDir, req.Path)
	if err != nil {
		return WriteResult{}, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	t, err := w.locate(p, req.Path)
	if err != nil {
		return WriteResult{}, err
	}
	exists := t.info != nil
	regular := exists && t.info.Mode().IsRegular()
	deadLink := exists && t.info.Mode()&fs.ModeSymlink != 0 // locate resolved the rest
	switch {
	case exists && t.info.IsDir():
		return WriteResult{}, fmt.Errorf("%w: %s is a directory", ErrInvalidArgument, req.Path)
	case exists && !regular && !deadLink:
		return WriteResult{}, fmt.Errorf("%w: %s is not a regular file", ErrInvalidArgument, req.Path)
	case req.Create && exists:
		return conflict(p, t.info), nil
	case req.Force && deadLink:
		return WriteResult{}, fmt.Errorf("%w: %s is a symlink that leads nowhere", ErrInvalidArgument, req.Path)
	case !req.Create && !req.Force && !(regular && req.matches(t.info)):
		return conflict(p, t.info), nil
	case t.noDir:
		return WriteResult{}, fmt.Errorf("%w: the directory of %s does not exist", ErrInvalidArgument, req.Path)
	}
	mode := newFileMode
	if regular {
		mode = t.info.Mode().Perm()
	}
	tmp, written, err := stage(filepath.Dir(t.real), mode, req.Contents)
	if err != nil {
		return WriteResult{}, w.failed(p, t.real, err)
	}
	// Gone already after a rename; after a link, this is what takes its second name away.
	defer func() { _ = os.Remove(tmp) }()
	if w.staged != nil {
		w.staged()
	}
	if !regular {
		switch err := os.Link(tmp, t.real); {
		case errors.Is(err, fs.ErrExist):
			return w.conflictNow(p, t.real)
		case err != nil:
			return WriteResult{}, w.failed(p, t.real, err)
		}
		return WriteResult{Path: p, Size: written.Size(), ModifiedAt: written.ModTime().UnixMilli()}, nil
	}
	if !req.Force { // again, with the writing done: the file may have changed meanwhile
		cur, err := lstat(t.real)
		if err != nil {
			return WriteResult{}, w.failed(p, t.real, err)
		}
		if cur == nil || !cur.Mode().IsRegular() || !req.matches(cur) {
			return conflict(p, cur), nil
		}
	}
	if err := os.Rename(tmp, t.real); err != nil {
		return WriteResult{}, w.failed(p, t.real, err)
	}
	return WriteResult{Path: p, Size: written.Size(), ModifiedAt: written.ModTime().UnixMilli()}, nil
}

// matches reports whether fi is the file the request's read saw, compared as ReadFile
// reports it.
func (r WriteRequest) matches(fi fs.FileInfo) bool {
	return fi.ModTime().UnixMilli() == r.ModifiedAt && fi.Size() == r.Size
}

// writeTarget is where a write lands.
type writeTarget struct {
	// real is the path with its symlinks resolved. Nothing there, or a symlink leading
	// nowhere: the last name as given, in its directory resolved.
	real string
	// info is what is at real (not followed), nil for nothing.
	info fs.FileInfo
	// noDir: real's directory does not exist.
	noDir bool
}

// locate resolves p (asked as path) and checks it may be written.
func (w *Writer) locate(p, path string) (writeTarget, error) {
	var t writeTarget
	var err error
	t.real, err = filepath.EvalSymlinks(p)
	if errors.Is(err, fs.ErrNotExist) {
		var dir string
		dir, err = filepath.EvalSymlinks(filepath.Dir(p))
		t.real = filepath.Join(dir, filepath.Base(p))
		if errors.Is(err, fs.ErrNotExist) {
			t.real, t.noDir, err = p, true, nil
		}
	}
	switch {
	case errors.Is(err, syscall.ENOTDIR):
		return t, fmt.Errorf("%w: a parent of %s is not a directory", ErrInvalidArgument, path)
	case err != nil:
		return t, w.failed(p, p, err)
	case !Within(w.Root, t.real):
		return t, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, path)
	case w.Protected != nil && (w.Protected(p) || w.Protected(t.real)):
		return t, fmt.Errorf("%w: %s is Code Foundry's own data, which cannot be edited", ErrInvalidArgument, path)
	case t.noDir:
		return t, nil
	}
	t.info, err = lstat(t.real)
	if err != nil {
		return t, w.failed(p, t.real, err)
	}
	return t, nil
}

// stage writes contents to a new temp file in dir and syncs it. It returns the file's
// name and its info: the mode goes on first, so a file never holds contents with more
// access than the one it replaces, and the size and time are the written file's whatever
// happens to the target's name afterwards. Nothing is left behind on a failure.
func stage(dir string, mode fs.FileMode, contents []byte) (name string, info fs.FileInfo, err error) {
	f, err := os.CreateTemp(dir, tempPattern) // 0600 until the Chmod
	if err != nil {
		return "", nil, err
	}
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(f.Name())
		}
	}()
	if err = f.Chmod(mode); err != nil {
		return "", nil, err
	}
	if _, err = f.Write(contents); err != nil {
		return "", nil, err
	}
	if err = f.Sync(); err != nil {
		return "", nil, err
	}
	if info, err = f.Stat(); err != nil {
		return "", nil, err
	}
	if err = f.Close(); err != nil {
		return "", nil, err
	}
	return f.Name(), info, nil
}

// lstat is os.Lstat with nothing there as a nil info.
func lstat(p string) (fs.FileInfo, error) {
	fi, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return fi, err
}

// conflict is the Conflict result for what is at p: fi, or nil for nothing.
func conflict(p string, fi fs.FileInfo) WriteResult {
	if fi == nil || fi.Mode()&fs.ModeSymlink != 0 {
		return WriteResult{Path: p, Conflict: true, NotFound: true}
	}
	return WriteResult{Path: p, Conflict: true, Size: fi.Size(), ModifiedAt: fi.ModTime().UnixMilli()}
}

// conflictNow is the Conflict result for whatever real holds now.
func (w *Writer) conflictNow(p, real string) (WriteResult, error) {
	fi, err := lstat(real)
	if err != nil {
		return WriteResult{}, w.failed(p, real, err)
	}
	return conflict(p, fi), nil
}

// failed is the error for a write of p (real once resolved) that err stopped.
func (w *Writer) failed(p, real string, err error) error {
	if isPrivacyDenial(err) {
		return notPermitted(w.Root, p, real, writing, err)
	}
	return fmt.Errorf("fsx: write %s: %w", p, err)
}
