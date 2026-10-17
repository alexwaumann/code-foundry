package api

import (
	"context"
	"sync"
	"sync/atomic"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// eventLogSize is how many live events the hub keeps for resuming streams (since_seq).
const eventLogSize = 4096

// hubClientBuffer is a stream's backlog of live events. A stream that falls further
// behind misses events of a source and gets its snapshot again (Watch's resync).
const hubClientBuffer = 1024

// kindMask is a set of EventSource values (all below 64).
type kindMask uint64

func kindBit(k v1.EventSource) kindMask { return 1 << uint(k) }

func (m kindMask) has(k v1.EventSource) bool { return m&kindBit(k) != 0 }

// hubEvent is a live event on its way to the streams.
type hubEvent struct {
	kind      v1.EventSource
	ev        *v1.Event // seq set; shared by every stream, so never modified after
	transient bool      // from a transient topic: never kept, never skipped by a resync
}

// eventHub is EventService's one fan-out: it subscribes every source's topics once,
// numbers each live event (Event.seq: 1, 2, 3, ... for the daemon's lifetime, so one
// event has the same seq on every stream), keeps the last eventLogSize of them, and
// queues them to the streams that want their source. Snapshots and heartbeats are
// per stream and carry no seq. See docs/notes/agents-1-wait-events.md.
type eventHub struct {
	ctx  context.Context // the topics' subscriptions end with it
	stop context.CancelFunc

	mu  sync.Mutex
	seq uint64 // the last seq given
	// floor: a stream that has applied every event up to floor (since_seq >= floor)
	// can resume from the log; anything older was overwritten or lost to a drop.
	floor     uint64
	log       [eventLogSize]hubEvent // ring, oldest at head
	head, n   int
	clients   map[*hubClient]struct{}
	transient map[v1.EventSource]*transientTopics
}

// transientTopics are a source's transient topics, subscribed while users > 0.
type transientTopics struct {
	topics []topic
	users  int
	open   []tap
}

// hubClient is one Watch stream's end of the hub.
type hubClient struct {
	mask kindMask
	ch   chan hubEvent
	// dirty: sources whose events this client missed; poke wakes it to resync.
	dirty atomic.Uint64
	poke  chan struct{}
}

func (c *hubClient) markDirty(k v1.EventSource) {
	c.dirty.Or(uint64(kindBit(k)))
	select {
	case c.poke <- struct{}{}:
	default:
	}
}

// takeDirty returns and clears the sources to resync.
func (c *hubClient) takeDirty() kindMask { return kindMask(c.dirty.Swap(0)) }

// newEventHub subscribes srcs' topics (transient ones on demand) until done closes; a
// nil done runs for ever.
func newEventHub(done <-chan struct{}, srcs []eventSource) *eventHub {
	ctx, stop := context.WithCancel(context.Background())
	h := &eventHub{ctx: ctx, stop: stop, clients: map[*hubClient]struct{}{}, transient: map[v1.EventSource]*transientTopics{}}
	if done != nil {
		go func() {
			<-done
			h.stop()
		}()
	}
	for _, s := range srcs {
		for _, t := range s.topics() {
			if t.transient {
				tt := h.transient[s.kind()]
				if tt == nil {
					tt = &transientTopics{}
					h.transient[s.kind()] = tt
				}
				tt.topics = append(tt.topics, t)
				continue
			}
			h.start(s.kind(), false, t.open())
		}
	}
	return h
}

// start runs one subscribed topic into the hub.
func (h *eventHub) start(k v1.EventSource, transient bool, t tap) {
	go t.run(h.ctx, func(ev *v1.Event) bool {
		h.publish(k, transient, ev)
		return true
	})
}

// publish numbers ev, keeps it (unless transient), and queues it to every client that
// wants k; a client whose queue is full misses it and resyncs k. A nil ev means the
// hub's own subscription dropped events of k: every client resyncs k, and the log
// starts over, so no resume can reach across the gap.
func (h *eventHub) publish(k v1.EventSource, transient bool, ev *v1.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ev == nil {
		if !transient {
			h.seq++ // the lost events' place: a stream that saw seq-1 has a gap
			h.floor, h.head, h.n = h.seq, 0, 0
			clear(h.log[:])
		}
		for c := range h.clients {
			if c.mask.has(k) {
				c.markDirty(k)
			}
		}
		return
	}
	h.seq++
	ev.Seq = h.seq
	e := hubEvent{kind: k, ev: ev, transient: transient}
	if !transient {
		h.keep(e)
	}
	for c := range h.clients {
		if !c.mask.has(k) {
			continue
		}
		select {
		case c.ch <- e:
		default:
			c.markDirty(k)
		}
	}
}

// keep appends e to the log, overwriting the oldest event when it is full.
func (h *eventHub) keep(e hubEvent) {
	if h.n < eventLogSize {
		h.log[(h.head+h.n)%eventLogSize] = e
		h.n++
		return
	}
	h.floor = h.log[h.head].ev.GetSeq()
	h.log[h.head] = e
	h.head = (h.head + 1) % eventLogSize
}

// lastSeq is the seq of the last event published.
func (h *eventHub) lastSeq() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.seq
}

// join adds a client for the sources in mask. With since > 0 inside the log it also
// returns the kept events after since that the client wants, and resumed: the client
// then skips its snapshots. Registration and the copy happen under one lock, so the
// replay and the live queue neither overlap nor leave a gap.
func (h *eventHub) join(mask kindMask, since uint64) (c *hubClient, replay []hubEvent, resumed bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c = &hubClient{mask: mask, ch: make(chan hubEvent, hubClientBuffer), poke: make(chan struct{}, 1)}
	h.clients[c] = struct{}{}
	for k, tt := range h.transient {
		if !mask.has(k) {
			continue
		}
		if tt.users++; tt.users == 1 {
			for _, t := range tt.topics {
				tp := t.open()
				tt.open = append(tt.open, tp)
				h.start(k, true, tp)
			}
		}
	}
	if since == 0 || since < h.floor || since > h.seq {
		return c, nil, false
	}
	for i := range h.n {
		e := h.log[(h.head+i)%eventLogSize]
		if e.ev.GetSeq() > since && mask.has(e.kind) {
			replay = append(replay, e)
		}
	}
	return c, replay, true
}

// leave removes c, unsubscribing transient topics nobody else wants.
func (h *eventHub) leave(c *hubClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	for k, tt := range h.transient {
		if !c.mask.has(k) {
			continue
		}
		if tt.users--; tt.users == 0 {
			for _, t := range tt.open {
				t.close()
			}
			tt.open = nil
		}
	}
}
