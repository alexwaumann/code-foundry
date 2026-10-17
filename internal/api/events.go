package api

import (
	"context"
	"slices"
	"sync"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// terminalWatchBuffer matches terminal.Manager.Watch's per-topic bus buffer.
const terminalWatchBuffer = 256

// EventsDeps are what EventService multiplexes. Bus is required; a nil store leaves its
// source out of the stream.
type EventsDeps struct {
	Bus      *bus.Bus
	Repo     repo.Store
	Terminal terminal.Store
	Thread   thread.Store
	Gh       gh.Service
	GitOps   gitops.Store
	Settings settings.Service
	Update   update.Service
	// Workspace is the workspace store (branch sets).
	Workspace workspace.Store
	// Action is the action store (per-project commands and their runs).
	Action action.Store
	// Done ends every stream when closed (daemon shutdown). May be nil.
	Done <-chan struct{}
}

// Events implements codefoundryv1connect.EventServiceHandler: one server stream that
// carries every store's Watch events and UI intents, so a browser holds one connection
// instead of one per service. Live events pass through one hub (events_hub.go) that
// numbers them (Event.seq) and keeps the last ones for clients that resume.
type Events struct {
	deps EventsDeps
	beat time.Duration // Watch's heartbeat interval; zero is HeartbeatInterval (tests shorten it)

	hubOnce sync.Once
	hub     *eventHub
}

var _ codefoundryv1connect.EventServiceHandler = (*Events)(nil)

// NewEvents returns an EventService handler.
func NewEvents(deps EventsDeps) *Events { return &Events{deps: deps} }

// Route mounts the service.
func (h *Events) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewEventServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// eventHub returns the hub, starting it on the first Watch. It runs until Done closes
// (for ever without one), so events published while no client is connected are still
// numbered and kept for a later resume.
func (h *Events) eventHub() *eventHub {
	h.hubOnce.Do(func() { h.hub = newEventHub(h.deps.Done, h.sources()) })
	return h.hub
}

// eventSource is one store's contribution to Watch. The hub builds one set of sources
// for their topics; each stream builds its own for snapshots, so a source may keep
// per-client state (see eventObserver).
type eventSource interface {
	kind() v1.EventSource
	// topics are the bus topics the source carries, each with its mapping to an Event.
	// The hub subscribes them once and fans the events out to every stream that wants
	// the source. A stream joins the hub before it takes the snapshots, so nothing
	// published in between is lost; events queued before a snapshot carry full state,
	// so applying them in order still converges.
	topics() []topic
	// snapshot returns the events that bring a client to the source's current state.
	// It is sent on connect and again when the client missed events of the source.
	snapshot(ctx context.Context) []*v1.Event
}

// eventObserver is a source that keeps per-client state from the live and replayed
// events the stream sends (terminalSource's known ids).
type eventObserver interface{ observe(ev *v1.Event) }

// eventResumer is a source with per-client state to set up when a stream resumes
// (since_seq) instead of starting with the snapshot.
type eventResumer interface{ resume(ctx context.Context) }

// sources lists the stream's sources in the order their snapshots are sent (see
// events.proto: repo, workspace, terminal, thread, thread, gh, gitops, settings, update,
// action),
// followed by UI intents.
func (h *Events) sources() []eventSource {
	d := h.deps
	var out []eventSource
	if d.Repo != nil {
		out = append(out, repoSource{store: d.Repo, bus: d.Bus})
	}
	if d.Workspace != nil {
		out = append(out, workspaceSource{store: d.Workspace, bus: d.Bus})
	}
	if d.Terminal != nil {
		out = append(out, &terminalSource{store: d.Terminal, bus: d.Bus, known: map[string]bool{}})
	}
	if d.Thread != nil {
		out = append(out, threadListSource{store: d.Thread, bus: d.Bus}, threadSource{store: d.Thread, bus: d.Bus})
	}
	if d.Gh != nil {
		out = append(out, ghSource{store: d.Gh, bus: d.Bus})
	}
	if d.GitOps != nil {
		out = append(out, gitopsSource{store: d.GitOps, bus: d.Bus})
	}
	if d.Settings != nil {
		out = append(out, settingsSource{store: d.Settings, bus: d.Bus})
	}
	if d.Update != nil {
		out = append(out, updateSource{svc: d.Update, bus: d.Bus}) // api/update.go
	}
	if d.Action != nil {
		out = append(out, actionSource{store: d.Action, bus: d.Bus}) // api/action_events.go
	}
	out = append(out, uiSource{bus: d.Bus})
	return out
}

// selectSources keeps the sources whose kind is in want; empty want keeps all.
func selectSources(all []eventSource, want []v1.EventSource) []eventSource {
	if len(want) == 0 {
		return all
	}
	return slices.DeleteFunc(all, func(s eventSource) bool { return !slices.Contains(want, s.kind()) })
}

// Watch joins the hub for the requested sources, sends their snapshots (or, resuming
// with since_seq, the kept events after it), then live events until the client goes
// away or the daemon stops. When the client missed events of a source (its queue was
// full, or the hub's own subscription dropped some), that source's snapshot is sent
// again and its queued events the snapshot already covers are skipped; other sources
// are unaffected.
func (h *Events) Watch(ctx context.Context, req *connect.Request[v1.WatchEventsRequest], stream *connect.ServerStream[v1.Event]) error {
	srcs := selectSources(h.sources(), req.Msg.GetSources())
	byKind := make(map[v1.EventSource]eventSource, len(srcs))
	var mask kindMask
	for _, s := range srcs {
		byKind[s.kind()] = s
		mask |= kindBit(s.kind())
	}
	hub := h.eventHub()
	c, replay, resumed := hub.join(mask, req.Msg.GetSinceSeq())
	defer hub.leave(c)

	// Quiet sources (gh polling off, no thread busy) get a heartbeat every
	// HeartbeatInterval (see heartbeat.proto).
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	send := func(ev *v1.Event) error {
		beat.Reset()
		return stream.Send(ev)
	}
	deliver := func(e hubEvent) error {
		if o, ok := byKind[e.kind].(eventObserver); ok {
			o.observe(e.ev)
		}
		return send(e.ev)
	}
	sendSnapshot := func(s eventSource) (int, error) {
		evs := s.snapshot(ctx)
		for _, ev := range evs {
			if err := send(ev); err != nil {
				return 0, err
			}
		}
		return len(evs), nil
	}
	sent := 0
	if resumed {
		for _, s := range srcs {
			if r, ok := s.(eventResumer); ok {
				r.resume(ctx)
			}
		}
		for _, e := range replay {
			if err := deliver(e); err != nil {
				return err
			}
		}
		sent = len(replay)
	} else {
		for _, s := range srcs {
			n, err := sendSnapshot(s)
			if err != nil {
				return err
			}
			sent += n
		}
	}
	// Flush response headers now if nothing was sent: clients block until they arrive,
	// and the first live event may be a long way off.
	if sent == 0 {
		if err := send(nil); err != nil {
			return err
		}
	}

	// covered[k]: the last resync snapshot of source k had every event up to this seq.
	covered := make(map[v1.EventSource]uint64)
	resync := func() error {
		dirty := c.takeDirty()
		if dirty == 0 {
			return nil
		}
		for _, s := range srcs {
			if !dirty.has(s.kind()) {
				continue
			}
			// Read before the snapshot: an event numbered up to here was published
			// after its store changed, so the snapshot has it.
			covered[s.kind()] = hub.lastSeq()
			if _, err := sendSnapshot(s); err != nil {
				return err
			}
		}
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-h.deps.Done:
			return nil
		case <-beat.C():
			if err := send(&v1.Event{Event: &v1.Event_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}}); err != nil {
				return err
			}
		case <-c.poke:
			if err := resync(); err != nil {
				return err
			}
		case e := <-c.ch:
			if err := resync(); err != nil {
				return err
			}
			if !e.transient && e.ev.GetSeq() <= covered[e.kind] {
				continue // older than the snapshot just sent
			}
			if err := deliver(e); err != nil {
				return err
			}
		}
	}
}

