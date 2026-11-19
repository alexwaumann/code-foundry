package thread

import (
	"context"
	"errors"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/pagestorage"
)

// A thread's page storage: what the pages it shows keep with the bridge's cf.storage
// (docs/notes/bridge-fix-storage.md). WebKit keeps a cross-site frame's localStorage in
// memory for the session only, so the GUI host forwards every write here and hands a
// page the whole map when it loads. One JSON object per thread (key → the value's JSON
// text) in <PageStorageRoot>/<thread id>/storage.json, written atomically
// (internal/pagestorage); reads and writes are serialized (Manager.pageStore). A page no
// thread owns keeps its own instead (internal/store/page).

const (
	// PageStorageMax caps one thread's page storage, as the file it is written to.
	PageStorageMax = pagestorage.Max
	// PageStorageKeyMax caps a key's length in bytes.
	PageStorageKeyMax = pagestorage.KeyMax
)

// PageStorage implements Store: thread id's page storage, key → the value's JSON text;
// empty when its pages stored nothing.
func (m *Manager) PageStorage(ctx context.Context, id string) (map[string]string, error) {
	if _, err := m.Get(ctx, id); err != nil {
		return nil, err
	}
	m.pageStore.Lock()
	defer m.pageStore.Unlock()
	vals, err := pagestorage.Read(threadTmp(m.opts.PageStorageRoot, id), m.log, "thread", id)
	if err != nil {
		return nil, fmt.Errorf("thread: page storage of %s: %w", id, err)
	}
	return pagestorage.Text(vals), nil
}

// SetPageStorage implements Store: it sets key to value (JSON text) in thread id's page
// storage, or removes key when value is nil, and returns the storage after.
// ErrInvalidArgument for an empty or too long key, a value that is not JSON, or a
// storage that would grow over PageStorageMax (nothing is written then).
func (m *Manager) SetPageStorage(ctx context.Context, id, key string, value *string) (map[string]string, error) {
	if err := pagestorage.Check(key, value); err != nil {
		return nil, storageError(id, err)
	}
	if _, err := m.Get(ctx, id); err != nil {
		return nil, err
	}
	if m.opts.PageStorageRoot == "" {
		return nil, fmt.Errorf("%w: this daemon keeps no page storage", ErrFailedPrecondition)
	}
	m.pageStore.Lock()
	defer m.pageStore.Unlock()
	vals, err := pagestorage.Set(threadTmp(m.opts.PageStorageRoot, id), key, value, "thread", m.log, "thread", id)
	if err != nil {
		return nil, storageError(id, err)
	}
	return vals, nil
}

// storageError is a pagestorage error as the store's: a refusal is ErrInvalidArgument.
func storageError(id string, err error) error {
	if errors.Is(err, pagestorage.ErrInvalid) {
		return fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	return fmt.Errorf("thread: page storage of %s: %w", id, err)
}
