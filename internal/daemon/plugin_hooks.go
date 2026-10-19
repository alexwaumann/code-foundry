package daemon

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The plugin store's hooks into the thread store (docs/notes/plugins-3-events-flags-env.md):
// thread flags (pluginFlags, plugin.ThreadFlags over the thread store) and the session
// environment (pluginSpawnExtras, the thread store's spawn extras from the plugin
// store). Neither store imports the other.

// pluginFlags adapts the thread store to plugin.ThreadFlags: a flag's source is the
// plugin's name.
type pluginFlags struct{ threads *thread.Manager }

var _ plugin.ThreadFlags = pluginFlags{}

var flagLevels = map[string]thread.FlagLevel{
	pluginsdk.FlagAttention: thread.FlagAttention,
	pluginsdk.FlagError:     thread.FlagError,
	pluginsdk.FlagNone:      thread.FlagNone,
}

func (f pluginFlags) SetFlag(ctx context.Context, id string, s plugin.FlagSpec) (bool, error) {
	level, ok := flagLevels[s.Level]
	if !ok {
		return false, fmt.Errorf("%w: flag level %q", plugin.ErrInvalidArgument, s.Level)
	}
	_, changed, err := f.threads.SetFlag(ctx, id, thread.Flag{
		Source: s.Plugin, SourceName: s.DisplayName, Level: level, Reason: s.Reason, UntilSeen: s.UntilSeen,
	})
	for from, to := range flagErrors {
		if errors.Is(err, from) {
			return false, kindError{kind: to, err: err}
		}
	}
	return changed, err
}

// flagErrors map the thread store's errors to the plugin store's.
var flagErrors = map[error]error{
	thread.ErrNotFound:           plugin.ErrNotFound,
	thread.ErrInvalidArgument:    plugin.ErrInvalidArgument,
	thread.ErrFailedPrecondition: plugin.ErrFailedPrecondition,
}

// kindError reads as err and matches kind (errors.Is) as well as err's own chain.
type kindError struct{ kind, err error }

func (e kindError) Error() string   { return e.err.Error() }
func (e kindError) Unwrap() []error { return []error{e.kind, e.err} }

func (f pluginFlags) ClearPlugin(ctx context.Context, name string) (int, error) {
	return f.threads.ClearFlagSource(ctx, name)
}

func (f pluginFlags) Of(name string) []pluginsdk.Flag {
	var out []pluginsdk.Flag
	for id, fl := range f.threads.FlagsOf(name) {
		out = append(out, pluginsdk.Flag{ThreadID: id, Level: fl.Level.String(), Reason: fl.Reason, UntilSeen: fl.UntilSeen, SetAt: fl.SetAt})
	}
	slices.SortFunc(out, func(a, b pluginsdk.Flag) int { return a.SetAt.Compare(b.SetAt) })
	return out
}

func (f pluginFlags) Plugins() []string {
	var out []string
	for _, t := range f.threads.Snapshot().Threads {
		for _, fl := range t.Flags {
			if !slices.Contains(out, fl.Source) {
				out = append(out, fl.Source)
			}
		}
	}
	return out
}

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
