// Package backdroptest provides an in-memory fake of backdrop.Service for handler tests.
package backdroptest

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/backdrop"
)

// Fake is a backdrop.Service over a list in memory. Import adds an entry named after
// the path's base (no file is read) unless Fail set an error for that path; Remove and
// Read find entries by name. It does not touch settings.
type Fake struct {
	mu      sync.Mutex
	entries []backdrop.Entry
	data    map[string][]byte
	errs    map[string]error
	// Calls records "import <path>", "remove <name>" and "read <name>".
	Calls []string
}

var _ backdrop.Service = (*Fake)(nil)

// New returns an empty fake.
func New() *Fake { return &Fake{data: map[string][]byte{}, errs: map[string]error{}} }

// Add puts an image in, with its bytes for Read.
func (f *Fake) Add(e backdrop.Entry, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = append(f.entries, e)
	f.data[e.Name] = data
}

// Fail makes Import of path (or Remove or Read of a name) fail with err.
func (f *Fake) Fail(key string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs[key] = err
}

// List implements backdrop.Service.
func (f *Fake) List(context.Context) ([]backdrop.Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.entries), nil
}

// Import implements backdrop.Service.
func (f *Fake) Import(_ context.Context, path string) (backdrop.Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "import "+path)
	if err := f.errs[path]; err != nil {
		return backdrop.Entry{}, err
	}
	e := backdrop.Entry{Name: filepath.Base(path), Size: 1, Added: time.Now()}
	f.entries = append(f.entries, e)
	return e, nil
}

// Remove implements backdrop.Service.
func (f *Fake) Remove(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "remove "+name)
	if err := f.errs[name]; err != nil {
		return err
	}
	i := slices.IndexFunc(f.entries, func(e backdrop.Entry) bool { return e.Name == name })
	if i < 0 {
		return fmt.Errorf("%w: backdrop %q", backdrop.ErrNotFound, name)
	}
	f.entries = slices.Delete(f.entries, i, i+1)
	delete(f.data, name)
	return nil
}

// Read implements backdrop.Service.
func (f *Fake) Read(_ context.Context, name string) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "read "+name)
	if err := f.errs[name]; err != nil {
		return nil, "", err
	}
	data, ok := f.data[name]
	if !ok {
		return nil, "", fmt.Errorf("%w: backdrop %q", backdrop.ErrNotFound, name)
	}
	return data, "image/png", nil
}
