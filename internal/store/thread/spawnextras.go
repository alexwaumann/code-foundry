package thread

import (
	"context"
	"os"
	"strings"
)

// Spawn extras are what others contribute to every claude spawn (create, a start on
// send, fork, the effort restart): plugins' session environment (session/setEnvironment,
// docs/notes/plugins-3-events-flags-env.md). They join claudeCommand's one path beside
// the daemon's own skills --add-dir, never a parallel one. Naming (ClaudeNamer,
// --safe-mode) and shells never get them.

// SpawnInfo says which thread is spawning, for the extras' scope.
type SpawnInfo struct {
	ThreadID string
	// ProjectID is the cwd's project; WorkspaceID the owner workspace, MemberProjectIDs
	// its members' projects (the cwd's included). NoProject: a thread without a project
	// (both empty), running in the home directory.
	ProjectID        string
	WorkspaceID      string
	MemberProjectIDs []string
	NoProject        bool
	// Wait allows a short wait for a contributor still starting (spawn: true; the effort
	// restart runs on the runner goroutine and passes false: it must never block).
	Wait bool
}

// SpawnExtras is a contribution: environment entries ("KEY=VALUE", merged after the
// daemon's and the workspace's), PATH entries (prepended, in order) and --add-dir
// directories (after the skills dir, before the attachments dir).
type SpawnExtras struct {
	Env         []string
	PathPrepend []string
	AddDirs     []string
}

// SpawnExtrasFunc returns the extras for a spawn. It must return at once unless
// in.Wait, and then within a couple of seconds.
type SpawnExtrasFunc func(ctx context.Context, in SpawnInfo) SpawnExtras

// SetSpawnExtras sets (nil: removes) the extras every spawn reads. The daemon sets it
// once the plugin store exists.
func (m *Manager) SetSpawnExtras(fn SpawnExtrasFunc) {
	if fn == nil {
		m.spawnExtras.Store(nil)
		return
	}
	m.spawnExtras.Store(&fn)
}

// spawnInfoOf is SpawnInfo for s (the workspace's members as snap has them).
func spawnInfoOf(s Thread, members []string, wait bool) SpawnInfo {
	return SpawnInfo{
		ThreadID: s.ID, ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, MemberProjectIDs: members,
		NoProject: s.ProjectID == "" && s.WorkspaceID == "", Wait: wait,
	}
}

// extras returns the spawn's extras; none without a SpawnExtrasFunc.
func (m *Manager) extras(ctx context.Context, in SpawnInfo) SpawnExtras {
	fn := m.spawnExtras.Load()
	if fn == nil {
		return SpawnExtras{}
	}
	return (*fn)(ctx, in)
}

// prependPath is the PATH entry for env (the environment entries a spawn adds to the
// daemon's own, osPath) with dirs in front: "" when dirs is empty.
func prependPath(env []string, dirs []string, osPath string) string {
	if len(dirs) == 0 {
		return ""
	}
	base := osPath
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			base = v
		}
	}
	p := strings.Join(dirs, string(os.PathListSeparator))
	if base != "" {
		p += string(os.PathListSeparator) + base
	}
	return "PATH=" + p
}
