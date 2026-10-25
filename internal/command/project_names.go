package command

import "context"

// Project names in messages (docs/notes/workspaces-v2-fix-1-workspace.md): workspaces and
// threads carry project ids; what a command prints names them. RegisterProject sets the
// registry's lister; without one (tests that register only a domain) ids are printed.

// ProjectNameLister returns every registered project's name by id.
type ProjectNameLister func(ctx context.Context) (map[string]string, error)

// SetProjectNames makes the registry's commands print project names through list.
func (r *Registry) SetProjectNames(list ProjectNameLister) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.projectNames = list
}

// projectNamer returns a func naming a project id: its name, else the id (unknown, no
// lister, or the list failed). One list per call of projectNamer.
func (r *Registry) projectNamer(ctx context.Context) func(id string) string {
	r.mu.RLock()
	list := r.projectNames
	r.mu.RUnlock()
	var names map[string]string
	if list != nil {
		names, _ = list(ctx)
	}
	return func(id string) string {
		if n := names[id]; n != "" {
			return n
		}
		return id
	}
}

// mapNames is ids through name.
func mapNames(ids []string, name func(string) string) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = name(id)
	}
	return out
}
