package thread

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// A thread's page storage: what the pages it shows keep with the bridge's cf.storage
// (docs/notes/bridge-fix-storage.md). WebKit keeps a cross-site frame's localStorage in
// memory for the session only, so the GUI host forwards every write here and hands a
// page the whole map when it loads. One JSON object per thread (key → the value's JSON
// text) in <PageStorageRoot>/<thread id>/storage.json, written atomically; reads and
// writes are serialized (Manager.pageStore).

const (
	// PageStorageMax caps one thread's page storage, as the file it is written to.
	PageStorageMax = 256 << 10
	// PageStorageKeyMax caps a key's length in bytes.
	PageStorageKeyMax = 1024
	pageStorageFile   = "storage.json"
)

// PageStorage implements Store: thread id's page storage, key → the value's JSON text;
// empty when its pages stored nothing.
func (m *Manager) PageStorage(ctx context.Context, id string) (map[string]string, error) {
	if _, err := m.Get(ctx, id); err != nil {
		return nil, err
	}
	m.pageStore.Lock()
	defer m.pageStore.Unlock()
	vals, err := m.readPageStorage(id)
	if err != nil {
		return nil, err
	}
	return pageStorageText(vals), nil
}

// SetPageStorage implements Store: it sets key to value (JSON text) in thread id's page
// storage, or removes key when value is nil, and returns the storage after.
// ErrInvalidArgument for an empty or too long key, a value that is not JSON, or a
// storage that would grow over PageStorageMax (nothing is written then).
func (m *Manager) SetPageStorage(ctx context.Context, id, key string, value *string) (map[string]string, error) {
	if key == "" {
		return nil, fmt.Errorf("%w: page storage needs a key", ErrInvalidArgument)
	}
	if len(key) > PageStorageKeyMax {
		return nil, fmt.Errorf("%w: page storage keys are at most %d bytes", ErrInvalidArgument, PageStorageKeyMax)
	}
	if value != nil && !json.Valid([]byte(*value)) {
		return nil, fmt.Errorf("%w: page storage value for %q is not JSON", ErrInvalidArgument, key)
	}
	if _, err := m.Get(ctx, id); err != nil {
		return nil, err
	}
	if m.opts.PageStorageRoot == "" {
		return nil, fmt.Errorf("%w: this daemon keeps no page storage", ErrFailedPrecondition)
	}
	m.pageStore.Lock()
	defer m.pageStore.Unlock()
	vals, err := m.readPageStorage(id)
	if err != nil {
		return nil, err
	}
	if value == nil {
		if _, ok := vals[key]; !ok {
			return pageStorageText(vals), nil
		}
		delete(vals, key)
	} else {
		vals[key] = json.RawMessage(*value)
	}
	b, err := json.Marshal(vals)
	if err != nil {
		return nil, fmt.Errorf("thread: page storage of %s: %w", id, err)
	}
	if value != nil && len(b) > PageStorageMax {
		return nil, fmt.Errorf("%w: page storage is full (%d KiB per thread); remove something first", ErrInvalidArgument, PageStorageMax>>10)
	}
	dir := threadTmp(m.opts.PageStorageRoot, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("thread: page storage of %s: %w", id, err)
	}
	if err := writePageStorage(filepath.Join(dir, pageStorageFile), b); err != nil {
		return nil, fmt.Errorf("thread: page storage of %s: %w", id, err)
	}
	return pageStorageText(vals), nil
}

// readPageStorage reads thread id's storage file; empty when there is none. A file that
// does not parse (written by hand) is logged and read as empty, so the next write
// replaces it. Callers hold m.pageStore.
func (m *Manager) readPageStorage(id string) (map[string]json.RawMessage, error) {
	vals := map[string]json.RawMessage{}
	dir := threadTmp(m.opts.PageStorageRoot, id)
	if dir == "" {
		return vals, nil
	}
	b, err := os.ReadFile(filepath.Join(dir, pageStorageFile))
	if errors.Is(err, os.ErrNotExist) {
		return vals, nil
	}
	if err != nil {
		return nil, fmt.Errorf("thread: page storage of %s: %w", id, err)
	}
	if err := json.Unmarshal(b, &vals); err != nil {
		m.log.Warn("a thread's page storage does not parse; starting it empty", "thread", id, "err", err)
		return map[string]json.RawMessage{}, nil
	}
	return vals, nil
}

func pageStorageText(vals map[string]json.RawMessage) map[string]string {
	out := make(map[string]string, len(vals))
	for k, v := range vals {
		out[k] = string(v)
	}
	return out
}

// writePageStorage writes b to path through a temp file in the same directory and a
// rename, so a crash never leaves half a file.
func writePageStorage(path string, b []byte) error {
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
