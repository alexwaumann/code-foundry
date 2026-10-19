package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Plugin threads (thread/create, thread/send, thread/archive, thread/list; permission
// threads; docs/notes/plugins-6-thread-terminal.md): Claude threads a plugin owns. The
// thread store keeps them like any thread, owned by "plugin:<name>", which hides them
// from the user's lists; this side checks the permission and the arguments (the env and
// add-dirs under the session environment's rules), names the owner, lets a plugin reach
// only its own threads, archives them when the plugin is disabled (or its package goes
// without an uninstall), and removes them when it is uninstalled or taken over by a
// package from another source (docs/notes/plugins-plugin-threads-remove.md). A thread's
// own env replaces its plugin's session environment for it (SessionEnvironment skips the
// owner).

// ThreadSpec is a plugin thread as the thread store makes it: Env ("KEY=VALUE") and
// AddDirs already checked.
type ThreadSpec struct {
	Title, Cwd, ProjectID, Model, Effort, Prompt string
	// PermissionMode is "" (Claude's default) or one of permissionModes.
	PermissionMode string
	Env, AddDirs   []string
}

// permissionModes are thread/create's permissionMode values (thread.new's --permission).
var permissionModes = []string{pluginsdk.PermissionModeSupervised, pluginsdk.PermissionModeAcceptEdits, pluginsdk.PermissionModeAuto}

// OwnedThreads is the thread store as plugin threads need it; the daemon adapts it (and
// fills in the user's default model and effort). Errors wrap ErrNotFound,
// ErrInvalidArgument and ErrFailedPrecondition.
type OwnedThreads interface {
	// Create makes a thread owned by owner ("plugin:<name>").
	Create(ctx context.Context, owner string, spec ThreadSpec) (pluginsdk.PluginThread, error)
	// Send sends a message (starting a stopped thread).
	Send(ctx context.Context, id, text string) error
	// Archive archives a thread (its process stops).
	Archive(ctx context.Context, id string) error
	// Remove removes a thread the way thread.remove does: its process stops first, then
	// the thread is forgotten.
	Remove(ctx context.Context, id string) error
	// Owner is a thread's owner ("" for the user's); ok false when there is no such
	// thread.
	Owner(id string) (owner string, ok bool)
	// Owned lists the threads owner owns, archived ones too, oldest first.
	Owned(owner string) []pluginsdk.PluginThread
	// LiveOwners names every owner of a thread that is not archived.
	LiveOwners() []string
}

// Limits of plugin threads.
const (
	// maxPluginThreads is how many threads a plugin may have that are not archived.
	maxPluginThreads = 32
	maxThreadTitle   = 120
	// MaxThreadMessage bounds thread/send's text.
	MaxThreadMessage = 256 << 10
	// ownedArchiveTimeout bounds archiving a plugin's threads when it is turned off, and
	// removing them when it is uninstalled or taken over.
	ownedArchiveTimeout = 20 * time.Second
)

// OwnerOf is the thread owner tag of plugin name.
func OwnerOf(name string) string { return "plugin:" + name }

// PluginOfOwner is the plugin of an owner tag, "" for any other owner.
func PluginOfOwner(owner string) string {
	name, ok := strings.CutPrefix(owner, "plugin:")
	if !ok {
		return ""
	}
	return name
}

func threadsGranted(p pluginsdk.Permissions) bool { return p.Threads }

func init() {
	for method, fn := range map[string]func(*actor, context.Context, json.RawMessage) (any, error){
		pluginsdk.MethodThreadCreate:  (*actor).threadCreate,
		pluginsdk.MethodThreadSend:    (*actor).threadSend,
		pluginsdk.MethodThreadArchive: (*actor).threadArchive,
		pluginsdk.MethodThreadList:    (*actor).threadList,
	} {
		hostMethods[method] = hostMethod{perm: threadsGranted, permName: "threads", handle: fn}
	}
	hostCapabilities = append(hostCapabilities, "threads", "view.node.thread", "act.context")
}

// ownedError maps an OwnedThreads or OwnedTerminals error to the protocol's codes.
func ownedError(method string, err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return pluginsdk.NewError(pluginsdk.CodeNotFound, "%s: %v", method, err)
	case errors.Is(err, ErrInvalidArgument):
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: %v", method, err)
	case errors.Is(err, ErrFailedPrecondition):
		return pluginsdk.NewError(pluginsdk.CodeUnavailable, "%s: %v", method, err)
	default:
		return pluginsdk.NewError(pluginsdk.CodeInternal, "%s: %v", method, err)
	}
}

