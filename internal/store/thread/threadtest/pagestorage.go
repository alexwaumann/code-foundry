package threadtest

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// PageStorage returns thread id's page storage, kept in memory.
func (f *Fake) PageStorage(_ context.Context, id string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.get(id); err != nil {
		return nil, err
	}
	return maps.Clone(f.pageStorage[id]), nil
}

// SetPageStorage records "SetPageStorage <id> <key>" and sets or removes key in memory.
// It checks the key, that the value is JSON and the thread exists, not the size cap.
func (f *Fake) SetPageStorage(_ context.Context, id, key string, value *string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("SetPageStorage " + id + " " + key); err != nil {
		return nil, err
	}
	if _, err := f.get(id); err != nil {
		return nil, err
	}
	if key == "" || (value != nil && !json.Valid([]byte(*value))) {
		return nil, fmt.Errorf("%w: page storage key %q", thread.ErrInvalidArgument, key)
	}
	if f.pageStorage == nil {
		f.pageStorage = map[string]map[string]string{}
	}
	vals := f.pageStorage[id]
	if vals == nil {
		vals = map[string]string{}
		f.pageStorage[id] = vals
	}
	if value == nil {
		delete(vals, key)
	} else {
		vals[key] = *value
	}
	return maps.Clone(vals), nil
}
