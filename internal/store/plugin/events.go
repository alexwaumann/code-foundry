package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Event subscriptions (events/subscribe, events/unsubscribe, permission events;
// docs/notes/plugins-3-events-flags-env.md): a plugin asks for some of the daemon's
// event sources and gets the same events the GUI's EventService stream carries, as
// events/event notifications (the protojson of codefoundry.v1.Event), each source's
// snapshot first. The API's EventService feeds them (EventFeed); this side queues them
// per plugin and writes them while the plugin keeps up.
//
// Backpressure: the feed never waits on a plugin. Each running plugin has one bounded
// queue (eventQueueMax events, eventQueueBytes bytes); when it is full the oldest event
// goes, the drop is counted and logged (plugin log and daemon log, at most once a
// second), and the dropped event's source is marked for a fresh snapshot, sent once the
// queue has drained. The writer holds back while the plugin's stdin queue holds more
// than eventHighWater bytes, so a slow plugin loses old events instead of being
// restarted for a full queue. Subscriptions end with the plugin's process.

// FeedEvent is one event for a plugin: the source it came from (a manifest event source
// name), whether it is part of a snapshot, and the event as JSON.
type FeedEvent struct {
	Source   string
	Snapshot bool
	Event    json.RawMessage
}

// EventFeed is the daemon's event stream as plugins get it. The API's EventService
// implements it (api.PluginFeed).
type EventFeed interface {
	// Feed checks sources (manifest event source names) and then, in the background,
	// sends each one's snapshot and its live events to send until ctx ends, resending a
	// source's snapshot when the feed itself missed events of it. send must not block.
	Feed(ctx context.Context, sources []string, send func(FeedEvent)) error
	// Snapshot returns a source's current snapshot.
	Snapshot(ctx context.Context, source string) []FeedEvent
}

// Bounds of a plugin's event queue.
const (
	eventQueueMax   = 2048
	eventQueueBytes = 8 << 20
	// eventHighWater is how many bytes may wait in the plugin's stdin queue before the
	// event writer holds back (pluginsdk.MaxQueue is the hard limit).
	eventHighWater = 1 << 20
	// maxSubscriptions a plugin may hold at once.
	maxSubscriptions = 16
)

func eventsGranted(p pluginsdk.Permissions) bool { return len(p.Events) > 0 }

func init() {
	hostMethods[pluginsdk.MethodEventsSubscribe] = hostMethod{perm: eventsGranted, permName: "events", handle: (*actor).subscribe}
	hostMethods[pluginsdk.MethodEventsUnsubscribe] = hostMethod{handle: (*actor).unsubscribe}
	hostCapabilities = append(hostCapabilities, "events")
}

// SetEvents sets the event feed (before Start: the API's EventService needs the store
// first).
func (m *Manager) SetEvents(f EventFeed) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.opts.Events = f
}

func (m *Manager) eventFeed() EventFeed {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.opts.Events
}

// subSource is one source of one subscription.
type subSource struct{ sub, source string }

// queuedEvent is one event waiting for the plugin.
type queuedEvent struct {
	subSource
	snapshot bool
	event    json.RawMessage
}

// eventPump is a running plugin's subscriptions, queue and writer. It lives as long as
// the plugin's process.
type eventPump struct {
	a      *actor
	conn   *pluginsdk.Conn
	feed   EventFeed
	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}
	done   chan struct{}

	mu     sync.Mutex
	next   int
	subs   map[string]context.CancelFunc
	q      []queuedEvent
	qbytes int
	// dirty sources lost events: their snapshot is resent once the queue drains.
	dirty map[subSource]bool
	// dropped counts every event dropped; unlogged those not logged yet.
	dropped, unlogged uint64
	loggedAt          time.Time
}

func newEventPump(a *actor, conn *pluginsdk.Conn, feed EventFeed) *eventPump {
	ctx, cancel := context.WithCancel(context.Background())
	p := &eventPump{a: a, conn: conn, feed: feed, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), done: make(chan struct{}),
		subs: map[string]context.CancelFunc{}, dirty: map[subSource]bool{}}
	go p.run()
	return p
}

