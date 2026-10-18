package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The session environment hook (session/setEnvironment, permission sessionEnv;
// docs/notes/plugins-3-events-flags-env.md, design ARCHITECTURE.md §C.7): a plugin
// pushes what new Claude threads get, environment variables, PATH entries and --add-dir
// directories, optionally limited to some projects, whenever it changes. The store
// validates it, keeps it in memory and in SQLite (the last push per plugin, so a daemon
// restart spawns with it before the plugin pushes again), and the thread store reads it
// at every spawn through SessionEnvironment (the daemon's spawn extras): a map lookup,
// except that a spawn may wait up to EnvWait for a plugin still starting. Plugins apply
// in name order; a key an earlier plugin sets is dropped with an issue. Disabling or
// removing the plugin drops its contribution; running threads keep what they spawned
// with. Values are never logged, only keys.

// Limits of a contribution.
const (
	DefaultEnvWait  = 2 * time.Second
	MaxEnvValue     = 8 << 10
	maxEnvKeys      = 64
	maxEnvDirs      = 16
	maxScopeEntries = 256
	// envSettle is how long after initialized a starting plugin counts as having had
	// its chance to push (its Init runs then).
	envSettle = 500 * time.Millisecond
)

// reservedEnv are keys no plugin may set; reservedEnvPrefixes are prefixes.
var (
	reservedEnv         = []string{"CLAUDECODE", "CLAUDE_CONFIG_DIR", "CLAUDE_EFFORT", "PATH", "HOME", "SHELL", "USER", "TMPDIR"}
	reservedEnvPrefixes = []string{"CODE_FOUNDRY_", "CLAUDE_CODE_"}
	envKeyPattern       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// reservedEnvKey reports whether key is the daemon's or Claude's, in any case (macOS
// variables are case-sensitive, but a shell or tool may not be: "path" is zsh's PATH).
func reservedEnvKey(key string) bool {
	key = strings.ToUpper(key)
	if slices.Contains(reservedEnv, key) {
		return true
	}
	return slices.ContainsFunc(reservedEnvPrefixes, func(p string) bool { return strings.HasPrefix(key, p) })
}

// withinHome reports whether the clean absolute path p is inside home, also once
// symlinks are resolved: a link under home that points outside it is outside. A path
// that does not exist (yet) is judged as written.
func withinHome(home, p string) bool {
	if home == "" {
		return true
	}
	if !fsx.Within(home, p) {
		return false
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return true
	}
	if rh, err := filepath.EvalSymlinks(home); err == nil {
		home = rh
	}
	return fsx.Within(home, real)
}

// Environment is one plugin's contribution as applied: what was refused or lost to an
// earlier plugin is in Issues, not in the fields.
type Environment struct {
	Plugin      string
	Env         map[string]string
	PathPrepend []string
	AddDirs     []string
	// Projects limits it to threads of these projects (the cwd's or any workspace
	// member's); empty means every project. NoProject adds threads without a project.
	Projects  []string
	NoProject bool
	Issues    []string
	UpdatedAt time.Time
}

// SpawnScope says which thread is spawning (SessionEnvironment).
type SpawnScope struct {
	ThreadID, ProjectID string
	MemberProjectIDs    []string
	NoProject           bool
	// Owner is the thread's owner: a plugin's own thread does not get that plugin's
	// session environment (it has its own; threads.go).
	Owner string
}

// Contribution is what a spawn gets from every plugin: "KEY=VALUE" entries, PATH
// entries and --add-dir directories, in plugin name order.
type Contribution struct {
	Env, PathPrepend, AddDirs []string
}

// envState is the contributions by plugin. Guarded by mu.
type envState struct {
	mu   sync.Mutex
	byID map[string]Environment // validated, before conflicts
}

func sessionEnvGranted(p pluginsdk.Permissions) bool { return p.SessionEnv }

func init() {
	hostMethods[pluginsdk.MethodSetEnvironment] = hostMethod{perm: sessionEnvGranted, permName: "sessionEnv", handle: (*actor).setEnvironment}
	hostCapabilities = append(hostCapabilities, "sessionEnv")
}

// expandHome turns a leading "~/" into home.
func expandHome(p, home string) string {
	if p == "~" {
		return home
	}
	if rest, ok := strings.CutPrefix(p, "~/"); ok && home != "" {
		return filepath.Join(home, rest)
	}
	return p
}

// validateEnvironment checks a pushed contribution against the rules (reserved keys,
// value size, dirs absolute and under home, add-dirs existing) and returns what applies
// and the issues, in a fixed order.
func validateEnvironment(name string, in pluginsdk.Environment, home string) (Environment, []string) {
	out := Environment{Plugin: name}
	var issues []string
	keys := slices.Sorted(maps.Keys(in.Env))
	for _, k := range keys {
		v := in.Env[k]
		switch {
		case !envKeyPattern.MatchString(k):
			issues = append(issues, fmt.Sprintf("env %q is not a variable name", k))
		case reservedEnvKey(k):
			issues = append(issues, fmt.Sprintf("env %s is reserved for Code Foundry and Claude", k))
		case len(v) > MaxEnvValue:
			issues = append(issues, fmt.Sprintf("env %s is %d bytes; at most %d", k, len(v), MaxEnvValue))
		case strings.ContainsRune(v, 0) || !utf8.ValidString(v):
			issues = append(issues, fmt.Sprintf("env %s is not text", k))
		case len(out.Env) >= maxEnvKeys:
			issues = append(issues, fmt.Sprintf("env %s: at most %d variables", k, maxEnvKeys))
		default:
			if out.Env == nil {
				out.Env = map[string]string{}
			}
			out.Env[k] = v
		}
	}
	dirs := func(what string, list []string, mustExist bool) []string {
		var ok []string
		for _, d := range list {
			p := expandHome(strings.TrimSpace(d), home)
			switch {
			case !filepath.IsAbs(p):
				issues = append(issues, fmt.Sprintf("%s %q is not an absolute path", what, d))
				continue
			case strings.ContainsAny(p, ":\x00\n"):
				issues = append(issues, fmt.Sprintf("%s %q has a character a path list cannot hold", what, d))
				continue
			}
			p = filepath.Clean(p)
			if !withinHome(home, p) {
				issues = append(issues, fmt.Sprintf("%s %s is outside your home directory", what, p))
				continue
			}
			if mustExist {
				if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
					issues = append(issues, fmt.Sprintf("%s %s is not a directory", what, p))
					continue
				}
			}
			if slices.Contains(ok, p) {
				continue
			}
			if len(ok) >= maxEnvDirs {
				issues = append(issues, fmt.Sprintf("%s %s: at most %d", what, p, maxEnvDirs))
				continue
			}
			ok = append(ok, p)
		}
		return ok
	}
	out.PathPrepend = dirs("pathPrepend", in.PathPrepend, false)
	out.AddDirs = dirs("addDirs", in.AddDirs, true)
	if in.Scope != nil {
		for _, p := range in.Scope.Projects {
			p = strings.TrimSpace(p)
			if p != "" && !slices.Contains(out.Projects, p) && len(out.Projects) < maxScopeEntries {
				out.Projects = append(out.Projects, p)
			}
		}
		out.NoProject = in.Scope.NoProject
	}
	return out, issues
}

// empty reports whether e contributes nothing.
func (e Environment) empty() bool {
	return len(e.Env) == 0 && len(e.PathPrepend) == 0 && len(e.AddDirs) == 0
}

// matches reports whether e applies to a spawn in scope.
func (e Environment) matches(s SpawnScope) bool {
	if s.NoProject {
		return e.NoProject
	}
	if len(e.Projects) == 0 {
		return true
	}
	return slices.Contains(e.Projects, s.ProjectID) || slices.ContainsFunc(s.MemberProjectIDs, func(id string) bool { return slices.Contains(e.Projects, id) })
}

// resolve applies plugins' contributions in name order: a key set by an earlier plugin
// is dropped from a later one, which gets an issue. envs is sorted by plugin.
func resolve(envs []Environment) []Environment {
	owner := map[string]string{}
	out := make([]Environment, len(envs))
	for i, e := range envs {
		e.Env = maps.Clone(e.Env)
		e.Issues = slices.Clone(e.Issues)
		for _, k := range slices.Sorted(maps.Keys(e.Env)) {
			if o, ok := owner[k]; ok {
				delete(e.Env, k)
				e.Issues = append(e.Issues, fmt.Sprintf("env %s is also set by plugin %s, which applies first (plugins apply in name order)", k, o))
				continue
			}
			owner[k] = e.Plugin
		}
		out[i] = e
	}
	return out
}

// setEnvironment serves session/setEnvironment.
func (a *actor) setEnvironment(ctx context.Context, params json.RawMessage) (any, error) {
	in, err := decodeParams[pluginsdk.Environment](pluginsdk.MethodSetEnvironment, params)
	if err != nil {
		return nil, err
	}
	m := a.m
	e, issues := validateEnvironment(a.name, in, m.opts.Home)
	e.Issues, e.UpdatedAt = issues, m.opts.Now().Truncate(time.Millisecond)
	if e.empty() && len(issues) == 0 {
		if err := m.dropEnvironment(ctx, a.name); err != nil {
			return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
		}
		a.hostLog("session environment withdrawn")
		a.envPushed()
		return pluginsdk.EnvironmentResult{Applied: true}, nil
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%v", err)
	}
	if _, err := m.opts.DB.ExecContext(ctx, `INSERT INTO plugin_environments (plugin, env_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (plugin) DO UPDATE SET env_json = excluded.env_json, updated_at = excluded.updated_at`,
		a.name, string(raw), e.UpdatedAt.UnixMilli()); err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "plugin: save environment: %v", err)
	}
	m.env.mu.Lock()
	if m.env.byID == nil {
		m.env.byID = map[string]Environment{}
	}
	m.env.byID[a.name] = e
	m.env.mu.Unlock()
	a.envPushed()
	applied, _ := m.environment(a.name)
	keys := slices.Sorted(maps.Keys(applied.Env))
	a.hostLog("session environment: env %s; path %d; add-dirs %d; %s", orNone(keys), len(applied.PathPrepend), len(applied.AddDirs), scopeText(applied))
	for _, is := range applied.Issues {
		a.hostLog("session environment issue: %s", is)
	}
	m.log.Info("plugin session environment", "plugin", a.name, "keys", keys, "path", len(applied.PathPrepend),
		"add_dirs", len(applied.AddDirs), "issues", len(applied.Issues))
	return pluginsdk.EnvironmentResult{Applied: true, Issues: applied.Issues}, nil
}

