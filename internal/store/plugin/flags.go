package plugin

//lint:file-ignore SA1019 the host serves the deprecated thread/setFlag (pluginsdk/removals.go)

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Thread flags (thread/setFlag, permission threadStatus; deprecated, pluginsdk.Removals;
// docs/notes/plugin-flag-retirement.md): a plugin raises an attention or error flag with
// a one-line reason on a thread. The host shows it as a notification naming the thread,
// under the plugin's source, which the daemon posts (ThreadFlags adapts the notification
// and thread stores). This side checks the permission, the reason and the rate, and names
// the plugin. The flag's notification goes like the plugin's others when it is disabled
// or removed (release); initialize hands the plugin its live flags, read back from the
// notifications, to reconcile. Only threadStatus is needed: a plugin whose manifest
// predates the notifications permission keeps its flags.

// FlagSpec is one plugin's flag as the daemon gets it.
type FlagSpec struct {
	Plugin, DisplayName string
	// Level is pluginsdk.FlagAttention, FlagError or FlagNone (withdraws it).
	Level string
	// Reason is trimmed, one line, at most MaxFlagReason characters; "" is allowed.
	Reason    string
	UntilSeen bool
}

// ThreadFlags is what plugin flags need of the daemon. Its errors wrap ErrNotFound (no
// such thread), ErrInvalidArgument and ErrFailedPrecondition (an archived thread, too
// many notifications).
type ThreadFlags interface {
	// SetFlag raises (or with FlagNone withdraws) the plugin's flag on a thread; changed
	// is false when nothing changed for the user.
	SetFlag(ctx context.Context, threadID string, f FlagSpec) (changed bool, err error)
	// Of returns a plugin's live flags (ThreadID set), oldest first: its active flag
	// notifications.
	Of(plugin string) []pluginsdk.Flag
}

// MaxFlagReason bounds a flag's reason, in characters, as before flags were
// notifications (it always fits a notification's title).
const MaxFlagReason = 80

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

// cleanFlagReason trims a reason and checks it: one line, at most MaxFlagReason
// characters.
func cleanFlagReason(r string) (string, error) {
	r = strings.TrimSpace(r)
	switch {
	case strings.ContainsAny(r, "\r\n\x00"):
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "thread/setFlag: a flag's reason is one line")
	case utf8.RuneCountInString(r) > MaxFlagReason:
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "thread/setFlag: a flag's reason is %d characters; at most %d", utf8.RuneCountInString(r), MaxFlagReason)
	}
	return r, nil
}

// setFlag serves thread/setFlag.
func (a *actor) setFlag(ctx context.Context, params json.RawMessage) (any, error) {
	flags := a.m.opts.Flags
	if flags == nil {
		return nil, notServed(pluginsdk.MethodThreadSetFlag)
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
	reason := ""
	if p.Level != pluginsdk.FlagNone {
		if reason, err = cleanFlagReason(p.Reason); err != nil {
			return nil, err
		}
		if !a.flagRate.allow(p.ThreadID, a.m.opts.Now()) {
			return nil, pluginsdk.NewError(pluginsdk.CodeRateLimited, "thread/setFlag: at most one flag a second on a thread")
		}
	}
	display := a.name
	if pl, ok := a.m.Snapshot().Plugin(a.name); ok {
		display = pl.DisplayName()
	}
	changed, err := flags.SetFlag(ctx, p.ThreadID, FlagSpec{
		Plugin: a.name, DisplayName: display, Level: p.Level, Reason: reason, UntilSeen: p.UntilSeen,
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
	switch {
	case !changed:
		// A plugin re-asserting its flag on every poll is routine.
		a.hostDebug("flag %s on %s unchanged", p.Level, p.ThreadID)
	case p.Level == pluginsdk.FlagNone:
		a.hostLog("flag cleared on %s (its notification withdrawn)", p.ThreadID)
	default:
		a.hostLog("flag %s on %s, as a notification: %s", p.Level, p.ThreadID, reason)
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
