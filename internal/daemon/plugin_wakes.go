package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Plugin wake sources (docs/notes/plugins-wake-sources.md): the thread store keeps the
// subscriptions and delivers the wakes, the plugin store knows the sources and talks
// to the plugins. Neither imports the other: threadPluginWakes is the plugin store as
// the thread store needs it (thread.PluginWakes), pluginWakeSink the thread store as
// the plugin store needs it (plugin.WakeSink).

// wakeResolver is the part of the plugin store thread.PluginWakes needs. *plugin.Manager
// implements it.
type wakeResolver interface {
	ResolveWake(ctx context.Context, threadID, projectID, target string, args map[string]string) (map[string]string, error)
	WakeChanged(s plugin.WakeSub, added bool)
	DescribeWake(target string) (string, string)
	Snapshot() *plugin.Snapshot
}

// threadPluginWakes adapts the plugin store to thread.PluginWakes.
type threadPluginWakes struct{ plugins wakeResolver }

var _ thread.PluginWakes = threadPluginWakes{}

// wakeErrors map the plugin store's errors to the thread store's.
var wakeErrors = map[error]error{
	plugin.ErrNotFound:           thread.ErrNotFound,
	plugin.ErrInvalidArgument:    thread.ErrInvalidArgument,
	plugin.ErrFailedPrecondition: thread.ErrFailedPrecondition,
}

func (w threadPluginWakes) Resolve(ctx context.Context, t thread.Thread, target string, args map[string]string) (map[string]string, error) {
	out, err := w.plugins.ResolveWake(ctx, t.ID, t.ProjectID, target, args)
	for from, to := range wakeErrors {
		if errors.Is(err, from) {
			return nil, kindError{kind: to, err: err}
		}
	}
	return out, err
}

func (w threadPluginWakes) Changed(s thread.Subscription, added bool) {
	w.plugins.WakeChanged(wakeSub(s), added)
}

func (w threadPluginWakes) Describe(target string) (string, string) {
	return w.plugins.DescribeWake(target)
}

var _ thread.PluginSources = threadPluginWakes{}

// Sources lists the wake sources of running plugins with the args each takes for t (the
// Until event menu, docs/notes/snooze-until-event.md): a source whose args cannot be
// resolved for t (a required arg with no value) is left out.
func (w threadPluginWakes) Sources(ctx context.Context, t thread.Thread) []thread.PluginSource {
	var out []thread.PluginSource
	for _, p := range w.plugins.Snapshot().Plugins {
		if p.State != plugin.StateRunning {
			continue
		}
		for _, wk := range p.Manifest.Wakes {
			target := p.Name + "/" + wk.Name
			args, err := w.plugins.ResolveWake(ctx, t.ID, t.ProjectID, target, nil)
			if err != nil {
				continue
			}
			out = append(out, thread.PluginSource{Target: target, Title: wk.Title, PluginName: p.DisplayName(), Args: args})
		}
	}
	slices.SortStableFunc(out, func(a, b thread.PluginSource) int { return strings.Compare(a.Target, b.Target) })
	return out
}

// wakeSub is a thread store subscription as the plugin store knows it.
func wakeSub(s thread.Subscription) plugin.WakeSub {
	p, src, _ := strings.Cut(s.TargetID, "/")
	return plugin.WakeSub{ID: s.ID, Plugin: p, Source: src, ThreadID: s.SubscriberID, Args: maps.Clone(s.Args), Repeat: s.Repeat}
}

// pluginWakes is the part of the thread store plugin.WakeSink needs. *thread.Manager
// implements it.
type pluginWakes interface {
	FirePlugin(plugin, display, source string, match map[string]string, title string, payload json.RawMessage) int
	PluginWakesGone(plugin, display string, sources []string, reason string) int
	PluginSubscriptions(plugin string) []thread.Subscription
}

// pluginWakeSink adapts the thread store to plugin.WakeSink.
type pluginWakeSink struct{ threads pluginWakes }

var _ plugin.WakeSink = pluginWakeSink{}

func (s pluginWakeSink) Fire(p, display, source string, match map[string]string, title string, payload json.RawMessage) int {
	return s.threads.FirePlugin(p, display, source, match, title, payload)
}

func (s pluginWakeSink) Gone(p, display string, sources []string, reason string) int {
	return s.threads.PluginWakesGone(p, display, sources, reason)
}

func (s pluginWakeSink) Subscriptions(p string) []plugin.WakeSub {
	subs := s.threads.PluginSubscriptions(p)
	out := make([]plugin.WakeSub, len(subs))
	for i, sub := range subs {
		out[i] = wakeSub(sub)
	}
	return out
}