func orNone(keys []string) string {
	if len(keys) == 0 {
		return "none"
	}
	return strings.Join(keys, ", ")
}

func scopeText(e Environment) string {
	s := "every project"
	if len(e.Projects) > 0 {
		s = "projects " + strings.Join(e.Projects, ", ")
	}
	if e.NoProject {
		s += " and threads without a project"
	}
	return s
}

// envPushed marks the run's first push: a spawn waiting for it goes ahead.
func (a *actor) envPushed() {
	a.mu.Lock()
	ch := a.envReady
	a.mu.Unlock()
	closeOnce(ch)
}

// closeOnce closes ch unless it is nil or closed.
func closeOnce(ch chan struct{}) {
	if ch == nil {
		return
	}
	select {
	case <-ch:
	default:
		close(ch)
	}
}

// Environments returns the plugins' contributions as applied (name: that plugin's only),
// by plugin name.
func (m *Manager) Environments(name string) ([]Environment, error) {
	all := m.resolved()
	if name == "" {
		return all, nil
	}
	if _, ok := m.Snapshot().Plugin(name); !ok {
		return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	i := slices.IndexFunc(all, func(e Environment) bool { return e.Plugin == name })
	if i < 0 {
		return nil, nil
	}
	return all[i : i+1], nil
}

// environment is one plugin's applied contribution.
func (m *Manager) environment(name string) (Environment, bool) {
	all := m.resolved()
	i := slices.IndexFunc(all, func(e Environment) bool { return e.Plugin == name })
	if i < 0 {
		return Environment{}, false
	}
	return all[i], true
}

// resolved is every live contribution (an enabled plugin granted sessionEnv), applied
// in name order.
func (m *Manager) resolved() []Environment {
	snap := m.Snapshot()
	m.env.mu.Lock()
	var envs []Environment
	for name, e := range m.env.byID {
		if p, ok := snap.Plugin(name); ok && p.Enabled && p.Granted != nil && p.Granted.SessionEnv && p.Manifest.Permissions.SessionEnv {
			envs = append(envs, e)
		}
	}
	m.env.mu.Unlock()
	slices.SortFunc(envs, func(a, b Environment) int { return strings.Compare(a.Plugin, b.Plugin) })
	return resolve(envs)
}

// SessionEnvironment is what a spawn in scope gets from every plugin, in name order. With
// wait it first waits, at most EnvWait, for plugins that declare sessionEnv and are
// still starting to push (or settle). Never values in the log.
func (m *Manager) SessionEnvironment(ctx context.Context, scope SpawnScope, wait bool) Contribution {
	if wait {
		m.waitEnvironments(ctx, scope.ThreadID)
	}
	var c Contribution
	var names []string
	for _, e := range m.resolved() {
		if !e.matches(scope) || (scope.Owner != "" && scope.Owner == OwnerOf(e.Plugin)) {
			// A plugin's own thread brings its own env (thread/create) instead.
			continue
		}
		names = append(names, e.Plugin)
		for _, k := range slices.Sorted(maps.Keys(e.Env)) {
			c.Env = append(c.Env, k+"="+e.Env[k])
		}
		c.PathPrepend = append(c.PathPrepend, e.PathPrepend...)
		for _, d := range e.AddDirs {
			if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
				m.log.Warn("plugin add-dir is gone; not passed to claude", "plugin", e.Plugin, "dir", d, "thread", scope.ThreadID)
				continue
			}
			if !slices.Contains(c.AddDirs, d) {
				c.AddDirs = append(c.AddDirs, d)
			}
		}
	}
	if len(names) > 0 {
		keys := make([]string, len(c.Env))
		for i, kv := range c.Env {
			keys[i], _, _ = strings.Cut(kv, "=")
		}
		m.log.Info("plugin session environment for a spawn", "thread", scope.ThreadID, "plugins", names, "keys", keys,
			"path", len(c.PathPrepend), "add_dirs", len(c.AddDirs))
	}
	return c
}

