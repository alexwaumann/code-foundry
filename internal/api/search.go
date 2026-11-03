package api

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/search"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SearchStore is the search store (*search.Store) as SearchService drives it.
type SearchStore interface {
	StartAgent(ctx context.Context, question string) (search.Entry, error)
	Stop(ctx context.Context, id string) (search.Entry, error)
	Wait(ctx context.Context, id string) (search.Entry, error)
	List() []search.Entry
	Get(id string) (search.Entry, error)
	OpenHit(ctx context.Context, id string, n int) (search.Entry, error)
	MarkSeen(ctx context.Context, id string) (search.Entry, error)
	RecordFind(ctx context.Context, query string, hits int) (search.Entry, error)
	Forget(ctx context.Context, id string) error
	Clear(ctx context.Context) (int, error)
	Promote(ctx context.Context, id string) (string, error)
	Report(ctx context.Context, searchID, threadID, item, quote, why string) (search.Hit, int, error)
}

var _ SearchStore = (*search.Store)(nil)

// Search implements codefoundryv1connect.SearchServiceHandler over the search store
// (docs/notes/search-5-agent-daemon.md).
type Search struct {
	store SearchStore
	bus   *bus.Bus
	beat  time.Duration // heartbeat interval; zero is HeartbeatInterval
}

var _ codefoundryv1connect.SearchServiceHandler = (*Search)(nil)

// NewSearch returns a SearchService handler. b must be the bus the store publishes on.
func NewSearch(store SearchStore, b *bus.Bus) *Search {
	return &Search{store: store, bus: b}
}

// Route mounts the service.
func (h *Search) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewSearchServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Wait blocks until search id has ended and returns it (search.agent's Run).
func (h *Search) Wait(ctx context.Context, id string) (*v1.SearchEntry, error) {
	e, err := h.store.Wait(ctx, id)
	if err != nil {
		return nil, searchError(err)
	}
	return SearchEntryToProto(e), nil
}

// StartAgent starts an agent search.
func (h *Search) StartAgent(ctx context.Context, req *connect.Request[v1.StartAgentSearchRequest]) (*connect.Response[v1.StartAgentSearchResponse], error) {
	e, err := h.store.StartAgent(ctx, req.Msg.GetQuestion())
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.StartAgentSearchResponse{Entry: SearchEntryToProto(e)}), nil
}

// Watch sends the entry, then its changes, until the run ends. The bus may drop an event
// (a full buffer), the run's last one too: after a drop and at every heartbeat the entry
// is read again, and a version the stream has not sent comes as a snapshot, which ends
// the stream when the search has ended (or NOT_FOUND once it is forgotten).
func (h *Search) Watch(ctx context.Context, req *connect.Request[v1.WatchSearchRequest], stream *connect.ServerStream[v1.SearchWatchEvent]) error {
	id := req.Msg.GetId()
	sub := bus.Subscribe[search.Changed](h.bus, watchBuffer)
	defer sub.Close()
	e, err := h.store.Get(id)
	if err != nil {
		return searchError(err)
	}
	sendSnapshot := func(e search.Entry) error {
		return stream.Send(&v1.SearchWatchEvent{Version: e.Version, Event: &v1.SearchWatchEvent_Snapshot{Snapshot: SearchEntryToProto(e)}})
	}
	if err := sendSnapshot(e); err != nil {
		return err
	}
	if e.Mode != search.ModeAgent || e.Status.Ended() {
		return nil
	}
	last := e.Version
	// resync sends the entry as it is now when its version moved past last; end is true
	// once the stream is over (the search ended or is gone, or the send failed).
	resync := func() (sent, end bool, err error) {
		now, err := h.store.Get(id)
		if err != nil {
			if errors.Is(err, search.ErrNotFound) {
				return false, true, connect.NewError(connect.CodeNotFound, errors.New("the search was forgotten"))
			}
			return false, true, searchError(err)
		}
		if now.Version == last {
			return false, now.Status.Ended(), nil
		}
		if err := sendSnapshot(now); err != nil {
			return false, true, err
		}
		last = now.Version
		return true, now.Status.Ended(), nil
	}
	var dropped uint64
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-beat.C():
			beat.Reset()
			sent, end, err := resync()
			if end || err != nil {
				return err
			}
			if sent {
				continue
			}
			if err := stream.Send(&v1.SearchWatchEvent{Event: &v1.SearchWatchEvent_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}}); err != nil {
				return err
			}
		case c, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				// Something was lost, maybe this search's last event: read it again.
				dropped = d
				beat.Reset()
				if _, end, err := resync(); end || err != nil {
					return err
				}
			}
			if c.ID != id || (c.Version <= last && c.Kind != search.EventRemoved) {
				continue
			}
			beat.Reset()
			ev, end := watchEvent(c)
			if c.Kind == search.EventRemoved {
				return connect.NewError(connect.CodeNotFound, errors.New("the search was forgotten"))
			}
			// A gap (the bus dropped an event) or a change only a snapshot says: the
			// entry as it is now.
			if ev == nil || c.Version != last+1 {
				_, end, err := resync()
				if end || err != nil {
					return err
				}
				continue
			}
			if err := stream.Send(ev); err != nil {
				return err
			}
			last = c.Version
			if end {
				return nil
			}
		}
	}
}

