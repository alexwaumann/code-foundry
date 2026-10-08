// Package bus is a typed, in-process publish/subscribe event bus.
//
// Events are routed by their Go type. Each subscriber has a bounded buffer; Publish
// never blocks. If a subscriber's buffer is full the event is dropped for that
// subscriber only, and the drop is counted on both the subscription and the bus.
//
//	b := bus.New()
//	sub := bus.Subscribe[SessionChanged](b, 64)
//	defer sub.Close()
//	bus.Publish(b, SessionChanged{ID: "s1"})
//	ev := <-sub.C()
package bus

import (
	"reflect"
	"sync"
	"sync/atomic"
)

// DefaultBuffer is the per-subscriber buffer size used when Subscribe is given n <= 0.
const DefaultBuffer = 64

// Bus routes events to subscribers by type. The zero value is not usable; use New.
type Bus struct {
	mu     sync.RWMutex
	nextID uint64
	topics map[reflect.Type]map[uint64]any // values are *Subscription[T]
	drops  atomic.Uint64
}

// New returns an empty bus.
func New() *Bus {
	return &Bus{topics: make(map[reflect.Type]map[uint64]any)}
}

// Dropped returns the total number of events dropped across all subscribers.
func (b *Bus) Dropped() uint64 { return b.drops.Load() }

// Subscription receives events of type T. Read from C until it is closed.
type Subscription[T any] struct {
	bus   *Bus
	key   reflect.Type
	id    uint64
	ch    chan T
	drops atomic.Uint64
	once  sync.Once
}

// C returns the receive channel. It is closed by Close.
func (s *Subscription[T]) C() <-chan T { return s.ch }

// Dropped returns how many events this subscriber missed because its buffer was full.
func (s *Subscription[T]) Dropped() uint64 { return s.drops.Load() }

// Close unsubscribes and closes C. It is safe to call more than once.
func (s *Subscription[T]) Close() {
	s.once.Do(func() {
		s.bus.mu.Lock()
		defer s.bus.mu.Unlock()
		if subs := s.bus.topics[s.key]; subs != nil {
			delete(subs, s.id)
			if len(subs) == 0 {
				delete(s.bus.topics, s.key)
			}
		}
		close(s.ch)
	})
}

// Subscribe registers a subscriber for events of type T with a buffer of n events
// (DefaultBuffer if n <= 0).
func Subscribe[T any](b *Bus, n int) *Subscription[T] {
	if n <= 0 {
		n = DefaultBuffer
	}
	key := reflect.TypeFor[T]()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	s := &Subscription[T]{bus: b, key: key, id: b.nextID, ch: make(chan T, n)}
	subs := b.topics[key]
	if subs == nil {
		subs = make(map[uint64]any)
		b.topics[key] = subs
	}
	subs[s.id] = s
	return s
}

// Publish delivers ev to every current subscriber of T without blocking. It returns the
// number of subscribers that received the event.
func Publish[T any](b *Bus, ev T) int {
	key := reflect.TypeFor[T]()
	// The read lock is held across the sends so Close cannot close a channel mid-send.
	// Sends are non-blocking, so the lock is held only briefly.
	b.mu.RLock()
	defer b.mu.RUnlock()
	delivered := 0
	for _, v := range b.topics[key] {
		s := v.(*Subscription[T])
		select {
		case s.ch <- ev:
			delivered++
		default:
			s.drops.Add(1)
			b.drops.Add(1)
		}
	}
	return delivered
}
