package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The tick wake source (plugin.json's wakes): a thread subscribes with
// `code-foundry thread subscribe --plugin hello/tick [--arg every=2s]` and is woken every
// <every> (default 10s) until it unsubscribes, or once without --repeat. The plugin runs
// one loop per distinct every and fires the source with that every as the match, so a
// fire reaches exactly the subscriptions with that arg. The host sends every live
// subscription again after each start (wake/subscribed), which re-arms the loops.

// tickDefault is the every arg's default (plugin.json says the same).
const tickDefault = "10s"

// ticker keeps the subscriptions to tick and a loop per every.
type ticker struct {
	mu    sync.Mutex
	subs  map[string]string             // subscription → every
	loops map[string]context.CancelFunc // every → its loop
	n     map[string]int                // every → ticks fired
}

func newTicker() *ticker {
	return &ticker{subs: map[string]string{}, loops: map[string]context.CancelFunc{}, n: map[string]int{}}
}

// subscribed arms a subscription (again after a restart: the same id is the same one).
func (t *ticker) subscribed(h *pluginsdk.Host, s pluginsdk.WakeSubscription) {
	if s.Source != "tick" {
		return
	}
	every := s.Args["every"]
	if every == "" {
		every = tickDefault
	}
	d, err := time.ParseDuration(every)
	if err != nil || d <= 0 {
		h.Log().Warn("tick: bad every", "subscription", s.Subscription, "every", every)
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.subs[s.Subscription] = every
	if _, ok := t.loops[every]; ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.loops[every] = cancel
	go t.loop(ctx, h, every, d)
	h.Log().Info("tick armed", "every", every, "subscription", s.Subscription)
}

// unsubscribed disarms a subscription; the loop of its every stops with the last one.
func (t *ticker) unsubscribed(h *pluginsdk.Host, u pluginsdk.WakeUnsubscribed) {
	t.mu.Lock()
	defer t.mu.Unlock()
	every, ok := t.subs[u.Subscription]
	if !ok {
		return
	}
	delete(t.subs, u.Subscription)
	for _, e := range t.subs {
		if e == every {
			return
		}
	}
	if cancel, ok := t.loops[every]; ok {
		cancel()
		delete(t.loops, every)
		h.Log().Info("tick stopped", "every", every)
	}
}

func (t *ticker) loop(ctx context.Context, h *pluginsdk.Host, every string, d time.Duration) {
	tk := time.NewTicker(d)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			if _, err := t.fire(ctx, h, every); err != nil {
				h.Log().Warn("tick: fire", "every", every, "err", err.Error())
			}
		}
	}
}

// fire fires tick for the subscriptions with every and says how many were woken.
func (t *ticker) fire(ctx context.Context, h *pluginsdk.Host, every string) (int, error) {
	t.mu.Lock()
	t.n[every]++
	n := t.n[every]
	t.mu.Unlock()
	return h.FireWake(ctx, "tick", map[string]string{"every": every}, fmt.Sprintf("tick %d (every %s)", n, every),
		map[string]any{"n": n, "every": every, "at": time.Now().UTC().Format(time.RFC3339)})
}

// armed are the every values with a subscription, sorted.
func (t *ticker) armed() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for _, e := range t.subs {
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	slices.Sort(out)
	return out
}

// stop ends every loop (the plugin is stopping).
func (t *ticker) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for e, cancel := range t.loops {
		cancel()
		delete(t.loops, e)
	}
}

// fireTick is the fire-tick command: fire tick now, for one every or for each armed one.
// Its message ends with the subscribe line, as every message about an event should.
func (t *ticker) fireTick(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	targets := t.armed()
	if e := req.Arg("every"); e != "" {
		targets = []string{e}
	}
	if len(targets) == 0 {
		return pluginsdk.CommandResult{Message: "nobody subscribes to tick; subscribe a thread with: " + h.WakeHint("tick", map[string]string{"every": "2s"})}, nil
	}
	var lines []string
	for _, e := range targets {
		n, err := t.fire(ctx, h, e)
		if err != nil {
			return pluginsdk.CommandResult{}, fmt.Errorf("fire tick (every %s): %w", e, err)
		}
		lines = append(lines, fmt.Sprintf("fired tick for every=%s: woke %d", e, n))
	}
	lines = append(lines, "Wait for the next one: "+h.WakeHint("tick", map[string]string{"every": targets[0]}))
	return pluginsdk.CommandResult{Message: strings.Join(lines, "\n")}, nil
}
