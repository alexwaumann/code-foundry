package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Plugin terminals (terminal/create, terminal/close, terminal/list; permission
// terminals; docs/notes/plugins-6-thread-terminal.md): terminals a plugin owns, labelled
// for it (termlabel.PluginTerminal) by the daemon's adapter. The terminal store keeps
// them in memory, so they end with the daemon like every shell. This side checks the
// permission and the arguments (env under the session environment's rules, cwd under
// home), lets a plugin reach only its own, and closes them when the plugin is disabled
// or removed. A plugin's crash or restart leaves them running (terminal/list finds them).

// TerminalSpec is a plugin terminal as the terminal store starts it: Env ("KEY=VALUE")
// already checked.
type TerminalSpec struct {
	Argv  []string
	Cwd   string
	Env   []string
	Title string
}

// OwnedTerminals is the terminal store as plugin terminals need it; the daemon adapts it.
// Errors wrap ErrNotFound and ErrInvalidArgument.
type OwnedTerminals interface {
	// Create starts a terminal plugin owns.
	Create(ctx context.Context, plugin string, spec TerminalSpec) (pluginsdk.PluginTerminal, error)
	// Close kills a terminal and forgets it.
	Close(ctx context.Context, id string) error
	// Owner is the plugin owning a terminal ("" for any other); ok false when there is
	// no such terminal.
	Owner(id string) (plugin string, ok bool)
	// Owned lists plugin's terminals.
	Owned(plugin string) []pluginsdk.PluginTerminal
	// Text is a terminal's screen as plain text (its rows, not the scrollback), one line
	// per row, trailing spaces trimmed.
	Text(ctx context.Context, id string) (string, error)
}

// Limits of plugin terminals.
const (
	maxPluginTerminals = 16
	maxTerminalArgv    = 64 << 10
	maxTerminalTitle   = 80
	// terminal/read's text: by default, and at most.
	defaultTerminalRead = 64 << 10
	maxTerminalRead     = 256 << 10
)

func terminalsGranted(p pluginsdk.Permissions) bool { return p.Terminals }

func init() {
	for method, fn := range map[string]func(*actor, context.Context, json.RawMessage) (any, error){
		pluginsdk.MethodTerminalCreate: (*actor).terminalCreate,
		pluginsdk.MethodTerminalClose:  (*actor).terminalClose,
		pluginsdk.MethodTerminalList:   (*actor).terminalList,
		pluginsdk.MethodTerminalRead:   (*actor).terminalRead,
	} {
		hostMethods[method] = hostMethod{perm: terminalsGranted, permName: "terminals", handle: fn}
	}
	hostCapabilities = append(hostCapabilities, "terminals", "view.node.terminal", "terminal.read", "terminal.exited")
}

// terminalCreate serves terminal/create.
func (a *actor) terminalCreate(ctx context.Context, params json.RawMessage) (any, error) {
	const method = pluginsdk.MethodTerminalCreate
	terms := a.m.opts.Terminals
	if terms == nil {
		return nil, notServed(method)
	}
	p, err := decodeParams[pluginsdk.TerminalCreateParams](method, params)
	if err != nil {
		return nil, err
	}
	size := 0
	for _, s := range p.Argv {
		size += len(s) + 1 // its NUL in exec's argv: a million empty args are not free
		if strings.ContainsRune(s, 0) {
			return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: argv has a NUL byte", method)
		}
	}
	switch {
	case len(p.Argv) == 0 || strings.TrimSpace(p.Argv[0]) == "":
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: argv is required", method)
	case size > maxTerminalArgv:
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: argv is at most %d bytes", method, maxTerminalArgv)
	}
	title, err := oneLine(method, "title", p.Title, maxTerminalTitle, true)
	if err != nil {
		return nil, err
	}
	if title == "" {
		title = filepath.Base(p.Argv[0])
	}
	env, _, err := a.checkedEnv(method, p.Env, nil)
	if err != nil {
		return nil, err
	}
	def, err := a.dataDir()
	if err != nil {
		return nil, err
	}
	cwd, err := a.ownedCwd(method, p.Cwd, def)
	if err != nil {
		return nil, err
	}
	a.ownedMu.Lock() // count and create under one lock (threads.go)
	defer a.ownedMu.Unlock()
	if n := len(terms.Owned(a.name)); n >= maxPluginTerminals {
		return nil, pluginsdk.NewError(pluginsdk.CodeRateLimited, "%s: at most %d terminals (close one first)", method, maxPluginTerminals)
	}
	t, err := terms.Create(ctx, a.name, TerminalSpec{Argv: p.Argv, Cwd: cwd, Env: env, Title: title})
	if err != nil {
		a.hostLog("refused terminal/create: %v", err)
		return nil, ownedError(method, err)
	}
	a.hostLog("terminal created: %s %q (%s) in %s", t.TerminalID, title, p.Argv[0], cwd)
	a.m.log.Info("plugin terminal created", "plugin", a.name, "terminal", t.TerminalID, "argv0", p.Argv[0])
	return pluginsdk.TerminalCreateResult{TerminalID: t.TerminalID}, nil
}

// terminalClose serves terminal/close.
func (a *actor) terminalClose(ctx context.Context, params json.RawMessage) (any, error) {
	const method = pluginsdk.MethodTerminalClose
	terms := a.m.opts.Terminals
	if terms == nil {
		return nil, notServed(method)
	}
	p, err := decodeParams[pluginsdk.TerminalRef](method, params)
	if err != nil {
		return nil, err
	}
	if p.TerminalID == "" {
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: terminalId is required", method)
	}
	if owner, ok := terms.Owner(p.TerminalID); !ok || owner != a.name {
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "%s: terminal %s is not one of plugin %s's terminals", method, p.TerminalID, a.name)
	}
	if err := terms.Close(ctx, p.TerminalID); err != nil {
		return nil, ownedError(method, err)
	}
	a.hostLog("terminal closed: %s", p.TerminalID)
	return struct{}{}, nil
}

