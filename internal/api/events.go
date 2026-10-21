package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"slices"
	"strconv"
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
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/project"
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
	Project  project.Store
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
	// Plugin is the plugin store.
	Plugin plugin.Store
	// Skill is the skill store (the Skills marketplace).
	Skill SkillStore
	// Done ends every stream when closed (daemon shutdown). May be nil.
	Done <-chan struct{}
	// Epoch is Event.epoch, the daemon instance; empty draws a random one (NewEvents).
	Epoch string
	// Clients records the GUI streams and their visibility (events_clients.go). May be
	// nil: nothing is recorded and SetClientState answers NotFound.
	Clients *Clients
}

// Events implements codefoundryv1connect.EventServiceHandler: one server stream that
// carries every store's Watch events and UI intents, so a browser holds one connection
// instead of one per service. Live events pass through one hub (events_hub.go) that
// numbers them (Event.seq) and keeps the last ones for clients that resume. Every event
// carries the epoch, so a client resuming across a daemon restart is told apart.
type Events struct {
	deps EventsDeps
	beat time.Duration // Watch's heartbeat interval; zero is HeartbeatInterval (tests shorten it)

	hubOnce sync.Once
	hub     *eventHub
}

var _ codefoundryv1connect.EventServiceHandler = (*Events)(nil)

// NewEvents returns an EventService handler. The daemon makes one per lifetime, so its
// epoch (deps.Epoch, else 12 random hex digits) names the daemon instance.
func NewEvents(deps EventsDeps) *Events {
	if deps.Epoch == "" {
		deps.Epoch = newEpoch()
	}
	return &Events{deps: deps}
}

// newEpoch is 12 random hex digits, or the start time's nanoseconds in hex when the
// system has no randomness to give.
func newEpoch() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b[:])
}

// Epoch is the epoch every event of this handler carries.
func (h *Events) Epoch() string { return h.deps.Epoch }

