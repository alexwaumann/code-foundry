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

// Search records "Search <query>" and the scope it asks for (" children", " subagents",
// " owned", " projects=<ids>", " limit=<n>", " per=<n>", each when set) and returns
// SetSearch's result (an empty one when unset); an empty query is ErrInvalidArgument,
// like the store.
func (f *Fake) Search(_ context.Context, q thread.SearchQuery) (thread.SearchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := "Search " + q.Query
	for _, flag := range []struct {
		on   bool
		name string
	}{{q.Children, "children"}, {q.Subagents, "subagents"}, {q.Owned, "owned"}} {
		if flag.on {
			call += " " + flag.name
		}
	}
	if len(q.ProjectIDs) > 0 {
		call += " projects=" + strings.Join(q.ProjectIDs, ",")
	}
	if q.Limit > 0 {
		call += fmt.Sprintf(" limit=%d", q.Limit)
	}
	if q.PerThread > 0 {
		call += fmt.Sprintf(" per=%d", q.PerThread)
	}
	f.calls = append(f.calls, call)
	if strings.TrimSpace(q.Query) == "" {
		return thread.SearchResult{}, fmt.Errorf("%w: a query is required", thread.ErrInvalidArgument)
	}
	if f.search == nil {
		return thread.SearchResult{Threads: []thread.ThreadNameMatch{}, Groups: []thread.SearchGroup{}}, nil
	}
	return *f.search, nil
}
