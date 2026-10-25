package thread

import (
	"context"
	"os"
	"slices"
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
	// Owner is the thread's owner ("plugin:<name>"; Thread.Owner): that plugin's session
	// environment is left out, since the thread brings its own (Thread.SpawnEnv).
	Owner string
	// Wait allows a short wait for a contributor still starting (spawn: true; the effort
	// restart runs on the runner goroutine and passes false: it must never block).
	Wait bool
	// Probe: not a spawn but the staleness check (envstale.go), which compares what a
	// running process got with what a spawn would get now. Never waits; no log lines.
	Probe bool
}

// SpawnExtras is a contribution: environment entries ("KEY=VALUE", merged after the
// daemon's and the workspace's), PATH entries (prepended, in order) and --add-dir
// directories (after the skills dir, before the attachments dir).
type SpawnExtras struct {
	Env         []string
	PathPrepend []string
	AddDirs     []string
	// Sources are the same entries by contributor (a plugin), for the staleness
	// fingerprint and its summary (envstale.go); the store hashes the values and never
	// keeps them. Without Sources, a contribution counts as one unnamed source.
	Sources []ExtrasSource
}

// ExtrasSource is one contributor's part of SpawnExtras.
type ExtrasSource struct {
	// ID identifies the contributor (a plugin's name); Name is what the summary calls it
	// (its display name).
	ID, Name             string
	Env                  []string // "KEY=VALUE"
	PathPrepend, AddDirs []string
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

// SpawnInfo is the SpawnInfo a spawn of thread id would pass now (no wait), for others
// that start processes in the thread's scope: its bottom-panel shells get the plugins'
// environment through the daemon's terminal hook. False for an unknown thread.
func (m *Manager) SpawnInfo(id string) (SpawnInfo, bool) {
	s, ok := m.Snapshot().Thread(id)
	if !ok {
		return SpawnInfo{}, false
	}
	return spawnInfoOf(s, m.memberProjects(s), false), true
}

// memberProjects is the projects of a multi-project thread's set and of a referenced
// workspace's members (the cwd's included), sorted, as a spawn passes them; nil for a
// single-project thread without a workspace (or whose workspace is gone).
func (m *Manager) memberProjects(s Thread) []string {
	var ids []string
	if set := s.Projects(); len(set) > 1 {
		ids = set
	}
	if s.WorkspaceID != "" && m.opts.Workspaces != nil {
		if wl, ok := workspaceLaunch(m.opts.Workspaces.Snapshot(), s.WorkspaceID, s.WorktreePath, isDir); ok {
			ids = CleanProjectIDs("", append(slices.Clone(ids), wl.projects...))
		}
	}
	return ids
}

// spawnInfoOf is SpawnInfo for s (the workspace's members as snap has them).
func spawnInfoOf(s Thread, members []string, wait bool) SpawnInfo {
	return SpawnInfo{
		ThreadID: s.ID, ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, MemberProjectIDs: members,
		NoProject: s.ProjectID == "" && s.WorkspaceID == "", Wait: wait, Owner: s.Owner,
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