// Route mounts the service.
func (h *Events) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewEventServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// eventHub returns the hub, starting it on the first Watch. It runs until Done closes
// (for ever without one), so events published while no client is connected are still
// numbered and kept for a later resume.
func (h *Events) eventHub() *eventHub {
	h.hubOnce.Do(func() { h.hub = newEventHub(h.deps.Done, h.sources(), h.deps.Epoch) })
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
// events.proto: project, workspace, terminal, thread, thread, gh, gitops, settings, update,
// action, plugin, skill),
// followed by UI intents.
func (h *Events) sources() []eventSource {
	d := h.deps
	var out []eventSource
	if d.Project != nil {
		out = append(out, projectSource{store: d.Project, bus: d.Bus})
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
	if d.Plugin != nil {
		out = append(out, pluginSource{store: d.Plugin, bus: d.Bus}) // api/plugin_events.go
	}
	if d.Skill != nil {
		out = append(out, skillSource{store: d.Skill, bus: d.Bus}) // api/skill.go
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
// are unaffected. Plugins' subscriptions run the same loop (Feed, plugin_feed.go).
func (h *Events) Watch(ctx context.Context, req *connect.Request[v1.WatchEventsRequest], stream *connect.ServerStream[v1.Event]) error {
	since := req.Msg.GetSinceSeq()
	if e := req.Msg.GetSinceEpoch(); e != "" && e != h.deps.Epoch {
		since = 0 // another daemon's seq: start over with the snapshots
	}
	// Quiet sources (gh polling off, no thread busy) get a heartbeat every
	// HeartbeatInterval (see heartbeat.proto).
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	return h.stream(ctx, selectSources(h.sources(), req.Msg.GetSources()), since, streamOut{
		// Before the first send: a GUI that sees an event knows SetClientState will find it.
		joined: func() func() { return h.joinClient(req.Msg) },
		send: func(_ v1.EventSource, ev *v1.Event, _ bool) error {
			beat.Reset()
			return stream.Send(ev)
		},
		beat:  beat.C(),
		flush: true,
	})
}

// streamOut is where stream sends: Watch's client, or a plugin's subscription.
type streamOut struct {
	// joined runs once the stream has joined the hub, before anything is sent; what it
	// returns runs when the stream ends. Nil: nothing.
	joined func() func()
	// send delivers one event of source kind (unspecified for a heartbeat); snapshot
	// marks the events of a source's snapshot. A nil event (with flush) only flushes the
	// response headers.
	send func(kind v1.EventSource, ev *v1.Event, snapshot bool) error
	// beat, when set, asks for a heartbeat event.
	beat <-chan time.Time
	// flush sends a nil event when the first snapshots were empty.
	flush bool
}

// stream is Watch's loop over srcs (see Watch), sending to out until ctx ends or the
// daemon stops.
func (h *Events) stream(ctx context.Context, srcs []eventSource, since uint64, out streamOut) error {
	byKind := make(map[v1.EventSource]eventSource, len(srcs))
	var mask kindMask
	for _, s := range srcs {
		byKind[s.kind()] = s
		mask |= kindBit(s.kind())
	}
	hub := h.eventHub()
	c, replay, resumed := hub.join(mask, since)
	defer hub.leave(c)
	if out.joined != nil {
		defer out.joined()()
	}

	// Snapshots and heartbeats are this stream's own: stamp them (the hub stamped the
	// live events it shares).
	sendOwn := func(kind v1.EventSource, ev *v1.Event, snapshot bool) error {
		ev.Epoch = h.deps.Epoch
		return out.send(kind, ev, snapshot)
	}
	deliver := func(e hubEvent) error {
		if o, ok := byKind[e.kind].(eventObserver); ok {
			o.observe(e.ev)
		}
		return out.send(e.kind, e.ev, false)
	}
	sendSnapshot := func(s eventSource) (int, error) {
		evs := s.snapshot(ctx)
		for _, ev := range evs {
			if err := sendOwn(s.kind(), ev, true); err != nil {
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
	if sent == 0 && out.flush {
		if err := out.send(v1.EventSource_EVENT_SOURCE_UNSPECIFIED, nil, false); err != nil {
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
		case <-out.beat:
			if err := sendOwn(v1.EventSource_EVENT_SOURCE_UNSPECIFIED, &v1.Event{Event: &v1.Event_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}}, false); err != nil {
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
			if e.ev.GetSeq() <= covered[e.kind] {
				continue // older than the snapshot just sent
			}
			if err := deliver(e); err != nil {
				return err
			}
		case e := <-c.tch:
			// No snapshot restores a transient event: never skipped.
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
	return topic{transient: true, open: func() tap {
		return &busTap[T]{sub: bus.Subscribe[T](b, n), conv: conv, transient: true}
	}}
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
	// transient: no snapshot restores the topic's events, so a drop keeps the ones
	// still buffered (see run).
	transient bool
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
				if t.transient {
					// Nothing to resync from: mark the gap, then go on with every
					// event still buffered, this one first.
					dropped = d
					if !emit(nil) {
						return
					}
					if msg = t.conv(ev); msg == nil {
						continue
					}
					break
				}
				// The marker makes the receiver take a snapshot, which is newer than
				// every event still buffered (all published before the newest ones,
				// which were dropped). Emitted after the marker, those older events
				// would be numbered past the snapshot and applied on top of it, and
				// the client would end on stale state. Drop them here instead.
				if !t.drain() {
					return
				}
				dropped = t.sub.Dropped() // drops while draining: the same snapshot covers them
				// msg stays nil: resync
			} else if msg = t.conv(ev); msg == nil {
				continue
			}
		}
		if !emit(msg) {
			return
		}
	}
}

// drain discards the events buffered in the subscription; false when it was closed.
func (t *busTap[T]) drain() bool {
	for {
		select {
		case _, ok := <-t.sub.C():
			if !ok {
				return false
			}
		default:
			return true
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

// ---- project ----------------------------------------------------------------------

type projectSource struct {
	store project.Store
	bus   *bus.Bus
}

func (projectSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_PROJECT }

func (s projectSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, func(ev project.Event) *v1.Event {
		if m := eventToProto(ev); m != nil {
			return &v1.Event{Event: &v1.Event_Project{Project: m}}
		}
		return nil
	})}
}

func (s projectSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{{Event: &v1.Event_Project{Project: &v1.ProjectEvent{Event: &v1.ProjectEvent_Snapshot{
		Snapshot: &v1.ProjectSnapshot{Projects: projectsToProto(s.store.Snapshot().Projects)},
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
		busTopic(s.bus, ghChangedBuffer, func(e gh.PullRequestChanged) *v1.Event { return ghWrap(ghPullRequestChangedEvent(e)) }),
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