// waitEnvironments waits, at most EnvWait, for every enabled plugin declaring sessionEnv
// whose current run has not pushed or settled yet.
func (m *Manager) waitEnvironments(ctx context.Context, thread string) {
	type pending struct {
		name  string
		ready chan struct{}
	}
	var wait []pending
	m.mu.Lock()
	for name, e := range m.entries {
		if e.actor == nil || !e.manifest.Permissions.SessionEnv || e.row.Granted == nil || !e.row.Granted.SessionEnv {
			continue
		}
		if e.state != StateStarting && e.state != StateRunning {
			continue
		}
		e.actor.mu.Lock()
		ch := e.actor.envReady
		e.actor.mu.Unlock()
		if ch == nil {
			continue
		}
		select {
		case <-ch:
		default:
			wait = append(wait, pending{name, ch})
		}
	}
	m.mu.Unlock()
	if len(wait) == 0 {
		return
	}
	limit := m.opts.EnvWait
	if limit <= 0 {
		limit = DefaultEnvWait
	}
	t := time.NewTimer(limit)
	defer t.Stop()
	for _, p := range wait {
		select {
		case <-p.ready:
		case <-ctx.Done():
			return
		case <-t.C:
			m.log.Warn("spawning without waiting longer for a starting plugin's session environment", "plugin", p.name, "thread", thread, "waited", limit.String())
			return
		}
	}
}

