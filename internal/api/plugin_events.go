package api

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// pluginSource is EventService's plugin source. It reuses PluginService's mapping
// (api/plugin.go): one bus type, plugin.Event; its snapshot is a PluginEvent.snapshot.
type pluginSource struct {
	store plugin.Store
	bus   *bus.Bus
}

func (pluginSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_PLUGIN }

func pluginWrap(ev plugin.Event) *v1.Event {
	if m := pluginEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_Plugin{Plugin: m}}
	}
	return nil
}

func (s pluginSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, pluginWrap)}
}

func (s pluginSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{pluginWrap(s.store.Snapshot())}
}