// topic is one bus topic of a source: open subscribes to it now.
//
// A transient topic carries fire-and-forget events (UI intents, relaunch and restart
// requests): the hub subscribes it only while a stream wants its source, so the
// publisher's delivery count (bus.Publish) still says whether anyone listens, and its
// events are numbered but never kept for a resume.
type topic struct {
	open      func() tap
	transient bool
}

// busTopic is the topic of bus events of type T with a buffer of n (the hub's backlog
// before it drops; a drop makes every stream resync the source), each mapped by conv
// (nil: not carried).
func busTopic[T any](b *bus.Bus, n int, conv func(T) *v1.Event) topic {
	return topic{open: func() tap { return &busTap[T]{sub: bus.Subscribe[T](b, n), conv: conv} }}
}

// transientTopic is busTopic for a transient topic.
func transientTopic[T any](b *bus.Bus, n int, conv func(T) *v1.Event) topic {
	t := busTopic(b, n, conv)
	t.transient = true
	return t
}

// tap is one bus subscription feeding a source's events to emit.
type tap interface {
	// run delivers until ctx ends, the tap is closed, or emit returns false. A nil
	// event means the subscription dropped events: the receiver resyncs the source.
	run(ctx context.Context, emit func(*v1.Event) bool)
	// close unsubscribes at once; run then returns.
	close()
}

