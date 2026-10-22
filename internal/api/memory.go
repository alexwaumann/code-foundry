package api

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
)

// MemoryStore is the app memory (*memory.Store) as MemoryService and the EventService
// memory source read it. Writes are the memory.* commands', not this service's.
type MemoryStore interface {
	// Load reads the memory now (publishing a change it finds) and returns its snapshot.
	Load() *memory.Snapshot
	// Snapshot is the memory as last read.
	Snapshot() *memory.Snapshot
	// Dir is the memory directory.
	Dir() string
}

var _ MemoryStore = (*memory.Store)(nil)

// Memory implements codefoundryv1connect.MemoryServiceHandler over the memory store
// (docs/notes/memory-dir.md).
type Memory struct {
	store MemoryStore
	bus   *bus.Bus
}

var _ codefoundryv1connect.MemoryServiceHandler = (*Memory)(nil)

// NewMemory returns a MemoryService handler. b must be the bus the store publishes
// memory.Event on.
func NewMemory(store MemoryStore, b *bus.Bus) *Memory { return &Memory{store: store, bus: b} }

// Route mounts the service.
func (h *Memory) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewMemoryServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Get reads the memory now.
func (h *Memory) Get(context.Context, *connect.Request[v1.GetMemoryRequest]) (*connect.Response[v1.GetMemoryResponse], error) {
	return connect.NewResponse(&v1.GetMemoryResponse{Memory: memorySnapshotToProto(h.store.Load(), h.store.Dir())}), nil
}

// Watch sends the memory as read now, then the whole memory per change.
func (h *Memory) Watch(ctx context.Context, _ *connect.Request[v1.WatchMemoryRequest], stream *connect.ServerStream[v1.MemoryEvent]) error {
	sub := bus.Subscribe[memory.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(memoryEventToProto(h.store.Load(), h.store.Dir())); err != nil {
		return err
	}
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				ev = h.store.Snapshot()
			}
			if msg := memoryEventToProto(ev, h.store.Dir()); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// memorySource is EventService's memory source: the whole memory, on connect and per
// change.
type memorySource struct {
	store MemoryStore
	bus   *bus.Bus
}

func (memorySource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_MEMORY }

func (s memorySource) topics() []topic {
	dir := s.store.Dir()
	return []topic{busTopic(s.bus, watchBuffer, func(ev memory.Event) *v1.Event {
		if m := memoryEventToProto(ev, dir); m != nil {
			return &v1.Event{Event: &v1.Event_Memory{Memory: m}}
		}
		return nil
	})}
}

// snapshot reads the memory now: a hand edit since the last read is in it (and, being a
// change, also goes out as a live event, which carries the same state).
func (s memorySource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{{Event: &v1.Event_Memory{Memory: memoryEventToProto(s.store.Load(), s.store.Dir())}}}
}

// memoryEventToProto converts a bus event to the wire event (nil for one it does not
// know).
func memoryEventToProto(ev memory.Event, dir string) *v1.MemoryEvent {
	snap, ok := ev.(*memory.Snapshot)
	if !ok || snap == nil {
		return nil
	}
	return &v1.MemoryEvent{Snapshot: memorySnapshotToProto(snap, dir)}
}

func memorySnapshotToProto(snap *memory.Snapshot, dir string) *v1.MemorySnapshot {
	out := &v1.MemorySnapshot{
		Injected: int32(snap.Injected), InjectedBytes: int32(snap.InjectedBytes),
		MaxEntries: memory.MaxEntries, MaxBytes: memory.MaxBytes, MaxEntryChars: memory.MaxEntryChars,
		Dir: dir, Error: snap.Err, Version: snap.Version,
	}
	for _, e := range snap.Entries {
		m := &v1.MemoryEntry{
			Index: int32(e.Index), Id: e.ID(), Text: e.Text, File: e.File,
			ThreadId: e.ThreadID, ThreadName: e.ThreadName, Injected: e.Injected, LeftOut: e.LeftOut,
		}
		if !e.Created.IsZero() {
			m.Created = timestamppb.New(e.Created)
		}
		out.Entries = append(out.Entries, m)
	}
	return out
}
