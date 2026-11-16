package daemon

import (
	"context"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// The plugin store's hooks into the thread store (docs/notes/plugins-3-events-flags-env.md):
// the session environment (pluginSpawnExtras, the thread store's spawn extras from the
// plugin store). Thread flags are notifications now (plugin_flags.go). Neither store
// imports the other.

// kindError reads as err and matches kind (errors.Is) as well as err's own chain.
type kindError struct{ kind, err error }

func (e kindError) Error() string   { return e.err.Error() }
func (e kindError) Unwrap() []error { return []error{e.kind, e.err} }

// pluginSpawnExtras is the thread store's spawn extras: the plugins' session
// environments for the spawning thread's scope.
func pluginSpawnExtras(plugins *plugin.Manager) thread.SpawnExtrasFunc {
	return func(ctx context.Context, in thread.SpawnInfo) thread.SpawnExtras {
		c := plugins.SessionEnvironment(ctx, plugin.SpawnScope{
			ThreadID: in.ThreadID, ProjectID: in.ProjectID, MemberProjectIDs: in.MemberProjectIDs, NoProject: in.NoProject,
			Owner: in.Owner, Quiet: in.Probe,
		}, in.Wait && !in.Probe)
		x := thread.SpawnExtras{Env: c.Env, PathPrepend: c.PathPrepend, AddDirs: c.AddDirs}
		for _, src := range c.Sources {
			x.Sources = append(x.Sources, thread.ExtrasSource{
				ID: src.Plugin, Name: src.DisplayName, Env: src.Env, PathPrepend: src.PathPrepend, AddDirs: src.AddDirs,
			})
		}
		return x
	}
}