type busTap[T any] struct {
	sub  *bus.Subscription[T]
	conv func(T) *v1.Event
}

func (t *busTap[T]) close() { t.sub.Close() }

func (t *busTap[T]) run(ctx context.Context, emit func(*v1.Event) bool) {
	defer t.sub.Close()
	var dropped uint64
	for {
		var msg *v1.Event
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-t.sub.C():
			if !ok {
				return
			}
			if d := t.sub.Dropped(); d != dropped {
				dropped = d // msg stays nil: resync
			} else if msg = t.conv(ev); msg == nil {
				continue
			}
		}
		if !emit(msg) {
			return
		}
	}
}

// subscribeTopics subscribes topics now and merges their events into one channel,
// closed once all have stopped (when ctx ends). Order is kept within a topic, not
// across topics (as terminal.Manager.Watch). For a single-source stream that does not
// go through the hub (UpdateService.Watch).
func subscribeTopics(ctx context.Context, topics []topic) <-chan *v1.Event {
	out := make(chan *v1.Event)
	emit := func(ev *v1.Event) bool {
		select {
		case out <- ev:
			return true
		case <-ctx.Done():
			return false
		}
	}
	var wg sync.WaitGroup
	for _, tp := range topics {
		t := tp.open()
		wg.Go(func() { t.run(ctx, emit) })
	}
	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}

// ---- repo ----------------------------------------------------------------------

type repoSource struct {
	store repo.Store
	bus   *bus.Bus
}

func (repoSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_REPO }

func (s repoSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, func(ev repo.Event) *v1.Event {
		if m := eventToProto(ev); m != nil {
			return &v1.Event{Event: &v1.Event_Repo{Repo: m}}
		}
		return nil
	})}
}

func (s repoSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{{Event: &v1.Event_Repo{Repo: &v1.RepoEvent{Event: &v1.RepoEvent_Snapshot{
		Snapshot: &v1.RepoSnapshot{Repos: reposToProto(s.store.Snapshot().Repos)},
	}}}}}
}

// ---- workspace -----------------------------------------------------------------

// workspaceSource reuses WorkspaceService's mapping (api/workspace.go). The store
// publishes one bus type, workspace.Event; its snapshot is a WorkspaceEvent.snapshot.
type workspaceSource struct {
	store workspace.Store
	bus   *bus.Bus
}

func (workspaceSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_WORKSPACE }

func workspaceWrap(ev workspace.Event) *v1.Event {
	if m := workspaceEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_Workspace{Workspace: m}}
	}
	return nil
}

func (s workspaceSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, workspaceWrap)}
}

func (s workspaceSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{workspaceWrap(s.store.Snapshot())}
}

// ---- terminal ------------------------------------------------------------------

// terminalSource has no snapshot message in terminal.proto, so its snapshot is one
// `updated` per terminal plus `removed_id` for every terminal this client was told
// about that no longer exists. That makes a resync after drops converge too. known is
// per client: snapshot records what it sends, observe what the hub delivered, and
// resume starts it from the terminals that exist (a resumed client had them all).
type terminalSource struct {
	store terminal.Store
	bus   *bus.Bus
	mu    sync.Mutex
	known map[string]bool // ids sent to this client and not removed since
}

func (*terminalSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_TERMINAL }

