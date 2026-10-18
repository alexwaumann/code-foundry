package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Thread flags (thread/setFlag, permission threadStatus; docs/notes/plugins-3-events-flags-env.md):
// a plugin raises an attention or error flag with a one-line reason on a thread, an
// overlay the GUI counts as the thread needing the user. The thread store keeps them
// (ThreadFlags, persisted); this side checks the permission and the rate, names the
// plugin, and clears a plugin's flags when it is disabled or removed. A crash keeps
// them, and initialize hands the plugin its live flags to reconcile.

// FlagSpec is one plugin's flag as the thread store gets it.
type FlagSpec struct {
	Plugin, DisplayName string
	// Level is pluginsdk.FlagAttention, FlagError or FlagNone (clears).
	Level     string
	Reason    string
	UntilSeen bool
}

// ThreadFlags is the thread store as plugin flags need it. The daemon adapts the
// thread store; its errors wrap ErrNotFound (no such thread), ErrInvalidArgument (a bad
// reason) and ErrFailedPrecondition (an archived thread).
type ThreadFlags interface {
	// SetFlag raises (or with FlagNone clears) the plugin's flag on a thread; changed is
	// false when nothing changed.
	SetFlag(ctx context.Context, threadID string, f FlagSpec) (changed bool, err error)
	// ClearPlugin removes a plugin's flags from every thread and says how many went.
	ClearPlugin(ctx context.Context, plugin string) (int, error)
	// Of returns a plugin's flags (ThreadID set).
	Of(plugin string) []pluginsdk.Flag
	// Plugins names every plugin with a flag on some thread.
	Plugins() []string
}

// flagInterval is the least time between two flags a plugin raises on one thread
// (clearing is never limited).
const flagInterval = time.Second

func threadStatusGranted(p pluginsdk.Permissions) bool { return p.ThreadStatus }

func init() {
	hostMethods[pluginsdk.MethodThreadSetFlag] = hostMethod{perm: threadStatusGranted, permName: "threadStatus", handle: (*actor).setFlag}
	hostCapabilities = append(hostCapabilities, "flags")
}

// flagLimiter remembers when the plugin last raised a flag on each thread.
type flagLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

// allow reports whether a flag on thread may be raised at now, and records it.
func (l *flagLimiter) allow(thread string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t, ok := l.last[thread]; ok && now.Sub(t) < flagInterval {
		return false
	}
	if l.last == nil {
		l.last = map[string]time.Time{}
	}
	l.last[thread] = now
	return true
}

// setFlag serves thread/setFlag.
func (a *actor) setFlag(ctx context.Context, params json.RawMessage) (any, error) {
	flags := a.m.opts.Flags
	if flags == nil {
		return nil, notSupportedYet(pluginsdk.MethodThreadSetFlag)
	}
	p, err := decodeParams[pluginsdk.Flag](pluginsdk.MethodThreadSetFlag, params)
	if err != nil {
		return nil, err
	}
	switch {
	case p.ThreadID == "":
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "thread/setFlag: threadId is required")
	case !slices.Contains([]string{pluginsdk.FlagAttention, pluginsdk.FlagError, pluginsdk.FlagNone}, p.Level):
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "thread/setFlag: level is attention, error or none, not %q", p.Level)
	}
	if p.Level != pluginsdk.FlagNone && !a.flagRate.allow(p.ThreadID, a.m.opts.Now()) {
		return nil, pluginsdk.NewError(pluginsdk.CodeRateLimited, "thread/setFlag: at most one flag a second on a thread")
	}
	display := a.name
	if pl, ok := a.m.Snapshot().Plugin(a.name); ok {
		display = pl.DisplayName()
	}
	changed, err := flags.SetFlag(ctx, p.ThreadID, FlagSpec{
		Plugin: a.name, DisplayName: display, Level: p.Level, Reason: p.Reason, UntilSeen: p.UntilSeen,
	})
	switch {
	case errors.Is(err, ErrNotFound):
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "%v", err)
	case errors.Is(err, ErrInvalidArgument):
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%v", err)
	case errors.Is(err, ErrFailedPrecondition):
		return nil, pluginsdk.NewError(pluginsdk.CodeUnavailable, "%v", err)
	case err != nil:
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	if changed {
		if p.Level == pluginsdk.FlagNone {
			a.hostLog("flag cleared on %s", p.ThreadID)
		} else {
			a.hostLog("flag %s on %s: %s", p.Level, p.ThreadID, p.Reason)
		}
	}
	return pluginsdk.FlagResult{Changed: changed}, nil
}

// liveFlags are the plugin's flags for initialize.
func (m *Manager) liveFlags(name string) []pluginsdk.Flag {
	if m.opts.Flags == nil {
		return nil
	}
	return m.opts.Flags.Of(name)
}

// clearFlags removes a plugin's flags (it was disabled or removed).
func (m *Manager) clearFlags(ctx context.Context, name string, logs *logBuffer) {
	if m.opts.Flags == nil {
		return
	}
	n, err := m.opts.Flags.ClearPlugin(ctx, name)
	switch {
	case err != nil:
		m.log.Warn("plugin: clear flags", "plugin", name, "err", err)
	case n > 0 && logs != nil:
		logs.add("host", "", "cleared its flags on threads: "+strconv.Itoa(n))
	}
}
