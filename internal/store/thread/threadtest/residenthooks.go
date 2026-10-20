package threadtest

import (
	"context"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetCreateDefaults records the create defaults (thread.Manager.SetCreateDefaults);
// Create applies them like the store does.
func (f *Fake) SetCreateDefaults(fn thread.CreateDefaultsFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createDefaults = fn
}

// SetResidentTools records a resident's rules (thread.Manager.SetResidentTools);
// ResidentTools returns them.
func (f *Fake) SetResidentTools(name string, t thread.ResidentTools) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.residentTools == nil {
		f.residentTools = map[string]thread.ResidentTools{}
	}
	f.residentTools[name] = t
}

// ResidentTools are the rules SetResidentTools set for name.
func (f *Fake) ResidentTools(name string) thread.ResidentTools {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.residentTools[name]
}

// applyCreateDefaults fills o's open model and effort from the create defaults when a
// thread creates it, like the store's Create. Called without f.mu.
func (f *Fake) applyCreateDefaults(ctx context.Context, o *thread.CreateOptions) {
	f.mu.Lock()
	fn := f.createDefaults
	f.mu.Unlock()
	if fn == nil || o.CreatedBy == "" {
		return
	}
	needModel, needEffort := o.Model == "" || o.ModelDefaulted, o.Effort == "" || o.EffortDefaulted
	if !needModel && !needEffort {
		return
	}
	model, effort := fn(ctx, o.CreatedBy, needModel, needEffort)
	if needModel && model != "" {
		o.Model = model
	}
	if needEffort && effort != "" {
		o.Effort = effort
	}
}