func terminalWrap(ev terminal.Event) *v1.Event {
	return &v1.Event{Event: &v1.Event_Terminal{Terminal: terminalEventToProto(ev)}}
}

// wrap is terminalWrap that also records the id as known (or not).
func (s *terminalSource) wrap(ev terminal.Event) *v1.Event {
	out := terminalWrap(ev)
	s.observe(out)
	return out
}

func (s *terminalSource) observe(ev *v1.Event) {
	t := ev.GetTerminal()
	if t == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if u := t.GetUpdated(); u != nil {
		s.known[u.GetId()] = true
	} else {
		delete(s.known, t.GetRemovedId())
	}
}

func (s *terminalSource) resume(ctx context.Context) {
	ts := s.store.List(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range ts {
		s.known[t.ID] = true
	}
}

func (s *terminalSource) topics() []topic {
	return []topic{
		busTopic(s.bus, terminalWatchBuffer, func(u terminal.TerminalUpdated) *v1.Event {
			return terminalWrap(terminal.Event{Updated: &u.Terminal})
		}),
		busTopic(s.bus, terminalWatchBuffer, func(r terminal.TerminalRemoved) *v1.Event {
			return terminalWrap(terminal.Event{RemovedID: r.ID})
		}),
	}
}

func (s *terminalSource) snapshot(ctx context.Context) []*v1.Event {
	ts := s.store.List(ctx)
	s.mu.Lock()
	stale := s.known
	s.known = make(map[string]bool, len(ts))
	s.mu.Unlock()
	out := make([]*v1.Event, 0, len(ts)+len(stale))
	for _, t := range ts {
		delete(stale, t.ID)
		out = append(out, s.wrap(terminal.Event{Updated: &t}))
	}
	gone := make([]string, 0, len(stale))
	for id := range stale {
		gone = append(gone, id)
	}
	slices.Sort(gone)
	for _, id := range gone {
		out = append(out, s.wrap(terminal.Event{RemovedID: id}))
	}
	return out
}

// ---- thread list --------------------------------------------------------------

// threadListSource reuses ThreadService's mapping (api/thread_lifecycle.go). The store
// publishes one bus type, thread.Event; its snapshot is a ThreadListEvent.snapshot.
type threadListSource struct {
	store thread.Store
	bus   *bus.Bus
}

func (threadListSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_THREAD_LIST }

func threadListWrap(ev thread.Event) *v1.Event {
	if m := threadListEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_ThreadList{ThreadList: m}}
	}
	return nil
}

func (s threadListSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, threadListWrap)}
}

func (s threadListSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{threadListWrap(s.store.Snapshot())}
}

// ---- thread --------------------------------------------------------------------

// threadSource carries the pending requests (permission prompts and questions) of
// every thread: the snapshot lists the live threads' pending requests, then
// each change is a ThreadEvent.pending. Items are per thread and come only from
// ThreadService.ListItems or Watch (the visible thread's stream, as a terminal's
// Attach): forwarding every thread's text deltas to every client would cost more than
// it shows, and this source's resync after dropped events restores pending requests
// only, so nothing else may be built from it. A disconnected thread has nothing
// pending (its requests are cancelled when its process ends).
type threadSource struct {
	store thread.Store
	bus   *bus.Bus
}

func (threadSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_THREAD }

func threadWrap(ev thread.ThreadEvent) *v1.Event {
	if _, ok := ev.(thread.PendingChanged); !ok {
		return nil
	}
	if m := threadEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_Thread{Thread: m}}
	}
	return nil
}

func (s threadSource) topics() []topic {
	return []topic{busTopic(s.bus, threadWatchBuffer, threadWrap)}
}

func (s threadSource) snapshot(ctx context.Context) []*v1.Event {
	snap := &v1.ThreadPendingSnapshot{}
	if ss := s.store.Snapshot(); ss != nil {
		for _, x := range ss.Threads {
			if x.State == thread.StateDisconnected {
				continue
			}
			items, err := s.store.Items(ctx, x.ID)
			if err != nil || len(items.Pending) == 0 {
				continue
			}
			snap.Threads = append(snap.Threads, pendingToProto(x.ID, items.Seq, items.Pending))
		}
	}
	return []*v1.Event{{Event: &v1.Event_Thread{Thread: &v1.ThreadEvent{Event: &v1.ThreadEvent_PendingSnapshot{PendingSnapshot: snap}}}}}
}