// oneLine checks a title: one line of at most max bytes, required unless optional.
func oneLine(method, what, s string, max int, optional bool) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "" && !optional:
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: %s is required", method, what)
	case len(s) > max || strings.ContainsAny(s, "\x00\r\n") || !utf8.ValidString(s):
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: %s is one line of at most %d bytes", method, what, max)
	}
	return s, nil
}

// ownedCwd resolves a plugin's cwd: "~/" expanded, absolute, inside home, an existing
// directory; "" is def.
func (a *actor) ownedCwd(method, cwd, def string) (string, error) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return def, nil
	}
	p := expandHome(cwd, a.m.opts.Home)
	switch {
	case !filepath.IsAbs(p):
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: cwd %q is not an absolute path", method, cwd)
	case !withinHome(a.m.opts.Home, filepath.Clean(p)):
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: cwd %s is outside your home directory", method, p)
	}
	if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: cwd %s is not a directory", method, p)
	}
	return filepath.Clean(p), nil
}

// checkedEnv checks a plugin thread's or terminal's env and add-dirs under the session
// environment's rules: every problem refuses the call.
func (a *actor) checkedEnv(method string, env map[string]string, addDirs []string) ([]string, []string, error) {
	e, issues := validateEnvironment(a.name, pluginsdk.Environment{Env: env, AddDirs: addDirs}, a.m.opts.Home)
	if len(issues) > 0 {
		return nil, nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: %s", method, strings.Join(issues, "; "))
	}
	var kv []string
	for _, k := range slices.Sorted(maps.Keys(e.Env)) {
		kv = append(kv, k+"="+e.Env[k])
	}
	return kv, e.AddDirs, nil
}

// dataDir is the plugin's data dir, made when missing.
func (a *actor) dataDir() (string, error) {
	d := filepath.Join(a.m.opts.DataDir, a.name)
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", pluginsdk.NewError(pluginsdk.CodeInternal, "data dir: %v", err)
	}
	return d, nil
}

// ownThread checks that id is one of the plugin's threads.
func (a *actor) ownThread(method, id string) error {
	threads := a.m.opts.Threads
	if id == "" {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: threadId is required", method)
	}
	if owner, ok := threads.Owner(id); !ok || owner != OwnerOf(a.name) {
		return pluginsdk.NewError(pluginsdk.CodeNotFound, "%s: thread %s is not one of plugin %s's threads", method, id, a.name)
	}
	return nil
}

