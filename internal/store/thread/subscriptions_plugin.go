package thread

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
)

// Wake subscriptions to plugins' wake sources (docs/notes/plugins-wake-sources.md). A
// plugin declares sources in its manifest; a thread subscribes to "<plugin>/<source>"
// with args (TargetPlugin, CondFired), and the plugin fires the source with a match:
// every subscription whose args all equal the match's is woken (FirePlugin). The
// thread store does not know the plugin store: the daemon adapts it (SetPluginWakes)
// to resolve a new subscription's args (defaults, the subscriber's context) and to tell
// the plugin about subscriptions as they come and go (Changed, in order, from one
// goroutine, never under the store's locks), and the plugin store calls FirePlugin,
// PluginWakesGone and PluginSubscriptions. A plugin target never fires at subscribe
// time and survives a daemon restart (the plugin re-arms from PluginSubscriptions).

// TargetPlugin is a plugin's wake source ("<plugin>/<source>").
const TargetPlugin TargetKind = "plugin"

// CondFired is a plugin target's only condition: the plugin fired the source with a
// match covering the subscription's args.
const CondFired Condition = "fired"

// PluginWakes is the plugin store as plugin wake subscriptions need it. The daemon
// adapts it (SetPluginWakes).
type PluginWakes interface {
	// Resolve checks target "<plugin>/<source>" (a source an enabled plugin declares)
	// and args for subscriber t, and returns the args to keep: the given ones, defaults,
	// and context args taken from t (its id, pull request, project) when not given.
	// Errors wrap ErrNotFound, ErrInvalidArgument or ErrFailedPrecondition.
	Resolve(ctx context.Context, t Thread, target string, args map[string]string) (map[string]string, error)
	// Changed tells the plugin that a subscription was added (true) or removed. Calls
	// come in order, from one goroutine, never under the store's locks.
	Changed(sub Subscription, added bool)
	// Describe is a target's name ("Hello: tick") and its plugin's state in words
	// ("running", "disabled"), for listings.
	Describe(target string) (name, status string)
}

// SetPluginWakes sets the plugin store's side of plugin targets (nil refuses them).
// The daemon sets it once the plugin store exists.
func (m *Manager) SetPluginWakes(pw PluginWakes) {
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	s.plugins = pw
}

func (s *subscriptions) pluginWakes() PluginWakes {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.plugins
}

// pluginNote is one Changed call waiting to be made.
type pluginNote struct {
	sub   Subscription
	added bool
}

// notePluginLocked queues a Changed call for a plugin subscription (others are
// ignored) and starts the goroutine that makes them, in order. Callers hold s.mu.
func (s *subscriptions) notePluginLocked(sub Subscription, added bool) {
	if sub.TargetKind != TargetPlugin || s.plugins == nil {
		return
	}
	sub.Args = maps.Clone(sub.Args)
	s.notes = append(s.notes, pluginNote{sub: sub, added: added})
	if s.noting {
		return
	}
	s.noting = true
	go s.drainNotes()
}

// drainNotes makes the queued Changed calls until none is left.
func (s *subscriptions) drainNotes() {
	for {
		s.mu.Lock()
		if len(s.notes) == 0 || s.plugins == nil {
			s.notes, s.noting = nil, false
			s.mu.Unlock()
			return
		}
		n, pw := s.notes[0], s.plugins
		s.notes = s.notes[1:]
		s.mu.Unlock()
		pw.Changed(n.sub, n.added)
	}
}

// resolvePluginTarget checks a plugin target and its args for subscriber (Subscribe).
func (m *Manager) resolvePluginTarget(ctx context.Context, subscriber, target string, args map[string]string) (map[string]string, error) {
	pw := m.subs.pluginWakes()
	if pw == nil {
		return nil, fmt.Errorf("%w: plugin wake sources are not available", ErrFailedPrecondition)
	}
	t, ok := m.Snapshot().Thread(subscriber)
	if !ok {
		return nil, fmt.Errorf("%w: subscriber %s", ErrNotFound, subscriber)
	}
	return pw.Resolve(ctx, t, target, args)
}

// FirePlugin delivers a fire of plugin's source (display is the plugin's display
// name): every subscription to it whose args all have the same value in match is woken
// with title and payload (JSON, "" for null), in subscription order. A one-shot one
// that was woken goes. It returns how many subscribers were woken (one over its wake
// limit is not).
func (m *Manager) FirePlugin(plugin, display, source string, match map[string]string, title string, payload json.RawMessage) int {
	target := plugin + "/" + source
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	hit := s.pluginLocked(func(r *subRec) bool { return r.s.TargetID == target && argsCovered(r.s.Args, match) })
	n := 0
	for _, r := range hit {
		if m.fireLocked(r, func(sub Subscription, at time.Time) Message {
			return pluginWake(sub, display, title, payload, at)
		}) {
			n++
			s.firedLocked(r)
		}
	}
	if len(hit) > 0 {
		m.log.Info("plugin wake fired", "plugin", plugin, "source", source, "matched", len(hit), "delivered", n)
	}
	return n
}

