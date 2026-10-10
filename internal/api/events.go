package api

import (
	"context"
	"slices"
	"sync"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
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
	Session  session.Store
	Gh       gh.Service
	GitOps   gitops.Store
	Settings settings.Service
	Update   update.Service
	// Workspace is the workspace store (branch sets).
	Workspace workspace.Store
	// Done ends every stream when closed (daemon shutdown). May be nil.
	Done <-chan struct{}
}

// Events implements codefoundryv1connect.EventServiceHandler: one server stream that
// carries every store's Watch events and UI intents, so a browser holds one connection
// instead of one per service.
type Events struct {
	deps EventsDeps
}

var _ codefoundryv1connect.EventServiceHandler = (*Events)(nil)

// NewEvents returns an EventService handler.
func NewEvents(deps EventsDeps) *Events { return &Events{deps: deps} }

// Route mounts the service.
func (h *Events) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewEventServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// eventSource is one store's contribution to Watch. Sources are built per stream, so
// they may keep per-client state.
type eventSource interface {
	kind() v1.EventSource
	// subscribe starts live delivery until ctx ends and closes the channel then. It is
	// called before snapshot, so nothing published in between is lost; events queued
	// before the snapshot carry full state, so applying them in order still converges.
	// A nil event means the source dropped events for this client: the multiplexer
	// resends snapshot instead.
	subscribe(ctx context.Context) <-chan *v1.Event
	// snapshot returns the events that bring a client to the source's current state.
	snapshot(ctx context.Context) []*v1.Event
}

// sources lists the stream's sources in the order their snapshots are sent (see
// events.proto: repo, workspace, terminal, session, gh, gitops, settings, update),
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
	if d.Session != nil {
		out = append(out, sessionSource{store: d.Session, bus: d.Bus})
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

type tagged struct {
	src int
	ev  *v1.Event
}

// Watch subscribes every requested source, sends their snapshots, then live events
// until the client goes away or the daemon stops. When a source drops events for a
// slow client, that source's snapshot is sent again; other sources are unaffected.
func (h *Events) Watch(ctx context.Context, req *connect.Request[v1.WatchEventsRequest], stream *connect.ServerStream[v1.Event]) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srcs := selectSources(h.sources(), req.Msg.GetSources())

	merged := make(chan tagged)
	for i, s := range srcs {
		ch := s.subscribe(ctx)
		go func() {
			for ev := range ch {
				select {
				case merged <- tagged{i, ev}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	sendSnapshot := func(s eventSource) (int, error) {
		evs := s.snapshot(ctx)
		for _, ev := range evs {
			if err := stream.Send(ev); err != nil {
				return 0, err
			}
		}
		return len(evs), nil
	}
	sent := 0
	for _, s := range srcs {
		n, err := sendSnapshot(s)
		if err != nil {
			return err
		}
		sent += n
	}
	// Flush response headers now if no snapshot did: clients block until they arrive,
	// and the first live event may be a long way off.
	if sent == 0 {
		if err := stream.Send(nil); err != nil {
			return err
		}
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-h.deps.Done:
			return nil
		case t := <-merged:
			if t.ev == nil {
				if _, err := sendSnapshot(srcs[t.src]); err != nil {
					return err
				}
				continue
			}
			if err := stream.Send(t.ev); err != nil {
				return err
			}
		}
	}
}

// tap is one bus subscription feeding a source's channel.
type tap interface {
	run(ctx context.Context, out chan<- *v1.Event)
}

type busTap[T any] struct {
	sub  *bus.Subscription[T]
	conv func(T) *v1.Event
}

// newTap subscribes to T now (so the caller can take a snapshot afterwards) with a
// buffer of n events: the source's bounded backlog for a slow client.
func newTap[T any](b *bus.Bus, n int, conv func(T) *v1.Event) tap {
	return &busTap[T]{sub: bus.Subscribe[T](b, n), conv: conv}
}

func (t *busTap[T]) run(ctx context.Context, out chan<- *v1.Event) {
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
		select {
		case out <- msg:
		case <-ctx.Done():
			return
		}
	}
}

// fanIn runs already subscribed taps and merges them into one channel, closed once all
// have stopped. Order is kept within a tap, not across taps (as terminal.Manager.Watch).
func fanIn(ctx context.Context, taps ...tap) <-chan *v1.Event {
	out := make(chan *v1.Event)
	var wg sync.WaitGroup
	for _, t := range taps {
		wg.Go(func() { t.run(ctx, out) })
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

func (s repoSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx, newTap(s.bus, watchBuffer, func(ev repo.Event) *v1.Event {
		if m := eventToProto(ev); m != nil {
			return &v1.Event{Event: &v1.Event_Repo{Repo: m}}
		}
		return nil
	}))
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

func (s workspaceSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx, newTap(s.bus, watchBuffer, workspaceWrap))
}

func (s workspaceSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{workspaceWrap(s.store.Snapshot())}
}

// ---- terminal ------------------------------------------------------------------

// terminalSource has no snapshot message in terminal.proto, so its snapshot is one
// `updated` per terminal plus `removed_id` for every terminal this client was told
// about that no longer exists. That makes a resync after drops converge too.
type terminalSource struct {
	store terminal.Store
	bus   *bus.Bus
	mu    sync.Mutex
	known map[string]bool // ids sent to this client and not removed since
}

func (*terminalSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_TERMINAL }

func (s *terminalSource) wrap(ev terminal.Event) *v1.Event {
	s.mu.Lock()
	if ev.Updated != nil {
		s.known[ev.Updated.ID] = true
	} else {
		delete(s.known, ev.RemovedID)
	}
	s.mu.Unlock()
	return &v1.Event{Event: &v1.Event_Terminal{Terminal: terminalEventToProto(ev)}}
}

func (s *terminalSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx,
		newTap(s.bus, terminalWatchBuffer, func(u terminal.TerminalUpdated) *v1.Event {
			return s.wrap(terminal.Event{Updated: &u.Terminal})
		}),
		newTap(s.bus, terminalWatchBuffer, func(r terminal.TerminalRemoved) *v1.Event {
			return s.wrap(terminal.Event{RemovedID: r.ID})
		}),
	)
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

// ---- session -------------------------------------------------------------------

// sessionSource reuses SessionService's mapping (api/session.go). The store publishes
// one bus type, session.Event; its snapshot is a SessionEvent.snapshot.
type sessionSource struct {
	store session.Store
	bus   *bus.Bus
}

func (sessionSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_SESSION }

func sessionWrap(ev session.Event) *v1.Event {
	if m := sessionEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_Session{Session: m}}
	}
	return nil
}

func (s sessionSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx, newTap(s.bus, watchBuffer, sessionWrap))
}