// close ends every subscription and the writer.
func (p *eventPump) close() {
	p.cancel()
	<-p.done
}

// push queues an event, dropping the oldest when the queue is full. It never blocks.
func (p *eventPump) push(sub string, fe FeedEvent) {
	p.mu.Lock()
	if _, ok := p.subs[sub]; !ok {
		p.mu.Unlock()
		return
	}
	p.q = append(p.q, queuedEvent{subSource: subSource{sub, fe.Source}, snapshot: fe.Snapshot, event: fe.Event})
	p.qbytes += len(fe.Event)
	for len(p.q) > 1 && (len(p.q) > eventQueueMax || p.qbytes > eventQueueBytes) {
		old := p.q[0]
		p.q[0] = queuedEvent{}
		p.q = p.q[1:]
		p.qbytes -= len(old.event)
		p.dropped++
		p.unlogged++
		p.dirty[old.subSource] = true
	}
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// subscribe starts a subscription to sources.
func (p *eventPump) subscribe(sources []string) (string, error) {
	p.mu.Lock()
	if len(p.subs) >= maxSubscriptions {
		p.mu.Unlock()
		return "", pluginsdk.NewError(pluginsdk.CodeRateLimited, "events/subscribe: at most %d subscriptions at once", maxSubscriptions)
	}
	p.next++
	id := "sub-" + strconv.Itoa(p.next)
	ctx, cancel := context.WithCancel(p.ctx)
	p.subs[id] = cancel
	p.mu.Unlock()
	if err := p.feed.Feed(ctx, sources, func(fe FeedEvent) { p.push(id, fe) }); err != nil {
		p.drop(id)
		return "", pluginsdk.NewError(pluginsdk.CodeInvalidParams, "events/subscribe: %v", err)
	}
	return id, nil
}

// drop ends a subscription and forgets its queued events; false when there was none.
func (p *eventPump) drop(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	cancel, ok := p.subs[id]
	if !ok {
		return false
	}
	cancel()
	delete(p.subs, id)
	p.q = slices.DeleteFunc(p.q, func(e queuedEvent) bool {
		if e.sub == id {
			p.qbytes -= len(e.event)
			return true
		}
		return false
	})
	for k := range p.dirty {
		if k.sub == id {
			delete(p.dirty, k)
		}
	}
	return true
}

// take returns the next event to write: the queue's oldest, else, with the queue empty,
// the snapshot of a source that lost events (resync true). ok is false when there is
// nothing to do.
func (p *eventPump) take() (e queuedEvent, resync, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.q) > 0 {
		e = p.q[0]
		p.q[0] = queuedEvent{}
		p.q = p.q[1:]
		p.qbytes -= len(e.event)
		return e, false, true
	}
	for k := range p.dirty {
		delete(p.dirty, k)
		if _, live := p.subs[k.sub]; live {
			return queuedEvent{subSource: k}, true, true
		}
	}
	return queuedEvent{}, false, false
}

// logDrops writes a line about dropped events, at most once a second.
func (p *eventPump) logDrops() {
	p.mu.Lock()
	now := p.a.m.opts.Now()
	if p.unlogged == 0 || now.Sub(p.loggedAt) < time.Second {
		p.mu.Unlock()
		return
	}
	n, total := p.unlogged, p.dropped
	p.unlogged, p.loggedAt = 0, now
	var srcs []string
	for k := range p.dirty {
		srcs = append(srcs, k.source)
	}
	p.mu.Unlock()
	slices.Sort(srcs)
	srcs = slices.Compact(srcs)
	p.a.hostLog("events: dropped %d events (%d in all): the plugin is not keeping up; resending the snapshot of %s",
		n, total, strings.Join(srcs, ", "))
	p.a.m.log.Warn("plugin dropped events", "plugin", p.a.name, "dropped", n, "total", total)
}

