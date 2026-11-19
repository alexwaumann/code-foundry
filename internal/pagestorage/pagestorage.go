// Package pagestorage is the file a page's cf.storage is kept in: one JSON object (key →
// the value's JSON text) in <dir>/storage.json, at most Max bytes, written atomically. A
// thread's pages share one (internal/store/thread, docs/notes/bridge-fix-storage.md); a
// page no thread owns has its own (internal/store/page, docs/notes/page-ownership-daemon.md).
// The caller serializes reads and writes of one directory.
package pagestorage

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

const (
	// Max caps one storage, as the file it is written to.
	Max = 256 << 10
	// KeyMax caps a key's length in bytes.
	KeyMax = 1024
	// File is the storage's file name in its directory.
	File = "storage.json"
)

// ErrInvalid is a key, a value or a size the storage refuses; nothing is written then.
var ErrInvalid = errors.New("invalid page storage")

// Check refuses an empty or too long key, or a value (when set) that is not JSON.
func Check(key string, value *string) error {
	switch {
	case key == "":
		return fmt.Errorf("%w: page storage needs a key", ErrInvalid)
	case len(key) > KeyMax:
		return fmt.Errorf("%w: page storage keys are at most %d bytes", ErrInvalid, KeyMax)
	case value != nil && !json.Valid([]byte(*value)):
		return fmt.Errorf("%w: page storage value for %q is not JSON", ErrInvalid, key)
	}
	return nil
}

// Read reads dir's storage; empty when there is none (or dir is ""). A file that does not
// parse (written by hand) is logged with what and read as empty, so the next write
// replaces it.
func Read(dir string, log *slog.Logger, what ...any) (map[string]json.RawMessage, error) {
	vals := map[string]json.RawMessage{}
	if dir == "" {
		return vals, nil
	}
	b, err := os.ReadFile(filepath.Join(dir, File))
	if errors.Is(err, os.ErrNotExist) {
		return vals, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &vals); err != nil {
		log.Warn("a page storage does not parse; starting it empty", append(what, "err", err)...)
		return map[string]json.RawMessage{}, nil
	}
	return vals, nil
}

// Set sets key to value in dir's storage, or removes it when value is nil, and returns
// the storage after; per names the owner in the full message ("thread", "page"). The key
// and value must have passed Check. ErrInvalid when the storage would grow over Max.
func Set(dir, key string, value *string, per string, log *slog.Logger, what ...any) (map[string]string, error) {
	vals, err := Read(dir, log, what...)
	if err != nil {
		return nil, err
	}
	if value == nil {
		if _, ok := vals[key]; !ok {
			return Text(vals), nil
		}
		delete(vals, key)
	} else {
		vals[key] = json.RawMessage(*value)
	}
	b, err := json.Marshal(vals)
	if err != nil {
		return nil, err
	}
	if value != nil && len(b) > Max {
		return nil, fmt.Errorf("%w: page storage is full (%d KiB per %s); remove something first", ErrInvalid, Max>>10, per)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := WriteAtomic(filepath.Join(dir, File), b); err != nil {
		return nil, err
	}
	return Text(vals), nil
}

// Text is the storage as key → the value's JSON text.
func Text(vals map[string]json.RawMessage) map[string]string {
	out := make(map[string]string, len(vals))
	for k, v := range vals {
		out[k] = string(v)
	}
	return out
}

// WriteAtomic writes b to path through a temp file in the same directory and a rename,
// so a crash never leaves half a file.
func WriteAtomic(path string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }() // a no-op after the rename
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