func (s sessionSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{sessionWrap(s.store.Snapshot())}
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

func (s ghSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx,
		newTap(s.bus, ghWatchBuffer, func(e gh.Polled) *v1.Event { return ghWrap(ghPolledEvent(e)) }),
		newTap(s.bus, ghWatchBuffer, func(e gh.ViewerUpdated) *v1.Event { return ghWrap(ghViewerEvent(e)) }),
		newTap(s.bus, ghWatchBuffer, func(e gh.DashboardUpdated) *v1.Event { return ghWrap(ghDashboardEvent(e)) }),
		newTap(s.bus, ghWatchBuffer, func(e gh.RepoActivityUpdated) *v1.Event { return ghWrap(ghRepoActivityEvent(e)) }),
		newTap(s.bus, ghWatchBuffer, func(e gh.BranchPullRequestsUpdated) *v1.Event { return ghWrap(ghBranchEvent(e)) }),
		newTap(s.bus, ghWatchBuffer, func(e gh.PullRequestDetailUpdated) *v1.Event { return ghWrap(ghDetailEvent(e)) }),
	)
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

func (s gitopsSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx, newTap(s.bus, gitopsWatchBuffer, func(ev gitops.Event) *v1.Event {
		if m := gitopsEventToProto(ev); m != nil {
			return gitopsWrap(m)
		}
		return nil
	}))
}

func (s gitopsSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{gitopsWrap(gitopsSnapshotEvent(s.store.Snapshot()))}
}

// ---- ui ------------------------------------------------------------------------

// uiSource carries intents. They are fire-and-forget: there is no state to snapshot,
// and intents dropped for a slow client are lost (as with UiService.WatchIntents).
type uiSource struct {
	bus *bus.Bus
}

func (uiSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_UI }

func (s uiSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx, newTap(s.bus, intentBuffer, func(ev command.IntentEvent) *v1.Event {
		if ev.Intent == nil {
			return nil
		}
		return &v1.Event{Event: &v1.Event_Ui{Ui: ev.Intent}}
	}))
}

func (uiSource) snapshot(context.Context) []*v1.Event { return nil }
