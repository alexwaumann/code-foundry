package projecttest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Rename implements project.Store with the real store's rules (project.CheckName).
func (f *Fake) Rename(_ context.Context, id, name string) (project.Project, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "Rename "+id+" "+name)
	if f.Err != nil {
		defer f.mu.Unlock()
		return project.Project{}, f.Err
	}
	r, ok := f.projects[id]
	snap := f.snap
	f.mu.Unlock()
	if !ok {
		return project.Project{}, fmt.Errorf("%w: project %q", project.ErrNotFound, id)
	}
	name, err := project.CheckName(snap, id, name)
	if err != nil {
		return project.Project{}, err
	}
	if r.Name != name {
		r.Name = name
		f.Put(r)
	}
	return r, nil
}
