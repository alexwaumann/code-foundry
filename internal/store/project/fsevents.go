package project

import (
	"context"
	"log/slog"
	"path/filepath"
	"slices"
	"time"

	"github.com/fsnotify/fsevents"
)

// The store's one FSEvents stream (docs/notes/fsevents-watcher.md).
//
// FSEvents is recursive and costs no file descriptor per directory, so one stream over
// the managed worktree root, every project directory, and every worktree outside both
// sees an edit anywhere in any worktree. The stream is recreated whenever that set of
// paths changes (a project registered or unregistered, a worktree outside the roots
// appearing or going away); reconcile and Unregister ask for that through sync.
//
// Two goroutines:
//
//   - run owns the stream: it is the only goroutine that makes cgo calls (create,
//     start, stop), as the terminal actor is for libghostty-vt.
//   - dispatch reads the batches the stream's callback (on a dispatch queue thread
//     inside the fsevents package) sends on events, routes them, and triggers the
//     debouncer. It never waits on run, so a callback blocked on a full channel
//     cannot deadlock a Stop that waits for it.
//
// Every stream run creates sends on the same channel, so replacing a stream needs no
// channel handover: the new one starts (since now) before the old one stops, and the
// overlap at most delivers an event twice, which the debouncer absorbs.

const (
	// streamLatency is how long FSEvents coalesces after delivering a batch. With
	// NoDefer the first event after a quiet period is delivered at once.
	streamLatency = 250 * time.Millisecond
	// streamFlags: per-file events (so a path names the file, not its directory), on
	// the leading edge, and RootChanged when a root itself moves.
	streamFlags = fsevents.FileEvents | fsevents.NoDefer | fsevents.WatchRoot
	// eventBuffer is how many batches the callback can queue before it blocks.
	eventBuffer = 256
)

type fsWatcher struct {
	log *slog.Logger
	// paths returns the stream paths the store wants now.
	paths func() []string
	// route handles one batch; it must not block on the watcher.
	route func([]fsevents.Event)

	events  chan []fsevents.Event
	resync  chan chan struct{}
	stopped chan struct{} // closed once run has stopped the last stream
}

func newFSWatcher(log *slog.Logger, paths func() []string, route func([]fsevents.Event)) *fsWatcher {
	return &fsWatcher{
		log:     log,
		paths:   paths,
		route:   route,
		events:  make(chan []fsevents.Event, eventBuffer),
		resync:  make(chan chan struct{}),
		stopped: make(chan struct{}),
	}
}

// run owns the stream until ctx is done.
func (w *fsWatcher) run(ctx context.Context) {
	var (
		cur      *fsevents.EventStream
		curPaths []string
	)
	apply := func() {
		want := w.paths()
		if slices.Equal(want, curPaths) {
			return
		}
		var next *fsevents.EventStream
		if len(want) > 0 {
			next = &fsevents.EventStream{Events: w.events, Paths: want, Latency: streamLatency, Flags: streamFlags}
			if err := next.Start(); err != nil {
				// Leave curPaths unset so the next sync retries; the poll still runs.
				w.log.Warn("fsevents stream failed to start", "paths", want, "err", err)
				return
			}
		}
		if cur != nil {
			cur.Stop()
		}
		cur, curPaths = next, want
		w.log.Debug("fsevents stream", "paths", want)
	}
	apply()
	for {
		select {
		case <-ctx.Done():
			if cur != nil {
				cur.Stop()
			}
			close(w.stopped)
			return
		case done := <-w.resync:
			apply()
			close(done)
		}
	}
}

// dispatch routes batches until run has stopped the stream.
func (w *fsWatcher) dispatch() {
	for {
		select {
		case <-w.stopped:
			return
		case evs := <-w.events:
			w.route(evs)
		}
	}
}

// sync makes the stream match paths() before it returns (or ctx is done).
func (w *fsWatcher) sync(ctx context.Context) {
	done := make(chan struct{})
	select {
	case w.resync <- done:
	case <-ctx.Done():
		return
	case <-w.stopped:
		return
	}
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// streamPaths is the paths func of the store's watcher: every known worktree root and
// project directory, plus the managed worktree root.
func (g *Git) streamPaths() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return streamRoots(g.routes, g.wtRootReal)
}

// onEvents is the route func of the store's watcher: it maps a batch to job keys under
// one read lock of the routing table, then triggers each key once.
func (g *Git) onEvents(evs []fsevents.Event) {
	type hit struct {
		path  string
		flags fsevents.EventFlags
		n     int
	}
	keys := map[jobKey]*hit{}
	var order []jobKey
	g.mu.RLock()
	for _, ev := range evs {
		for _, k := range eventKeys(g.routes, ev.Path, ev.Flags) {
			if h := keys[k]; h != nil {
				h.n++
				continue
			}
			keys[k] = &hit{path: ev.Path, flags: ev.Flags, n: 1}
			order = append(order, k)
		}
	}
	g.mu.RUnlock()
	for _, k := range order {
		h := keys[k]
		if h.flags&rescanFlags != 0 {
			g.log.Info("fs events need a rescan", "path", h.path, "flags", uint32(h.flags), "project", k.projectID)
		} else {
			g.log.Debug("fs event", "path", h.path, "ops", opsOf(h.flags).String(), "job", k.kind.String(),
				"project", k.projectID, "worktree", k.path, "events", h.n)
		}
		g.deb.trigger(k)
	}
}

// resolveMissing resolves p's symlinks, or its nearest existing ancestor's when p does
// not exist yet (the managed worktree root before the first worktree): FSEvents
// reports real paths (/private/var/..., never /var/...).
func resolveMissing(p string) string {
	p = filepath.Clean(p)
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	parent := filepath.Dir(p)
	if parent == p {
		return p
	}
	return filepath.Join(resolveMissing(parent), filepath.Base(p))
}
