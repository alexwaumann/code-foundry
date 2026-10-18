package api

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// PluginFeed is EventService as plugins subscribe to it (events/subscribe;
// internal/store/plugin/events.go): the same loop as Watch over the manifest's source
// names, every event as its protojson (the JSON the GUI's client reads). It implements
// plugin.EventFeed.
type PluginFeed struct {
	events *Events
	log    *slog.Logger
}

var _ plugin.EventFeed = PluginFeed{}

// NewPluginFeed returns the feed over h's sources.
func NewPluginFeed(h *Events, log *slog.Logger) PluginFeed {
	if log == nil {
		log = slog.Default()
	}
	return PluginFeed{events: h, log: log}
}

// pluginSources maps the manifest's event source names (pluginsdk.EventSources) to
// EventService's. Never ui or terminal.
var pluginSources = map[string]v1.EventSource{
	"project":   v1.EventSource_EVENT_SOURCE_PROJECT,
	"workspace": v1.EventSource_EVENT_SOURCE_WORKSPACE,
	"threads":   v1.EventSource_EVENT_SOURCE_THREAD_LIST,
	"thread":    v1.EventSource_EVENT_SOURCE_THREAD,
	"gh":        v1.EventSource_EVENT_SOURCE_GH,
	"gitops":    v1.EventSource_EVENT_SOURCE_GITOPS,
	"settings":  v1.EventSource_EVENT_SOURCE_SETTINGS,
	"update":    v1.EventSource_EVENT_SOURCE_UPDATE,
	"action":    v1.EventSource_EVENT_SOURCE_ACTION,
	"plugin":    v1.EventSource_EVENT_SOURCE_PLUGIN,
}

// sourceName is pluginSources reversed.
func sourceName(k v1.EventSource) string {
	for n, s := range pluginSources {
		if s == k {
			return n
		}
	}
	return ""
}

// selectPluginSources returns the daemon's sources for names, in Watch's order.
func (f PluginFeed) selectPluginSources(names []string) ([]eventSource, error) {
	var want []v1.EventSource
	for _, n := range names {
		k, ok := pluginSources[n]
		if !ok {
			return nil, fmt.Errorf("unknown event source %q (one of %s)", n, strings.Join(pluginsdk.EventSources, ", "))
		}
		want = append(want, k)
	}
	srcs := selectSources(f.events.sources(), want)
	if len(srcs) == 0 {
		return nil, fmt.Errorf("this daemon has none of the event sources %s", strings.Join(names, ", "))
	}
	return srcs, nil
}

// encode is an event's protojson, nil when it cannot be encoded (logged).
func (f PluginFeed) encode(kind v1.EventSource, ev *v1.Event, snapshot bool) (plugin.FeedEvent, bool) {
	b, err := protojson.Marshal(ev)
	if err != nil {
		f.log.Warn("plugin feed: encode event", "err", err)
		return plugin.FeedEvent{}, false
	}
	return plugin.FeedEvent{Source: sourceName(kind), Snapshot: snapshot, Event: b}, true
}

// Feed implements plugin.EventFeed.
func (f PluginFeed) Feed(ctx context.Context, sources []string, send func(plugin.FeedEvent)) error {
	srcs, err := f.selectPluginSources(sources)
	if err != nil {
		return err
	}
	go func() {
		err := f.events.stream(ctx, srcs, 0, streamOut{send: func(kind v1.EventSource, ev *v1.Event, snapshot bool) error {
			if ev == nil {
				return nil
			}
			if fe, ok := f.encode(kind, ev, snapshot); ok {
				send(fe)
			}
			return nil
		}})
		if err != nil {
			f.log.Warn("plugin feed ended", "err", err)
		}
	}()
	return nil
}

// Snapshot implements plugin.EventFeed.
func (f PluginFeed) Snapshot(ctx context.Context, source string) []plugin.FeedEvent {
	srcs, err := f.selectPluginSources([]string{source})
	if err != nil {
		return nil
	}
	var out []plugin.FeedEvent
	for _, s := range srcs {
		for _, ev := range s.snapshot(ctx) {
			ev.Epoch = f.events.deps.Epoch
			if fe, ok := f.encode(s.kind(), ev, true); ok {
				out = append(out, fe)
			}
		}
	}
	return out
}