// threadCreate serves thread/create.
func (a *actor) threadCreate(ctx context.Context, params json.RawMessage) (any, error) {
	const method = pluginsdk.MethodThreadCreate
	threads := a.m.opts.Threads
	if threads == nil {
		return nil, notServed(method)
	}
	p, err := decodeParams[pluginsdk.ThreadCreateParams](method, params)
	if err != nil {
		return nil, err
	}
	title, err := oneLine(method, "title", p.Title, maxThreadTitle, false)
	if err != nil {
		return nil, err
	}
	if len(p.Prompt) > MaxThreadMessage {
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: prompt is at most %d bytes", method, MaxThreadMessage)
	}
	mode := strings.TrimSpace(p.PermissionMode)
	if mode != "" && !slices.Contains(permissionModes, mode) {
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: permissionMode %q (want one of %s)", method, mode, strings.Join(permissionModes, ", "))
	}
	env, dirs, err := a.checkedEnv(method, p.Env, p.AddDirs)
	if err != nil {
		return nil, err
	}
	def := ""
	if p.ProjectID == "" {
		if def, err = a.dataDir(); err != nil {
			return nil, err
		}
	}
	cwd, err := a.ownedCwd(method, p.Cwd, def)
	if err != nil {
		return nil, err
	}
	// Count and create under one lock: concurrent creates would each see room.
	a.ownedMu.Lock()
	defer a.ownedMu.Unlock()
	live := 0
	for _, t := range threads.Owned(OwnerOf(a.name)) {
		if !t.Archived {
			live++
		}
	}
	if live >= maxPluginThreads {
		return nil, pluginsdk.NewError(pluginsdk.CodeRateLimited, "%s: at most %d threads that are not archived (archive one first)", method, maxPluginThreads)
	}
	t, err := threads.Create(ctx, OwnerOf(a.name), ThreadSpec{
		Title: title, Cwd: cwd, ProjectID: strings.TrimSpace(p.ProjectID), Model: strings.TrimSpace(p.Model),
		Effort: strings.TrimSpace(p.Effort), PermissionMode: mode, Prompt: p.Prompt, Env: env, AddDirs: dirs,
	})
	if err != nil {
		a.hostLog("refused thread/create: %v", err)
		return nil, ownedError(method, err)
	}
	keys := make([]string, len(env))
	for i, kv := range env {
		keys[i], _, _ = strings.Cut(kv, "=")
	}
	a.hostLog("thread created: %s %q in %s (env %s; add-dirs %d)", t.ThreadID, title, t.Cwd, orNone(keys), len(dirs))
	a.m.log.Info("plugin thread created", "plugin", a.name, "thread", t.ThreadID, "keys", keys, "add_dirs", len(dirs))
	return pluginsdk.ThreadCreateResult{ThreadID: t.ThreadID}, nil
}

// threadSend serves thread/send.
func (a *actor) threadSend(ctx context.Context, params json.RawMessage) (any, error) {
	const method = pluginsdk.MethodThreadSend
	if a.m.opts.Threads == nil {
		return nil, notServed(method)
	}
	p, err := decodeParams[pluginsdk.ThreadSendParams](method, params)
	if err != nil {
		return nil, err
	}
	switch {
	case strings.TrimSpace(p.Text) == "":
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: text is required", method)
	case len(p.Text) > MaxThreadMessage:
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: text is at most %d bytes", method, MaxThreadMessage)
	}
	if err := a.ownThread(method, p.ThreadID); err != nil {
		return nil, err
	}
	if err := a.m.opts.Threads.Send(ctx, p.ThreadID, p.Text); err != nil {
		return nil, ownedError(method, err)
	}
	a.hostLog("thread/send %s (%d bytes)", p.ThreadID, len(p.Text))
	return struct{}{}, nil
}

// threadArchive serves thread/archive.
func (a *actor) threadArchive(ctx context.Context, params json.RawMessage) (any, error) {
	const method = pluginsdk.MethodThreadArchive
	if a.m.opts.Threads == nil {
		return nil, notServed(method)
	}
	p, err := decodeParams[pluginsdk.ThreadRef](method, params)
	if err != nil {
		return nil, err
	}
	if err := a.ownThread(method, p.ThreadID); err != nil {
		return nil, err
	}
	if err := a.m.opts.Threads.Archive(ctx, p.ThreadID); err != nil {
		return nil, ownedError(method, err)
	}
	a.hostLog("thread archived: %s", p.ThreadID)
	return struct{}{}, nil
}

// threadList serves thread/list.
func (a *actor) threadList(context.Context, json.RawMessage) (any, error) {
	if a.m.opts.Threads == nil {
		return nil, notServed(pluginsdk.MethodThreadList)
	}
	list := a.m.opts.Threads.Owned(OwnerOf(a.name))
	if list == nil {
		list = []pluginsdk.PluginThread{}
	}
	return pluginsdk.ThreadListResult{Threads: list}, nil
}

