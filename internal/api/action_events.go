package api

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
)

// actionSource is EventService's action source. It reuses ActionService's mapping
// (api/action.go): one bus type, action.Event; its snapshot is an ActionEvent.snapshot.
type actionSource struct {
	store action.Store
	bus   *bus.Bus
}

func (actionSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_ACTION }

func actionWrap(ev action.Event) *v1.Event {
	if m := actionEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_Action{Action: m}}
	}
	return nil
}

func (s actionSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, actionWrap)}
}

func (s actionSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{actionWrap(s.store.Snapshot())}
}
