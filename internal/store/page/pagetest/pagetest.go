// Package pagetest has fakes of the page store for the packages that use it.
package pagetest

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/page"
)

// Record is one call to Recorder.Record.
type Record struct {
	Thread, Path, How string
}

// Recorder records the owners it is told of (thread.PageRecorder) and refuses none.
type Recorder struct {
	mu   sync.Mutex
	recs []Record
}

// Record implements thread.PageRecorder.
func (r *Recorder) Record(_ context.Context, id, path, how string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recs = append(r.recs, Record{Thread: id, Path: path, How: how})
	return nil
}

// Records are the calls so far, in order.
func (r *Recorder) Records() []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Record(nil), r.recs...)
}

// Backend is an in-memory page store for the page.* commands: Pages are the accesses it
// answers, keyed by the path asked (no resolving); a path it has none for is Err.
type Backend struct {
	mu    sync.Mutex
	Pages map[string]page.Access
	// Err answers a path not in Pages; nil: a page no one owns and not asked about.
	Err error
}

// Access implements command.PageBackend.
func (b *Backend) Access(_ context.Context, path string) (page.Access, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if a, ok := b.Pages[path]; ok {
		return a, nil
	}
	if b.Err != nil {
		return page.Access{}, b.Err
	}
	return page.Access{Path: path}, nil
}

// SetConsent implements command.PageBackend.
func (b *Backend) SetConsent(ctx context.Context, path string, allowed bool) (page.Access, error) {
	a, err := b.Access(ctx, path)
	if err != nil {
		return page.Access{}, err
	}
	a.Consent = page.Refused
	if allowed {
		a.Consent = page.Allowed
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.Pages == nil {
		b.Pages = map[string]page.Access{}
	}
	b.Pages[path] = a
	return a, nil
}
