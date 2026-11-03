package threadtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetSearch makes Search answer res.
func (f *Fake) SetSearch(res thread.SearchResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.search = &res
}

// Search records "Search <query>" and returns SetSearch's result (an empty one when
// unset); an empty query is ErrInvalidArgument, like the store.
func (f *Fake) Search(_ context.Context, q thread.SearchQuery) (thread.SearchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Search "+q.Query)
	if strings.TrimSpace(q.Query) == "" {
		return thread.SearchResult{}, fmt.Errorf("%w: a query is required", thread.ErrInvalidArgument)
	}
	if f.search == nil {
		return thread.SearchResult{Threads: []thread.ThreadNameMatch{}, Groups: []thread.SearchGroup{}}, nil
	}
	return *f.search, nil
}