// dropEnvironment forgets a plugin's contribution.
func (m *Manager) dropEnvironment(ctx context.Context, name string) error {
	m.env.mu.Lock()
	delete(m.env.byID, name)
	m.env.mu.Unlock()
	if _, err := m.opts.DB.ExecContext(ctx, `DELETE FROM plugin_environments WHERE plugin = ?`, name); err != nil {
		return fmt.Errorf("plugin: drop environment: %w", err)
	}
	return nil
}

// loadEnvironments reads the persisted contributions (validated again: home and the
// add-dirs may have changed).
func (m *Manager) loadEnvironments(ctx context.Context) error {
	rows, err := m.opts.DB.QueryContext(ctx, `SELECT plugin, env_json, updated_at FROM plugin_environments`)
	if err != nil {
		return fmt.Errorf("plugin: load environments: %w", err)
	}
	defer func() { _ = rows.Close() }()
	byID := map[string]Environment{}
	for rows.Next() {
		var name, js string
		var at int64
		if err := rows.Scan(&name, &js, &at); err != nil {
			return fmt.Errorf("plugin: load environments: %w", err)
		}
		var in pluginsdk.Environment
		if err := json.Unmarshal([]byte(js), &in); err != nil {
			m.log.Warn("plugin: unreadable saved environment", "plugin", name, "err", err)
			continue
		}
		e, issues := validateEnvironment(name, in, m.opts.Home)
		e.Issues, e.UpdatedAt = issues, time.UnixMilli(at)
		byID[name] = e
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("plugin: load environments: %w", err)
	}
	m.env.mu.Lock()
	m.env.byID = byID
	m.env.mu.Unlock()
	return nil
}

