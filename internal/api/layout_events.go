package api

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
)

// layoutSource is EventService's layout source: the whole layout as one LayoutEvent, then
// one delta per commit (layout.Event). A delta at or below the rev of the snapshot a client
// holds was queued before that snapshot and is skipped by the client (layout.proto).
type layoutSource struct {
	store layout.Store
	bus   *bus.Bus
}

func (layoutSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_LAYOUT }

func layoutWrap(ev layout.Event) *v1.Event {
	return &v1.Event{Event: &v1.Event_Layout{Layout: &v1.LayoutEvent{
		Rev:      ev.Rev,
		Change:   &v1.LayoutEvent_Delta{Delta: layoutDeltaToProto(ev.Delta)},
		ClientId: ev.ClientID,
	}}}
}

func (s layoutSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, layoutWrap)}
}

func (s layoutSource) snapshot(context.Context) []*v1.Event {
	snap := s.store.Snapshot()
	return []*v1.Event{{Event: &v1.Event_Layout{Layout: &v1.LayoutEvent{
		Rev:    snap.Rev,
		Change: &v1.LayoutEvent_Snapshot{Snapshot: layoutToProto(snap)},
	}}}}
}