// watchEvent is c as a Watch event (nil for one a snapshot must say), and whether it
// ends the stream.
func watchEvent(c search.Changed) (*v1.SearchWatchEvent, bool) {
	ev := &v1.SearchWatchEvent{Version: c.Version}
	switch c.Kind {
	case search.EventStep:
		ev.Event = &v1.SearchWatchEvent_Step{Step: searchStepToProto(c.Step)}
	case search.EventHit:
		ev.Event = &v1.SearchWatchEvent_Hit{Hit: searchHitToProto(c.Hit)}
	case search.EventAnswer:
		ev.Event = &v1.SearchWatchEvent_Answer{Answer: &v1.SearchAnswer{Text: c.Answer}}
	case search.EventStatus:
		e := c.Entry
		ev.Event = &v1.SearchWatchEvent_Status{Status: &v1.SearchStatusChange{Status: searchStatuses[e.Status], Error: e.Error,
			FinishedAt: optTime(e.FinishedAt), CostUsd: e.CostUSD, DurationMs: e.Duration.Milliseconds(), Unseen: e.Unseen}}
		return ev, true
	default:
		return nil, false
	}
	return ev, false
}

// WatchRecent sends the history now and after every change.
func (h *Search) WatchRecent(ctx context.Context, _ *connect.Request[v1.WatchRecentSearchesRequest], stream *connect.ServerStream[v1.WatchRecentSearchesEvent]) error {
	sub := bus.Subscribe[search.Changed](h.bus, watchBuffer)
	defer sub.Close()
	send := func() error {
		return stream.Send(&v1.WatchRecentSearchesEvent{Entries: searchEntriesToProto(h.store.List())})
	}
	if err := send(); err != nil {
		return err
	}
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-beat.C():
			beat.Reset()
			if err := stream.Send(&v1.WatchRecentSearchesEvent{Heartbeat: &v1.StreamHeartbeat{}}); err != nil {
				return err
			}
		case _, ok := <-sub.C():
			if !ok {
				return nil
			}
			// The list says it all: send it once for a burst.
			for len(sub.C()) > 0 {
				<-sub.C()
			}
			beat.Reset()
			if err := send(); err != nil {
				return err
			}
		}
	}
}

// Stop stops a running search.
func (h *Search) Stop(ctx context.Context, req *connect.Request[v1.StopSearchRequest]) (*connect.Response[v1.StopSearchResponse], error) {
	e, err := h.store.Stop(ctx, req.Msg.GetId())
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.StopSearchResponse{Entry: SearchEntryToProto(e)}), nil
}

// ListRecent is the history.
func (h *Search) ListRecent(context.Context, *connect.Request[v1.ListRecentSearchesRequest]) (*connect.Response[v1.ListRecentSearchesResponse], error) {
	return connect.NewResponse(&v1.ListRecentSearchesResponse{Entries: searchEntriesToProto(h.store.List())}), nil
}

// Get is one entry.
func (h *Search) Get(_ context.Context, req *connect.Request[v1.GetSearchRequest]) (*connect.Response[v1.GetSearchResponse], error) {
	e, err := h.store.Get(req.Msg.GetId())
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.GetSearchResponse{Entry: SearchEntryToProto(e)}), nil
}

// OpenHit marks a hit opened.
func (h *Search) OpenHit(ctx context.Context, req *connect.Request[v1.OpenSearchHitRequest]) (*connect.Response[v1.OpenSearchHitResponse], error) {
	e, err := h.store.OpenHit(ctx, req.Msg.GetId(), int(req.Msg.GetN()))
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.OpenSearchHitResponse{Entry: SearchEntryToProto(e)}), nil
}

// MarkSeen clears the unseen flag.
func (h *Search) MarkSeen(ctx context.Context, req *connect.Request[v1.MarkSearchSeenRequest]) (*connect.Response[v1.MarkSearchSeenResponse], error) {
	e, err := h.store.MarkSeen(ctx, req.Msg.GetId())
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.MarkSearchSeenResponse{Entry: SearchEntryToProto(e)}), nil
}

// RecordFind records a Find entry.
func (h *Search) RecordFind(ctx context.Context, req *connect.Request[v1.RecordFindSearchRequest]) (*connect.Response[v1.RecordFindSearchResponse], error) {
	e, err := h.store.RecordFind(ctx, req.Msg.GetQuery(), int(req.Msg.GetHits()))
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.RecordFindSearchResponse{Entry: SearchEntryToProto(e)}), nil
}

// Forget removes one entry.
func (h *Search) Forget(ctx context.Context, req *connect.Request[v1.ForgetSearchRequest]) (*connect.Response[v1.ForgetSearchResponse], error) {
	if err := h.store.Forget(ctx, req.Msg.GetId()); err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.ForgetSearchResponse{}), nil
}

