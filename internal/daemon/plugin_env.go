package daemon

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// The plugins' session environment beyond a thread's spawn
// (docs/notes/plugins-env-restart.md): running threads learn that it changed
// (startPluginEnvWatch), and bottom-panel shells get it when they start
// (pluginShellExtras).

// envChecker is the thread store's staleness check (thread.Manager.CheckSpawnExtras).
type envChecker interface{ CheckSpawnExtras(ctx context.Context) }

// startPluginEnvWatch asks the thread store to compare its running threads' spawn
// extras with the current ones whenever a plugin's contribution may have changed: a
// push or withdrawal (EnvironmentChanged), an enable, disable, grant change or crash
// (Changed), a removal. Events that arrive together make one check.
func startPluginEnvWatch(ctx context.Context, b *bus.Bus, threads envChecker) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	sub := bus.Subscribe[plugin.Event](b, 256)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer sub.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-sub.C():
				if !envMayChange(ev) {
					continue
				}
			drain:
				for {
					select {
					case <-sub.C():
					default:
						break drain
					}
				}
				threads.CheckSpawnExtras(ctx)
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}

// envMayChange reports whether ev may change what a plugin contributes to spawns.
func envMayChange(ev plugin.Event) bool {
	switch ev.(type) {
	case plugin.EnvironmentChanged, plugin.Changed, plugin.Removed:
		return true
	}
	return false
}

// shellScope is the plugins' scope for a terminal with labels: a bottom-panel shell
// started for a thread gets that thread's (its project, workspace members, or none;
// its owner), one started for a project that project's, any other shell (a home
// directory one) the no-project scope. Not a shell (an action run, a plugin's
// terminal): nothing. threadInfo is the thread store's SpawnInfo; a thread it does not
// know falls back to the project label.
func shellScope(labels map[string]string, threadInfo func(id string) (thread.SpawnInfo, bool)) (plugin.SpawnScope, bool) {
	if !termlabel.IsShell(labels) {
		return plugin.SpawnScope{}, false
	}
	if id := labels[termlabel.Thread]; id != "" && threadInfo != nil {
		if in, ok := threadInfo(id); ok {
			return plugin.SpawnScope{ThreadID: in.ThreadID, ProjectID: in.ProjectID, MemberProjectIDs: in.MemberProjectIDs,
				NoProject: in.NoProject, Owner: in.Owner}, true
		}
	}
	if p := labels[termlabel.Project]; p != "" {
		return plugin.SpawnScope{ProjectID: p}, true
	}
	return plugin.SpawnScope{NoProject: true}, true
}

// pluginShellExtras is the terminal store's spawn extras: the plugins' environment
// variables and PATH entries for a shell's scope (no add-dirs: they are Claude's).
// Never waits for a starting plugin.
func pluginShellExtras(plugins *plugin.Manager, threads *thread.Manager) terminal.SpawnExtrasFunc {
	return func(ctx context.Context, labels map[string]string) terminal.SpawnExtras {
		scope, ok := shellScope(labels, threads.SpawnInfo)
		if !ok {
			return terminal.SpawnExtras{}
		}
		c := plugins.SessionEnvironment(ctx, scope, false)
		return terminal.SpawnExtras{Env: c.Env, PathPrepend: c.PathPrepend}
	}
}
