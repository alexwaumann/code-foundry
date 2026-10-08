package api

import (
	"context"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/settings"
)

// settingsWatchBuffer is small: every event is a full snapshot, so after a drop the
// resync sends the latest one.
const settingsWatchBuffer = 16

// settingsSource carries settings snapshots (the store publishes settings.Changed).
// Its snapshot is the current SettingsSnapshot, so the GUI has settings as soon as the
// stream opens and needs no extra request.
type settingsSource struct {
	store settings.Service
	bus   *bus.Bus
}

func (settingsSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_SETTINGS }

func settingsWrap(s *settings.Snapshot) *v1.Event {
	return &v1.Event{Event: &v1.Event_Settings{Settings: settingsEvent(s)}}
}

func (s settingsSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx, newTap(s.bus, settingsWatchBuffer, func(ev settings.Changed) *v1.Event {
		return settingsWrap(ev.Snapshot)
	}))
}

func (s settingsSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{settingsWrap(s.store.Snapshot())}
}