// ---- gh ------------------------------------------------------------------------

// ghSource events are notifications to re-read, so its snapshot is a notification for
// the viewer, the last poll, the dashboard, and every cached repository's activity.
type ghSource struct {
	store gh.Service
	bus   *bus.Bus
}

func (ghSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_GH }

func ghWrap(e *v1.GhEvent) *v1.Event { return &v1.Event{Event: &v1.Event_Gh{Gh: e}} }

func (s ghSource) topics() []topic {
	return []topic{
		busTopic(s.bus, ghWatchBuffer, func(e gh.Polled) *v1.Event { return ghWrap(ghPolledEvent(e)) }),
		busTopic(s.bus, ghWatchBuffer, func(e gh.ViewerUpdated) *v1.Event { return ghWrap(ghViewerEvent(e)) }),
		busTopic(s.bus, ghWatchBuffer, func(e gh.DashboardUpdated) *v1.Event { return ghWrap(ghDashboardEvent(e)) }),
		busTopic(s.bus, ghWatchBuffer, func(e gh.RepoActivityUpdated) *v1.Event { return ghWrap(ghRepoActivityEvent(e)) }),
		busTopic(s.bus, ghWatchBuffer, func(e gh.BranchPullRequestsUpdated) *v1.Event { return ghWrap(ghBranchEvent(e)) }),
		busTopic(s.bus, ghWatchBuffer, func(e gh.PullRequestDetailUpdated) *v1.Event { return ghWrap(ghDetailEvent(e)) }),
	}
}

func (s ghSource) snapshot(context.Context) []*v1.Event {
	snap := s.store.Snapshot()
	out := []*v1.Event{
		ghWrap(ghViewerEvent(gh.ViewerUpdated{FetchedAt: snap.Viewer.FetchedAt})),
		ghWrap(ghPolledEvent(gh.Polled{FetchedAt: snap.Poll.FetchedAt, LastError: snap.Poll.LastError})),
		ghWrap(ghDashboardEvent(gh.DashboardUpdated{FetchedAt: snap.Dashboard.FetchedAt})),
	}
	slugs := make([]string, 0, len(snap.Repos))
	for slug := range snap.Repos {
		slugs = append(slugs, slug)
	}
	slices.Sort(slugs)
	for _, slug := range slugs {
		out = append(out, ghWrap(ghRepoActivityEvent(gh.RepoActivityUpdated{Slug: slug, FetchedAt: snap.Repos[slug].Activity.DefaultBranch.FetchedAt})))
	}
	return out
}

// ---- gitops --------------------------------------------------------------------

// gitopsSource reuses GitOpsService's mapping (api/gitops.go). Its snapshot is the
// running and recent operations.
type gitopsSource struct {
	store gitops.Store
	bus   *bus.Bus
}

func (gitopsSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_GITOPS }

func gitopsWrap(e *v1.GitOpsEvent) *v1.Event { return &v1.Event{Event: &v1.Event_Gitops{Gitops: e}} }

func (s gitopsSource) topics() []topic {
	return []topic{busTopic(s.bus, gitopsWatchBuffer, func(ev gitops.Event) *v1.Event {
		if m := gitopsEventToProto(ev); m != nil {
			return gitopsWrap(m)
		}
		return nil
	})}
}

func (s gitopsSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{gitopsWrap(gitopsSnapshotEvent(s.store.Snapshot()))}
}

// ---- ui ------------------------------------------------------------------------

// uiSource carries intents. They are fire-and-forget: there is no state to snapshot,
// and intents dropped for a slow client are lost (as with UiService.WatchIntents). The
// topic is transient: Emit's delivery count still counts connected windows, and a
// resumed stream never replays an old intent.
type uiSource struct {
	bus *bus.Bus
}

func (uiSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_UI }

func (s uiSource) topics() []topic {
	return []topic{transientTopic(s.bus, intentBuffer, func(ev command.IntentEvent) *v1.Event {
		if ev.Intent == nil {
			return nil
		}
		return &v1.Event{Event: &v1.Event_Ui{Ui: ev.Intent}}
	})}
}

func (uiSource) snapshot(context.Context) []*v1.Event { return nil }