// Threads returns plugin name's threads (the CLI's plugin threads), archived ones too.
func (m *Manager) Threads(name string) ([]pluginsdk.PluginThread, error) {
	if _, ok := m.Snapshot().Plugin(name); !ok && !slices.Contains(m.liveThreadOwners(), name) {
		return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	if m.opts.Threads == nil {
		return nil, nil
	}
	return m.opts.Threads.Owned(OwnerOf(name)), nil
}

// liveThreadOwners names the plugins with a thread that is not archived.
func (m *Manager) liveThreadOwners() []string {
	if m.opts.Threads == nil {
		return nil
	}
	var out []string
	for _, o := range m.opts.Threads.LiveOwners() {
		if name := PluginOfOwner(o); name != "" {
			out = append(out, name)
		}
	}
	return out
}

// archiveThreads archives a plugin's threads that are not archived (it was disabled or
// removed), all at once.
func (m *Manager) archiveThreads(ctx context.Context, name string, logs *logBuffer) {
	threads := m.opts.Threads
	if threads == nil {
		return
	}
	var live []string
	for _, t := range threads.Owned(OwnerOf(name)) {
		if !t.Archived {
			live = append(live, t.ThreadID)
		}
	}
	if len(live) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ownedArchiveTimeout)
	defer cancel()
	var wg sync.WaitGroup
	var mu sync.Mutex
	n := 0
	for _, id := range live {
		wg.Go(func() {
			if err := threads.Archive(ctx, id); err != nil {
				m.log.Warn("plugin: archive its thread", "plugin", name, "thread", id, "err", err)
				return
			}
			mu.Lock()
			n++
			mu.Unlock()
		})
	}
	wg.Wait()
	if n > 0 && logs != nil {
		logs.add("host", "", fmt.Sprintf("archived its threads: %d", n))
	}
	m.log.Info("plugin threads archived", "plugin", name, "count", n)
}

// removeThreads removes every thread of a plugin, archived ones too (it was uninstalled
// or taken over by a package from another source), all at once, through the thread
// store's Remove: Claude stops first. It returns the ids removed, oldest thread first.
func (m *Manager) removeThreads(ctx context.Context, name string, logs *logBuffer) []string {
	threads := m.opts.Threads
	if threads == nil {
		return nil
	}
	all := threads.Owned(OwnerOf(name))
	if len(all) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ownedArchiveTimeout)
	defer cancel()
	done := make([]bool, len(all))
	var wg sync.WaitGroup
	for i, t := range all {
		wg.Go(func() {
			if err := threads.Remove(ctx, t.ThreadID); err != nil {
				m.log.Warn("plugin: remove its thread", "plugin", name, "thread", t.ThreadID, "err", err)
				return
			}
			done[i] = true
		})
	}
	wg.Wait()
	var removed []string
	for i, t := range all {
		if done[i] {
			removed = append(removed, t.ThreadID)
		}
	}
	if len(removed) > 0 && logs != nil {
		logs.add("host", "", "removed its threads: "+strings.Join(removed, ", "))
	}
	m.log.Info("plugin threads removed", "plugin", name, "count", len(removed), "of", len(all))
	return removed
}

// threadsWords is "its N thread(s)", for messages.
func threadsWords(n int) string {
	if n == 1 {
		return "its 1 thread"
	}
	return fmt.Sprintf("its %d threads", n)
}

// ownedNodeProblems are a view's thread and terminal nodes that name another owner's
// thread or terminal. An id the host does not know passes (the GUI shows it gone).
func (a *actor) ownedNodeProblems(v *ui.View) []string {
	var errs []string
	walkNodes(v.Nodes, func(n *ui.Node) {
		switch {
		case n.Thread != nil && a.m.opts.Threads != nil:
			if owner, ok := a.m.opts.Threads.Owner(n.Thread.ThreadID); ok && owner != OwnerOf(a.name) {
				errs = append(errs, fmt.Sprintf("%s: thread %s is not one of plugin %s's threads (thread/create)", n.Key, n.Thread.ThreadID, a.name))
			}
		case n.Terminal != nil && a.m.opts.Terminals != nil:
			if owner, ok := a.m.opts.Terminals.Owner(n.Terminal.TerminalID); ok && owner != a.name {
				errs = append(errs, fmt.Sprintf("%s: terminal %s is not one of plugin %s's terminals (terminal/create)", n.Key, n.Terminal.TerminalID, a.name))
			}
		}
	})
	return errs
}