// terminalList serves terminal/list.
func (a *actor) terminalList(context.Context, json.RawMessage) (any, error) {
	if a.m.opts.Terminals == nil {
		return nil, notServed(pluginsdk.MethodTerminalList)
	}
	list := a.m.opts.Terminals.Owned(a.name)
	if list == nil {
		list = []pluginsdk.PluginTerminal{}
	}
	return pluginsdk.TerminalListResult{Terminals: list}, nil
}

// terminalRead serves terminal/read: the screen's plain text, its end when longer than
// maxBytes (cut at a line start).
func (a *actor) terminalRead(ctx context.Context, params json.RawMessage) (any, error) {
	const method = pluginsdk.MethodTerminalRead
	terms := a.m.opts.Terminals
	if terms == nil {
		return nil, notServed(method)
	}
	p, err := decodeParams[pluginsdk.TerminalReadParams](method, params)
	if err != nil {
		return nil, err
	}
	if owner, ok := terms.Owner(p.TerminalID); !ok || owner != a.name {
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "%s: terminal %s is not one of plugin %s's terminals", method, p.TerminalID, a.name)
	}
	limit := p.MaxBytes
	switch {
	case limit <= 0:
		limit = defaultTerminalRead
	case limit > maxTerminalRead:
		limit = maxTerminalRead
	}
	text, err := terms.Text(ctx, p.TerminalID)
	if err != nil {
		return nil, ownedError(method, err)
	}
	text, cut := tailText(text, limit)
	return pluginsdk.TerminalReadResult{Text: text, Truncated: cut}, nil
}

// tailText is the last limit bytes of s, from a line start when one is in them (else
// from a rune start), and whether it cut.
func tailText(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	t := s[len(s)-limit:]
	if i := strings.IndexByte(t, '\n'); i >= 0 && i+1 < len(t) {
		return t[i+1:], true
	}
	for len(t) > 0 && !utf8RuneStart(t[0]) {
		t = t[1:]
	}
	return t, true
}

// TerminalExited tells the plugin owning terminal id that its process exited
// (terminal/exited); the daemon calls it from the terminal store's events. Nothing for a
// terminal no plugin owns, or a plugin not running.
func (m *Manager) TerminalExited(id string, exitCode int) {
	if m.opts.Terminals == nil {
		return
	}
	owner, ok := m.opts.Terminals.Owner(id)
	if !ok || owner == "" {
		return
	}
	conn := m.conn(owner)
	if conn == nil {
		return
	}
	_ = conn.Notify(pluginsdk.MethodTerminalExited, pluginsdk.TerminalExited{TerminalID: id, ExitCode: exitCode})
	m.surfLog(owner, "terminal %s exited (%d)", id, exitCode)
}

// Terminals returns plugin name's terminals (the CLI's plugin terminals).
func (m *Manager) Terminals(name string) ([]pluginsdk.PluginTerminal, error) {
	if _, ok := m.Snapshot().Plugin(name); !ok {
		return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	if m.opts.Terminals == nil {
		return nil, nil
	}
	return m.opts.Terminals.Owned(name), nil
}

// closeTerminals closes a plugin's terminals (it was disabled or removed).
func (m *Manager) closeTerminals(ctx context.Context, name string, logs *logBuffer) {
	terms := m.opts.Terminals
	if terms == nil {
		return
	}
	list := terms.Owned(name)
	if len(list) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ownedArchiveTimeout)
	defer cancel()
	var wg sync.WaitGroup
	for _, t := range list {
		wg.Go(func() {
			if err := terms.Close(ctx, t.TerminalID); err != nil {
				m.log.Warn("plugin: close its terminal", "plugin", name, "terminal", t.TerminalID, "err", err)
			}
		})
	}
	wg.Wait()
	if logs != nil {
		logs.add("host", "", fmt.Sprintf("closed its terminals: %d", len(list)))
	}
}
