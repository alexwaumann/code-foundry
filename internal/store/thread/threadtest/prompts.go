package threadtest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetPrompts makes ListPrompts answer prompts (filtered by its query and limit).
func (f *Fake) SetPrompts(prompts ...thread.SentPrompt) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompts = slices.Clone(prompts)
}

// ListPrompts records "ListPrompts <scope> <thread> <projects>" and returns SetPrompts'
// prompts: for THREAD scope the thread's only, then those whose text holds the query,
// at most the limit.
func (f *Fake) ListPrompts(_ context.Context, q thread.PromptQuery) ([]thread.SentPrompt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, strings.TrimSpace(fmt.Sprintf("ListPrompts %d %s %s", q.Scope, q.ThreadID, strings.Join(q.ProjectIDs, ","))))
	switch q.Scope {
	case thread.PromptScopeThread:
		if _, err := f.get(q.ThreadID); err != nil {
			return nil, err
		}
	case thread.PromptScopeProject, thread.PromptScopeAll:
	default:
		return nil, fmt.Errorf("%w: a scope is required", thread.ErrInvalidArgument)
	}
	limit := q.Limit
	if limit <= 0 {
		limit = thread.DefaultPromptLimit
	}
	out := []thread.SentPrompt{}
	for _, p := range f.prompts {
		if q.Scope == thread.PromptScopeThread && p.ThreadID != q.ThreadID {
			continue
		}
		if q.Query != "" && !strings.Contains(strings.ToLower(p.Text), strings.ToLower(q.Query)) {
			continue
		}
		if len(out) < limit {
			out = append(out, p)
		}
	}
	return out, nil
}