// PluginWakesGone ends plugin's subscriptions to sources (every source when sources is
// nil): each subscriber gets one last wake, "<display>: <source> — source gone
// (<reason>)" with a null payload, and the subscription is deleted. It returns how
// many subscriptions went.
func (m *Manager) PluginWakesGone(plugin, display string, sources []string, reason string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	hit := s.pluginLocked(func(r *subRec) bool {
		p, src, _ := strings.Cut(r.s.TargetID, "/")
		return p == plugin && (sources == nil || slices.Contains(sources, src))
	})
	if len(hit) == 0 {
		return 0
	}
	title := "source gone (" + reason + ")"
	ids := make([]string, 0, len(hit))
	for _, r := range hit {
		m.fireLocked(r, func(sub Subscription, at time.Time) Message { return pluginWake(sub, display, title, nil, at) })
		ids = append(ids, r.s.ID)
	}
	s.removeLocked(ids)
	m.log.Info("plugin wake subscriptions ended: the source is gone", "plugin", plugin, "reason", reason, "subscriptions", ids)
	return len(ids)
}

// PluginSubscriptions returns the live subscriptions to plugin's sources (every
// plugin's for ""), oldest first: the plugin store re-arms a starting plugin with them.
func (m *Manager) PluginSubscriptions(plugin string) []Subscription {
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	hit := s.pluginLocked(func(r *subRec) bool {
		return plugin == "" || strings.HasPrefix(r.s.TargetID, plugin+"/")
	})
	out := make([]Subscription, len(hit))
	for i, r := range hit {
		out[i] = r.s
		out[i].Args = maps.Clone(r.s.Args)
	}
	return out
}

// pluginLocked returns the plugin subscriptions keep accepts, oldest first. Callers
// hold s.mu.
func (s *subscriptions) pluginLocked(keep func(*subRec) bool) []*subRec {
	var hit []*subRec
	for _, r := range s.byID {
		if r.s.TargetKind == TargetPlugin && keep(r) {
			hit = append(hit, r)
		}
	}
	slices.SortFunc(hit, func(a, b *subRec) int {
		return cmp.Or(a.s.CreatedAt.Compare(b.s.CreatedAt), strings.Compare(a.s.ID, b.s.ID))
	})
	return hit
}

// argsCovered reports whether each of a subscription's args has the same value in a
// fire's match (pluginsdk.MatchWake).
func argsCovered(args, match map[string]string) bool {
	for k, v := range args {
		if mv, ok := match[k]; !ok || mv != v {
			return false
		}
	}
	return true
}

// describePlugin fills a plugin subscription's TargetName and TargetStatus.
func (s *subscriptions) describePlugin(sub *Subscription) {
	sub.TargetName, sub.TargetStatus = sub.TargetID, "plugins unavailable"
	if pw := s.pluginWakes(); pw != nil {
		sub.TargetName, sub.TargetStatus = pw.Describe(sub.TargetID)
	}
}

type wakePluginPayload struct {
	Kind           string            `json:"kind"`
	SubscriptionID string            `json:"subscription_id"`
	Plugin         string            `json:"plugin"`
	Source         string            `json:"source"`
	Args           map[string]string `json:"args"`
	Title          string            `json:"title"`
	Payload        json.RawMessage   `json:"payload"`
	FiredAt        string            `json:"fired_at"`
}

// pluginWake is the wake message of a fire of sub's source: "<display>: <source> —
// <title>" and the payload (null when empty).
func pluginWake(sub Subscription, display, title string, payload json.RawMessage, at time.Time) Message {
	plugin, source, _ := strings.Cut(sub.TargetID, "/")
	p := wakePluginPayload{Kind: "plugin", SubscriptionID: sub.ID, Plugin: plugin, Source: source, Args: sub.Args,
		Title: title, Payload: payload, FiredAt: wakeTime(at)}
	if p.Args == nil {
		p.Args = map[string]string{}
	}
	if len(p.Payload) == 0 || !json.Valid(p.Payload) {
		p.Payload = json.RawMessage("null")
	}
	return wakeMessage(cmp.Or(display, plugin)+": "+source+" — "+oneLine(title, maxHeaderSummary), p)
}

// encodeArgs and decodeArgs are a subscription's args as stored (a JSON object).
func encodeArgs(args map[string]string) string {
	if len(args) == 0 {
		return "{}"
	}
	b, err := json.Marshal(args)
	if err != nil {
		return "{}" // a map of strings: never happens
	}
	return string(b)
}

func decodeArgs(s string) map[string]string {
	var args map[string]string
	if json.Unmarshal([]byte(s), &args) != nil || len(args) == 0 {
		return nil
	}
	return args
}
