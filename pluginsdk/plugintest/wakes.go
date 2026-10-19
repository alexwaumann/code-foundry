package plugintest

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Wake sources (pluginsdk/wake.go): the test subscribes like an agent's thread would
// (SubscribeWake, SubscribeWakeWith: wake/subscribed), and the fake records the plugin's
// wake/fire calls (WakeFires) and answers how many of its subscriptions the match reaches,
// removing a one-shot one that it reached (wake/unsubscribed), as the host does. With
// Options.Wakes it also refuses a source or match arg the manifest does not declare.
// Options.WakeSubscriptions are replayed at start (Rearm set, then wake/armed), as the
// host replays the live subscriptions after a restart.

// wakeState is the fake's wake subscriptions and fires. Guarded by Host.mu.
type wakeState struct {
	next  int
	subs  []pluginsdk.WakeSubscription
	fires []pluginsdk.WakeFire
	sent  []int // delivered, per fire
}

// SubscribeWake subscribes a thread with uctx to source with args, repeating (it stays after
// fires), and sends wake/subscribed. It returns the subscription id ("wsub-<n>").
func (h *Host) SubscribeWake(source string, args map[string]string, uctx pluginsdk.UiContext) (string, error) {
	return h.SubscribeWakeWith(pluginsdk.WakeSubscription{Source: source, Args: args, Context: uctx, Repeat: true})
}

// SubscribeWakeWith sends wake/subscribed for sub (Repeat false: a one-shot, removed by the
// first fire that reaches it). An empty sub.Subscription gets "wsub-<n>"; an existing id
// is sent again, as the host does after a restart.
func (h *Host) SubscribeWakeWith(sub pluginsdk.WakeSubscription) (string, error) {
	h.record(func() {
		if sub.Subscription == "" {
			h.wakes.next++
			sub.Subscription = "wsub-" + strconv.Itoa(h.wakes.next)
		}
		sub.Args = maps.Clone(sub.Args)
		h.wakes.subs = slices.DeleteFunc(h.wakes.subs, func(s pluginsdk.WakeSubscription) bool { return s.Subscription == sub.Subscription })
		h.wakes.subs = append(h.wakes.subs, sub)
	})
	return sub.Subscription, h.conn.Notify(pluginsdk.MethodWakeSubscribed, sub)
}

// rearmWakes replays subs as the host does after initialized: each with Rearm, then
// wake/armed.
func (h *Host) rearmWakes(subs []pluginsdk.WakeSubscription) error {
	for _, sub := range subs {
		sub.Rearm = true
		if _, err := h.SubscribeWakeWith(sub); err != nil {
			return err
		}
	}
	return h.conn.Notify(pluginsdk.MethodWakeArmed, pluginsdk.WakeArmed{Count: len(subs)})
}

// UnsubscribeWake removes a subscription and sends wake/unsubscribed.
func (h *Host) UnsubscribeWake(id string) error {
	var source string
	h.record(func() {
		h.wakes.subs = slices.DeleteFunc(h.wakes.subs, func(s pluginsdk.WakeSubscription) bool {
			if s.Subscription == id {
				source = s.Source
				return true
			}
			return false
		})
	})
	return h.conn.Notify(pluginsdk.MethodWakeUnsubscribed, pluginsdk.WakeUnsubscribed{Subscription: id, Source: source})
}

// WakeSubscriptions returns the live subscriptions.
func (h *Host) WakeSubscriptions() []pluginsdk.WakeSubscription {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.wakes.subs)
}

// WakeFires returns the plugin's wake/fire calls (refused ones too).
func (h *Host) WakeFires() []pluginsdk.WakeFire {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.wakes.fires)
}

// WakeDelivered returns how many subscriptions each recorded fire reached (0 for a refused
// one), in the order of WakeFires.
func (h *Host) WakeDelivered() []int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.wakes.sent)
}

func (h *Host) handleWakes(_ context.Context, method string, params json.RawMessage) (any, bool, error) {
	if method != pluginsdk.MethodWakeFire {
		return nil, false, nil
	}
	f, err := decode[pluginsdk.WakeFire](params)
	if err != nil {
		return nil, true, err
	}
	if err := h.checkFire(f); err != nil {
		h.record(func() {
			h.wakes.fires = append(h.wakes.fires, f)
			h.wakes.sent = append(h.wakes.sent, 0)
		})
		return nil, true, err
	}
	var n int
	var gone []pluginsdk.WakeSubscription
	h.record(func() {
		h.wakes.subs = slices.DeleteFunc(h.wakes.subs, func(s pluginsdk.WakeSubscription) bool {
			if s.Source != f.Source || !pluginsdk.MatchWake(s.Args, f.Match) {
				return false
			}
			n++
			if !s.Repeat {
				gone = append(gone, s)
			}
			return !s.Repeat
		})
		h.wakes.fires = append(h.wakes.fires, f)
		h.wakes.sent = append(h.wakes.sent, n)
	})
	for _, s := range gone {
		_ = h.conn.Notify(pluginsdk.MethodWakeUnsubscribed, pluginsdk.WakeUnsubscribed{Subscription: s.Subscription, Source: s.Source})
	}
	return pluginsdk.WakeFireResult{Delivered: n}, true, nil
}

// checkFire refuses a fire the host would.
func (h *Host) checkFire(f pluginsdk.WakeFire) error {
	invalid := func(format string, a ...any) error {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "wake/fire: "+format, a...)
	}
	switch {
	case strings.TrimSpace(f.Title) == "" || strings.ContainsAny(f.Title, "\r\n"):
		return invalid("title is one line, required")
	case utf8.RuneCountInString(f.Title) > pluginsdk.MaxWakeTitle:
		return invalid("title longer than %d characters", pluginsdk.MaxWakeTitle)
	case len(f.Payload) > pluginsdk.MaxWakePayload:
		return invalid("payload of %d bytes (at most %d)", len(f.Payload), pluginsdk.MaxWakePayload)
	case len(f.Payload) > 0 && !json.Valid(f.Payload):
		return invalid("payload is not JSON")
	}
	if h.opts.Wakes == nil {
		return nil
	}
	i := slices.IndexFunc(h.opts.Wakes, func(w pluginsdk.WakeSpec) bool { return w.Name == f.Source })
	if i < 0 {
		return pluginsdk.NewError(pluginsdk.CodeNotFound, "wake/fire: plugin.json declares no wake source %q", f.Source)
	}
	for k := range f.Match {
		if _, ok := h.opts.Wakes[i].Arg(k); !ok {
			return invalid("wake source %s has no arg %q", f.Source, k)
		}
	}
	return nil
}
