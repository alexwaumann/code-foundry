package terminal

import (
	"context"
	"os"
	"strings"
)

// Spawn extras are what others add to a new terminal's environment by its labels: the
// daemon gives bottom-panel shells the plugins' session environment
// (docs/notes/plugins-env-restart.md). The package stays program-agnostic: it never
// reads the labels itself.

// SpawnExtras is a contribution: "KEY=VALUE" entries, merged over the defaults and
// under Spec.Env, and PATH entries put in front of the terminal's PATH.
type SpawnExtras struct {
	Env         []string
	PathPrepend []string
}

// SpawnExtrasFunc returns the extras for a terminal with labels (Spec.Labels). It must
// return at once.
type SpawnExtrasFunc func(ctx context.Context, labels map[string]string) SpawnExtras

// SetSpawnExtras sets (nil: removes) the extras every Create reads. Terminals already
// running keep their environment.
func (m *Manager) SetSpawnExtras(fn SpawnExtrasFunc) {
	if fn == nil {
		m.extras.Store(nil)
		return
	}
	m.extras.Store(&fn)
}

// spawnEnv is a terminal's environment: the daemon's, the defaults, the extras, the
// spec's own, then the extras' PATH entries in front of the resulting PATH.
func (m *Manager) spawnEnv(ctx context.Context, spec Spec) []string {
	var x SpawnExtras
	if fn := m.extras.Load(); fn != nil {
		x = (*fn)(ctx, spec.Labels)
	}
	env := mergeEnv(os.Environ(), defaultEnv, x.Env, spec.Env)
	if len(x.PathPrepend) == 0 {
		return env
	}
	path := strings.Join(x.PathPrepend, string(os.PathListSeparator))
	if cur := envValue(env, "PATH"); cur != "" {
		path += string(os.PathListSeparator) + cur
	}
	return mergeEnv(env, []string{"PATH=" + path})
}
