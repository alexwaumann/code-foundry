package api

import (
	"context"
	"slices"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A watched thread's wake list (docs/notes/wait-list-daemon.md). It rides on WatchThread,
// the one stream a visible thread view holds: the snapshot carries the list, then a
// frame goes out whenever it differs from the last one sent. The store says when the
// list itself changed (SubscriptionsChanged); a target's name and status are read at list
// time, so the feed also looks every wakeRefresh, which is what a pull request's checks,
// a plugin's state or a timer coming due need (none of them is worth a hook: the poll
// behind a pull request is slower than this anyway). A thread target's row reads the
// thread itself from the client's thread list.

// wakeRefresh is how often a watched thread's wake list is read again.
const wakeRefresh = 15 * time.Second

// wakeFeed is one WatchThread's side of the wake list. WatchThread's goroutine owns it.
type wakeFeed struct {
	store   thread.Store
	ctx     context.Context
	id      string
	changes *bus.Subscription[thread.SubscriptionsChanged]
	tick    *time.Ticker
	dropped uint64
	last    []*v1.ThreadSubscription
}

func (h *Thread) newWakeFeed(ctx context.Context, id string) *wakeFeed {
	every := h.wakes
	if every <= 0 {
		every = wakeRefresh
	}
	return &wakeFeed{store: h.store, ctx: ctx, id: id, changes: bus.Subscribe[thread.SubscriptionsChanged](h.bus, watchBuffer), tick: time.NewTicker(every)}
}

func (f *wakeFeed) close() {
	f.tick.Stop()
	f.changes.Close()
}

// list reads the thread's subscriptions; false when it cannot (the thread went, which
// WatchThread ends the stream for).
func (f *wakeFeed) list() ([]*v1.ThreadSubscription, bool) {
	subs, err := f.store.Subscriptions(f.ctx, f.id)
	if err != nil {
		return nil, false
	}
	out := make([]*v1.ThreadSubscription, len(subs))
	for i, s := range subs {
		out[i] = subscriptionToProto(s)
	}
	return out, true
}

// snapshot is WatchThread's snapshot event, with the wake list.
func (f *wakeFeed) snapshot(snap thread.ItemsSnapshot) *v1.ThreadEvent {
	p := itemsSnapshotToProto(snap)
	if subs, ok := f.list(); ok {
		f.last, p.Subscriptions = subs, subs
	}
	return &v1.ThreadEvent{Event: &v1.ThreadEvent_Snapshot{Snapshot: p}}
}

// changed is read for a change to this thread's subscriptions, or after missed events.
func (f *wakeFeed) changed(ev thread.SubscriptionsChanged) *v1.ThreadEvent {
	d := f.changes.Dropped()
	if d == f.dropped && ev.SubscriberID != f.id {
		return nil
	}
	f.dropped = d
	return f.read()
}

// read is the frame for the list as it is now; nil when it is what was sent last.
func (f *wakeFeed) read() *v1.ThreadEvent {
	subs, ok := f.list()
	if !ok || slices.EqualFunc(subs, f.last, func(a, b *v1.ThreadSubscription) bool { return proto.Equal(a, b) }) {
		return nil
	}
	f.last = subs
	return &v1.ThreadEvent{Event: &v1.ThreadEvent_Subscriptions{Subscriptions: &v1.ThreadSubscriptionsChange{ThreadId: f.id, Subscriptions: subs}}}
}

// StopWaiting removes everything that would wake a thread.
func (h *Thread) StopWaiting(ctx context.Context, req *connect.Request[v1.StopThreadWaitingRequest]) (*connect.Response[v1.StopThreadWaitingResponse], error) {
	res, err := h.store.StopWaiting(ctx, req.Msg.GetThreadId())
	if err != nil {
		return nil, threadError(err)
	}
	out := &v1.StopThreadWaitingResponse{Thread: threadToProto(res.Thread), StoppedShells: backgroundShellsToProto(res.Shells)}
	for _, s := range res.Removed {
		out.Removed = append(out.Removed, subscriptionToProto(s))
	}
	return connect.NewResponse(out), nil
}
