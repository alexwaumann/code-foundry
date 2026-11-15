package projecttest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// SetIncludeIgnored implements project.Store with the real store's rules
// (project.CleanIncludes).
func (f *Fake) SetIncludeIgnored(_ context.Context, id string, patterns []string) (project.Project, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "SetIncludeIgnored "+id+" "+strings.Join(patterns, ","))
	if f.Err != nil {
		defer f.mu.Unlock()
		return project.Project{}, f.Err
	}
	r, ok := f.projects[id]
	f.mu.Unlock()
	if !ok {
		return project.Project{}, fmt.Errorf("%w: project %q", project.ErrNotFound, id)
	}
	patterns, err := project.CleanIncludes(patterns)
	if err != nil {
		return project.Project{}, err
	}
	if len(patterns) == 0 {
		patterns = nil
	}
	if !slices.Equal(r.IncludeIgnored, patterns) {
		r.IncludeIgnored = patterns
		f.Put(r)
	}
	return r, nil
}
