package plugin

import (
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Closing surface instances early (docs/notes/plugins-10-host-gaps.md). An open instance
// is closed at once, not after the idle grace, when its context goes away (its thread
// archived or removed, its project removed: context_gone) or its when clause stops
// holding (unavailable). recheck looks at every open instance after a change that may
// cause either: the daemon's thread and project events (ContextsChanged) and the plugin
// store's own AvailabilityChanged (checks arrived, a context fact set).

// recheckDelay batches a burst of changes (a thread's status flips several times a
// second while Claude works) into one recheck.
const recheckDelay = 250 * time.Millisecond

// ContextsChanged tells the store that threads or projects changed (the daemon calls it
// on their events): open surface instances whose thread or project went away, or whose
// when clause no longer holds, are closed shortly after.
func (m *Manager) ContextsChanged() { m.surf.recheckSoon() }

// recheckSoon schedules one recheck after recheckDelay, unless one is scheduled.
func (h *surfaceHub) recheckSoon() {
	select {
	case <-h.stop:
		return
	default:
	}
	h.recheckMu.Lock()
	defer h.recheckMu.Unlock()
	if h.recheckTimer != nil {
		return
	}
	h.recheckTimer = time.AfterFunc(recheckDelay, func() {
		h.recheckMu.Lock()
		h.recheckTimer = nil
		h.recheckMu.Unlock()
		h.recheck()
	})
}

// recheck closes the open instances whose context is gone or whose when clause turned
// false, and reopens watched ones closed as unavailable whose clause holds again.
func (h *surfaceHub) recheck() {
	h.mu.Lock()
	all := make([]*instance, 0, len(h.inst))
	for _, in := range h.inst {
		all = append(all, in)
	}
	h.mu.Unlock()
	for _, in := range all {
		in.mu.Lock()
		open := in.openConn != nil || in.openingConn != nil
		reopen := !open && len(in.watchers) > 0 && in.closedFor == pluginsdk.CloseUnavailable
		uctx := in.uctx
		in.mu.Unlock()
		if !open && !reopen {
			continue
		}
		reason, why := h.verdict(in, uctx)
		switch {
		case open && reason != "":
			h.closeNow(in, reason, why)
		case reopen && reason == "":
			h.activate(in)
		}
	}
}

// verdict is why in should close now ("" when it should not), and why in words.
func (h *surfaceHub) verdict(in *instance, uctx command.Context) (pluginsdk.CloseReason, string) {
	m := h.m
	p, ok := m.Snapshot().Plugin(in.plugin)
	if !ok {
		return "", "" // a removed plugin's instances go with its process
	}
	spec, ok := surfaceSpec(p, in.surfaceID)
	if !ok {
		return "", ""
	}
	if m.opts.Facts == nil {
		return "", "" // no facts to tell (tests)
	}
	kind, id, _ := strings.Cut(in.scope, ":")
	switch kind {
	case "thread":
		if t, ok := m.opts.Facts.Thread(id); !ok {
			return pluginsdk.CloseContextGone, "the thread was removed"
		} else if t.Archived {
			return pluginsdk.CloseContextGone, "the thread was archived"
		}
	case "project":
		if _, ok := m.opts.Facts.Project(id); !ok {
			return pluginsdk.CloseContextGone, "the project was removed"
		}
	}
	if pid := in.pctx.ProjectID; pid != "" && kind != "project" {
		if _, ok := m.opts.Facts.Project(pid); !ok {
			return pluginsdk.CloseContextGone, "the project was removed"
		}
	}
	// The when clause, in the context the instance was opened in. When that context's
	// thread is gone (a pr instance opened from a thread since archived), it cannot say.
	if id := uctx.ActiveThreadID; id != "" {
		if t, ok := m.opts.Facts.Thread(id); !ok || t.Archived {
			return "", ""
		}
	}
	pred, err := m.predicate(spec.When)
	if err != nil || pred == nil {
		return "", ""
	}
	if a := m.evalPredicate(pred, uctx); !a.ok && !a.unknown {
		return pluginsdk.CloseUnavailable, a.reason
	}
	return "", ""
}

// closeNow closes an open instance for reason: surface/close to the plugin, a notice for
// its watchers. A context_gone instance is forgotten unless watched.
func (h *surfaceHub) closeNow(in *instance, reason pluginsdk.CloseReason, why string) {
	in.mu.Lock()
	conn := in.openConn
	if conn == nil {
		conn = in.openingConn
	}
	if conn == nil {
		in.mu.Unlock()
		return
	}
	in.openConn, in.openingConn = nil, nil
	in.stopTimersLocked()
	in.closedAt, in.closedFor = h.m.opts.Now(), reason
	watched := len(in.watchers) > 0
	if watched {
		in.setStateLocked(PhaseFailed, "closed: "+why, StateRunning)
	}
	in.mu.Unlock()
	_ = conn.Notify(pluginsdk.MethodSurfaceClose, pluginsdk.SurfaceClose{Instance: in.key, Reason: reason})
	h.m.surfLog(in.plugin, "closed %s (%s: %s)", in.key, reason, why)
	h.mu.Lock()
	if reason == pluginsdk.CloseContextGone && !watched {
		delete(h.inst, in.key)
	}
	h.evictLocked()
	h.mu.Unlock()
}