// forget drops what a disabled or removed plugin left behind: its session environment
// and its flags on threads; it archives its threads and closes its terminals
// (threads.go, terminals.go). Its secrets and consent stay.
func (m *Manager) forget(ctx context.Context, name string, logs *logBuffer) {
	m.archiveThreads(ctx, name, logs)
	m.closeTerminals(ctx, name, logs)
	m.env.mu.Lock()
	_, had := m.env.byID[name]
	m.env.mu.Unlock()
	if err := m.dropEnvironment(ctx, name); err != nil {
		m.log.Warn("plugin: drop environment", "plugin", name, "err", err)
	} else if had && logs != nil {
		logs.add("host", "", "session environment dropped: new threads no longer get it")
	}
	m.clearFlags(ctx, name, logs)
}

// sweep forgets the environments, flags and threads of plugins that are not enabled
// (disabled or removed while the daemon was stopped).
func (m *Manager) sweep(ctx context.Context) {
	snap := m.Snapshot()
	enabled := func(name string) bool {
		p, ok := snap.Plugin(name)
		return ok && p.Enabled
	}
	m.env.mu.Lock()
	var gone []string
	for name := range m.env.byID {
		if !enabled(name) {
			gone = append(gone, name)
		}
	}
	m.env.mu.Unlock()
	if m.opts.Flags != nil {
		for _, name := range m.opts.Flags.Plugins() {
			if !enabled(name) && !slices.Contains(gone, name) {
				gone = append(gone, name)
			}
		}
	}
	for _, name := range m.liveThreadOwners() {
		if !enabled(name) && !slices.Contains(gone, name) {
			gone = append(gone, name)
		}
	}
	for _, name := range gone {
		m.forget(ctx, name, nil)
	}
}