// run writes queued events to the plugin until the pump closes.
func (p *eventPump) run() {
	defer close(p.done)
	for {
		p.logDrops()
		e, resync, ok := p.take()
		if !ok {
			select {
			case <-p.ctx.Done():
				return
			case <-p.wake:
			case <-time.After(time.Second): // logDrops
			}
			continue
		}
		if !resync {
			if !p.write(e) {
				return
			}
			continue
		}
		for _, fe := range p.feed.Snapshot(p.ctx, e.source) {
			if !p.write(queuedEvent{subSource: e.subSource, snapshot: true, event: fe.Event}) {
				return
			}
		}
	}
}

// write sends one events/event once the plugin's stdin queue is below the high water
// mark; false when the pump is closing or the plugin is gone.
func (p *eventPump) write(e queuedEvent) bool {
	for p.conn.Queued() > eventHighWater {
		select {
		case <-p.ctx.Done():
			return false
		case <-time.After(10 * time.Millisecond):
		}
	}
	p.mu.Lock()
	_, live := p.subs[e.sub]
	p.mu.Unlock()
	if !live {
		return true
	}
	err := p.conn.Notify(pluginsdk.MethodEventsEvent, pluginsdk.Event{Subscription: e.sub, Snapshot: e.snapshot, Event: e.event})
	switch {
	case errors.Is(err, pluginsdk.ErrClosed):
		return false
	case err != nil:
		p.a.hostLog("events: %v", err)
	}
	return true
}

// pump returns the running plugin's event pump, starting it on first use; nil when
// the plugin is not running or there is no feed.
func (a *actor) pump() *eventPump {
	feed := a.m.eventFeed()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn == nil || feed == nil {
		return nil
	}
	if a.events == nil {
		a.events = newEventPump(a, a.conn, feed)
	}
	return a.events
}

// closeEvents ends the run's subscriptions (the process ended).
func (a *actor) closeEvents() {
	a.mu.Lock()
	p := a.events
	a.events = nil
	a.mu.Unlock()
	if p != nil {
		p.close()
	}
}

// subscribe serves events/subscribe.
func (a *actor) subscribe(_ context.Context, params json.RawMessage) (any, error) {
	if a.m.eventFeed() == nil {
		return nil, notServed(pluginsdk.MethodEventsSubscribe)
	}
	sp, err := decodeParams[pluginsdk.SubscribeParams](pluginsdk.MethodEventsSubscribe, params)
	if err != nil {
		return nil, err
	}
	granted := a.permissions().Events
	var sources []string
	for _, s := range sp.Sources {
		if !slices.Contains(granted, s) {
			a.hostLog("refused events/subscribe %s: not in permissions.events", s)
			return nil, pluginsdk.NewError(pluginsdk.CodePermissionDenied, "permission denied: event source %q is not in plugin.json's permissions.events", s)
		}
		if !slices.Contains(sources, s) {
			sources = append(sources, s)
		}
	}
	if len(sources) == 0 {
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "events/subscribe: no sources")
	}
	p := a.pump()
	if p == nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeUnavailable, "events/subscribe: the plugin is not running")
	}
	id, err := p.subscribe(sources)
	if err != nil {
		return nil, err
	}
	a.hostLog("subscribed %s to %s", id, strings.Join(sources, ", "))
	return pluginsdk.SubscribeResult{Subscription: id}, nil
}

// unsubscribe serves events/unsubscribe.
func (a *actor) unsubscribe(_ context.Context, params json.RawMessage) (any, error) {
	sp, err := decodeParams[pluginsdk.SubscribeResult](pluginsdk.MethodEventsUnsubscribe, params)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	p := a.events
	a.mu.Unlock()
	if p == nil || !p.drop(sp.Subscription) {
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "events/unsubscribe: no subscription %q", sp.Subscription)
	}
	a.hostLog("unsubscribed %s", sp.Subscription)
	return struct{}{}, nil
}
