package plugintest

import (
	"cmp"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// PutEnvironment sets a plugin's applied session environment.
func (f *Fake) PutEnvironment(e plugin.Environment) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.envs == nil {
		f.envs = map[string]plugin.Environment{}
	}
	f.envs[e.Plugin] = e
}

// Environments implements plugin.Store: every environment put, or one plugin's (an
// unknown plugin is plugin.ErrNotFound).
func (f *Fake) Environments(name string) ([]plugin.Environment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if name != "" {
		if _, ok := f.plugins[name]; !ok {
			return nil, fmt.Errorf("%w: no plugin %q", plugin.ErrNotFound, name)
		}
		if e, ok := f.envs[name]; ok {
			return []plugin.Environment{e}, nil
		}
		return nil, nil
	}
	var out []plugin.Environment
	for _, e := range f.envs {
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b plugin.Environment) int { return cmp.Compare(a.Plugin, b.Plugin) })
	return out, nil
}