// Clear forgets every entry.
func (h *Search) Clear(ctx context.Context, _ *connect.Request[v1.ClearSearchesRequest]) (*connect.Response[v1.ClearSearchesResponse], error) {
	n, err := h.store.Clear(ctx)
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.ClearSearchesResponse{Removed: int32(n)}), nil
}

// Promote makes a thread that continues the search's conversation.
func (h *Search) Promote(ctx context.Context, req *connect.Request[v1.PromoteSearchRequest]) (*connect.Response[v1.PromoteSearchResponse], error) {
	id, err := h.store.Promote(ctx, req.Msg.GetId())
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.PromoteSearchResponse{ThreadId: id}), nil
}

// Report records a hit the run found.
func (h *Search) Report(ctx context.Context, req *connect.Request[v1.ReportSearchHitRequest]) (*connect.Response[v1.ReportSearchHitResponse], error) {
	m := req.Msg
	hit, left, err := h.store.Report(ctx, m.GetSearchId(), m.GetThreadId(), m.GetItem(), m.GetQuote(), m.GetWhy())
	if err != nil {
		return nil, searchError(err)
	}
	return connect.NewResponse(&v1.ReportSearchHitResponse{Hit: searchHitToProto(hit), Left: int32(left)}), nil
}

func searchError(err error) error {
	var ce *connect.Error
	switch {
	case errors.As(err, &ce):
		return err
	case errors.Is(err, search.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, search.ErrInvalidArgument):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, search.ErrFailedPrecondition), errors.Is(err, search.ErrClosed):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	// Promote's Create.
	return threadError(err)
}

var searchModes = map[search.Mode]v1.SearchMode{
	search.ModeAgent: v1.SearchMode_SEARCH_MODE_AGENT,
	search.ModeFind:  v1.SearchMode_SEARCH_MODE_FIND,
}

var searchStatuses = map[search.Status]v1.SearchStatus{
	search.StatusRunning: v1.SearchStatus_SEARCH_STATUS_RUNNING,
	search.StatusDone:    v1.SearchStatus_SEARCH_STATUS_DONE,
	search.StatusFailed:  v1.SearchStatus_SEARCH_STATUS_FAILED,
	search.StatusStopped: v1.SearchStatus_SEARCH_STATUS_STOPPED,
}

var searchStepKinds = map[search.StepKind]v1.AgentSearchStepKind{
	search.StepSearch: v1.AgentSearchStepKind_AGENT_SEARCH_STEP_KIND_SEARCH,
	search.StepRead:   v1.AgentSearchStepKind_AGENT_SEARCH_STEP_KIND_READ,
	search.StepOther:  v1.AgentSearchStepKind_AGENT_SEARCH_STEP_KIND_OTHER,
}

func searchEntriesToProto(list []search.Entry) []*v1.SearchEntry {
	out := make([]*v1.SearchEntry, len(list))
	for i, e := range list {
		out[i] = SearchEntryToProto(e)
	}
	return out
}

// SearchEntryToProto is e on the API.
func SearchEntryToProto(e search.Entry) *v1.SearchEntry {
	out := &v1.SearchEntry{Id: e.ID, Mode: searchModes[e.Mode], Query: e.Query, CreatedAt: optTime(e.CreatedAt),
		FinishedAt: optTime(e.FinishedAt), Status: searchStatuses[e.Status], Error: e.Error, Answer: e.Answer,
		Hits: make([]*v1.AgentSearchHit, len(e.Hits)), Steps: make([]*v1.AgentSearchStep, len(e.Steps)),
		Searches: int32(e.Searches()), ThreadsRead: int32(e.ThreadsRead()), ClaudeSessionId: e.ClaudeSessionID, Model: e.Model,
		CostUsd: e.CostUSD, DurationMs: e.Duration.Milliseconds(), Unseen: e.Unseen, Version: e.Version, PromotedThreadId: e.PromotedThreadID,
		FindHits: int32(e.FindHits)}
	for i, h := range e.Hits {
		out.Hits[i] = searchHitToProto(h)
	}
	for i, s := range e.Steps {
		out.Steps[i] = searchStepToProto(s)
	}
	return out
}

func searchHitToProto(h search.Hit) *v1.AgentSearchHit {
	return &v1.AgentSearchHit{N: int32(h.N), ThreadId: h.ThreadID, ThreadName: h.ThreadName, Archived: h.Archived, ItemId: h.ItemID,
		Ordinal: h.Ordinal, Speaker: searchSpeakers[thread.Speaker(h.Speaker)], ItemCreatedAt: optTime(h.ItemCreatedAt),
		Quote: h.Quote, Why: h.Why, Opened: h.Opened, ReportedAt: optTime(h.ReportedAt)}
}

func searchStepToProto(s search.Step) *v1.AgentSearchStep {
	return &v1.AgentSearchStep{Index: int32(s.Index), Kind: searchStepKinds[s.Kind], Done: s.Done, Failed: s.Failed, Text: s.Text,
		Query: s.Query, Hits: int32(s.Hits), ThreadId: s.ThreadID, ThreadName: s.ThreadName, FromOrdinal: s.From, ToOrdinal: s.To}
}
