package thread

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakePluginWakes stands in for the plugin store (SetPluginWakes): it knows hello/tick
// (arg every, optional) and hello/gone, refuses anything else, and records Changed.
type fakePluginWakes struct {
	mu    sync.Mutex
	notes []string // "+sub-…" or "-sub-…"
}

func (f *fakePluginWakes) Resolve(_ context.Context, t Thread, target string, args map[string]string) (map[string]string, error) {
	switch target {
	case "hello/tick", "hello/gone":
	case "hello/thread":
		out := maps.Clone(args)
		if out == nil {
			out = map[string]string{}
		}
		if out["thread"] == "" {
			out["thread"] = t.ID
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%w: no wake source %s", ErrNotFound, target)
	}
	if v, ok := args["every"]; ok && v == "" {
		return nil, fmt.Errorf("%w: every: empty value", ErrInvalidArgument)
	}
	return maps.Clone(args), nil
}

func (f *fakePluginWakes) Changed(sub Subscription, added bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sign := "-"
	if added {
		sign = "+"
	}
	f.notes = append(f.notes, sign+sub.ID)
}

func (f *fakePluginWakes) Describe(target string) (string, string) {
	return "Hello: " + strings.TrimPrefix(target, "hello/"), "running"
}

func (f *fakePluginWakes) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.notes)
}

// waitNotes waits for the Changed calls (they come from a goroutine).
func (f *fakePluginWakes) waitNotes(t *testing.T, want ...string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !slices.Equal(f.seen(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("Changed calls %q, want %q", f.seen(), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSubscribePluginTarget(t *testing.T) {
	tests := []struct {
		o        SubscribeOptions
		target   string
		wantFail bool
	}{
		{o: SubscribeOptions{TargetPlugin: "hello/tick"}, target: "hello/tick"},
		{o: SubscribeOptions{TargetPlugin: " hello/tick ", Condition: CondSettled}, target: "hello/tick"},
		{o: SubscribeOptions{TargetPlugin: "hello/tick", Condition: CondFired, Args: map[string]string{"every": "2s"}}, target: "hello/tick"},
		{o: SubscribeOptions{TargetPlugin: "hello/tick", Condition: CondIdle}, wantFail: true},
		{o: SubscribeOptions{TargetPlugin: "hello"}, wantFail: true},
		{o: SubscribeOptions{TargetPlugin: "hello/"}, wantFail: true},
		{o: SubscribeOptions{TargetPlugin: "hello/a/b"}, wantFail: true},
		{o: SubscribeOptions{TargetPlugin: "hello/tick", TargetThreadID: "s-1"}, wantFail: true},
		{o: SubscribeOptions{TargetThreadID: "s-1", Args: map[string]string{"every": "2s"}}, wantFail: true},
	}
	for _, tt := range tests {
		kind, target, cond, err := subscribeTarget(tt.o)
		if tt.wantFail {
			if !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("subscribeTarget(%+v) = %v, want invalid argument", tt.o, err)
			}
			continue
		}
		if err != nil || kind != TargetPlugin || target != tt.target || cond != CondFired {
			t.Errorf("subscribeTarget(%+v) = %s %s %s %v", tt.o, kind, target, cond, err)
		}
	}
}

func TestPluginWakeMessage(t *testing.T) {
	at := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	sub := Subscription{ID: "sub-1", TargetKind: TargetPlugin, TargetID: "hello/tick", Args: map[string]string{"every": "2s"}}
	m := pluginWake(sub, "Hello", "tick 3\n(every 2s)", json.RawMessage(`{"n":3}`), at)
	if m.WakeTitle != "Hello: tick — tick 3 (every 2s)" || m.Origin != OriginWake ||
		!strings.HasPrefix(m.Text, "[code-foundry wake] Hello: tick — tick 3 (every 2s)\n```json\n") {
		t.Errorf("message = %+v", m)
	}
	var p map[string]any
	if err := json.Unmarshal([]byte(m.WakeJSON), &p); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"kind": "plugin", "subscription_id": "sub-1", "plugin": "hello", "source": "tick",
		"args": map[string]any{"every": "2s"}, "title": "tick 3\n(every 2s)", "payload": map[string]any{"n": float64(3)},
		"fired_at": "2026-10-18T12:00:00.000Z"}
	for k, v := range want {
		if fmt.Sprint(p[k]) != fmt.Sprint(v) {
			t.Errorf("%s = %v, want %v", k, p[k], v)
		}
	}
	// Source gone: no payload, no args; the plugin's name stands in for a display name.
	m = pluginWake(Subscription{ID: "sub-2", TargetID: "hello/tick"}, "", "source gone (disabled)", nil, at)
	if m.WakeTitle != "hello: tick — source gone (disabled)" || !strings.Contains(m.WakeJSON, `"payload": null`) ||
		!strings.Contains(m.WakeJSON, `"args": {}`) {
		t.Errorf("gone = %q\n%s", m.WakeTitle, m.WakeJSON)
	}
}

// Fires reach the subscriptions their match covers; a one-shot goes after its first;
// the plugin is told of every subscription that comes and goes, in order.
func TestPluginWakes(t *testing.T) {
	e := newEnv(t)
	pw := &fakePluginWakes{}
	parent, other := e.stopped("parent"), e.stopped("other")
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPlugin: "hello/tick"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("without the plugin store: %v", err)
	}
	e.m.SetPluginWakes(pw)
	sub := func(id string, args map[string]string, repeat bool) Subscription {
		t.Helper()
		res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: id, TargetPlugin: "hello/tick", Args: args, Repeat: repeat})
		if err != nil || res.Fired || res.Existed || res.Subscription.Condition != CondFired || res.Subscription.Repeat != repeat {
			t.Fatalf("Subscribe = %+v, %v", res, err)
		}
		return res.Subscription
	}
	once := sub(parent.ID, map[string]string{"every": "2s"}, false)
	broad := sub(parent.ID, nil, true)
	five := sub(other.ID, map[string]string{"every": "5s"}, true)
	pw.waitNotes(t, "+"+once.ID, "+"+broad.ID, "+"+five.ID)

	// The same subscription again: returned, with repeat updated.
	again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: other.ID, TargetPlugin: "hello/tick", Args: map[string]string{"every": "5s"}})
	if err != nil || !again.Existed || again.Subscription.ID != five.ID || again.Subscription.Repeat {
		t.Fatalf("again = %+v, %v", again, err)
	}
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: other.ID, TargetPlugin: "hello/tick", Args: map[string]string{"every": "5s"}, Repeat: true}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		target string
		args   map[string]string
		want   error
	}{
		{"hello/nope", nil, ErrNotFound},
		{"hello/tick", map[string]string{"every": ""}, ErrInvalidArgument},
	} {
		if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPlugin: tt.target, Args: tt.args}); !errors.Is(err, tt.want) {
			t.Errorf("Subscribe %s %v = %v, want %v", tt.target, tt.args, err, tt.want)
		}
	}

	fire := func(every string) int {
		match := map[string]string{}
		if every != "" {
			match["every"] = every
		}
		return e.m.FirePlugin("hello", "Hello", "tick", match, "tick every "+every, json.RawMessage(`{"every":"`+every+`"}`))
	}
	if n := fire("2s"); n != 2 {
		t.Errorf("fire 2s woke %d, want 2 (the 2s one-shot and the broad one)", n)
	}
	pw.waitNotes(t, "+"+once.ID, "+"+broad.ID, "+"+five.ID, "-"+once.ID)
	if _, kept := e.subscription(once.ID); kept {
		t.Error("the one-shot stayed after it fired")
	}
	if n := fire("5s"); n != 2 {
		t.Errorf("fire 5s woke %d, want 2", n)
	}
	if n := fire("2s"); n != 1 {
		t.Errorf("fire 2s again woke %d, want 1", n)
	}
	if n := e.m.FirePlugin("hello", "Hello", "other", nil, "x", nil); n != 0 {
		t.Errorf("another source woke %d", n)
	}
	items := e.waitItems(parent.ID, "four wakes", func(items []Item) bool { return len(wakes(items)) == 4 })
	// The first fire woke the one-shot and the broad subscription at once, in either
	// order: the one-shot's wake is one of the first two.
	if first := wakes(items)[:2]; !slices.ContainsFunc(first, func(w Item) bool {
		return w.WakeTitle == "Hello: tick — tick every 2s" && strings.Contains(w.WakeJSON, `"subscription_id": "`+once.ID+`"`)
	}) {
		t.Errorf("first wakes = %q\n%s\n%s", first[0].WakeTitle, first[0].WakeJSON, first[1].WakeJSON)
	}
	e.waitItems(other.ID, "one wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if got, _ := e.subscription(broad.ID); got.FiredCount != 3 || got.TargetName != "Hello: tick" || got.TargetStatus != "running" {
		t.Errorf("listed = %+v", got)
	}

	// Listed for the plugin's re-arm, args and all; kept across a restart.
	byID := func(subs []Subscription) map[string]Subscription {
		out := map[string]Subscription{}
		for _, s := range subs {
			out[s.ID] = s
		}
		return out
	}
	if subs := byID(e.m.PluginSubscriptions("hello")); len(subs) != 2 || subs[broad.ID].FiredCount != 3 || subs[five.ID].Args["every"] != "5s" {
		t.Errorf("PluginSubscriptions = %+v", subs)
	}
	if subs := e.m.PluginSubscriptions("hell"); len(subs) != 0 {
		t.Errorf("PluginSubscriptions of another plugin = %+v", subs)
	}
	e.restart()
	e.m.SetPluginWakes(pw)
	if subs := byID(e.m.PluginSubscriptions("")); len(subs) != 2 || subs[five.ID].Args["every"] != "5s" || subs[broad.ID].FiredCount != 3 {
		t.Errorf("after restart = %+v", subs)
	}

	// Unsubscribe by target: every args.
	gone, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: other.ID, TargetPlugin: "hello/tick"})
	if err != nil || len(gone) != 1 || gone[0].ID != five.ID {
		t.Fatalf("Unsubscribe = %+v, %v", gone, err)
	}
	pw.waitNotes(t, "+"+once.ID, "+"+broad.ID, "+"+five.ID, "-"+once.ID, "-"+five.ID)
	// Archiving the subscriber ends the rest.
	if _, err := e.m.Archive(e.ctx(), parent.ID, true); err != nil {
		t.Fatal(err)
	}
	pw.waitNotes(t, "+"+once.ID, "+"+broad.ID, "+"+five.ID, "-"+once.ID, "-"+five.ID, "-"+broad.ID)
	if subs := e.m.PluginSubscriptions(""); len(subs) != 0 {
		t.Errorf("left %+v", subs)
	}
}

// A context arg filled by the plugin side is kept: two threads subscribing to the same
// source get their own subscriptions and only their own fires.
func TestPluginWakeContextArgs(t *testing.T) {
	e := newEnv(t)
	e.m.SetPluginWakes(&fakePluginWakes{})
	a, b := e.stopped("a"), e.stopped("b")
	for _, id := range []string{a.ID, b.ID} {
		res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: id, TargetPlugin: "hello/thread", Repeat: true})
		if err != nil || res.Subscription.Args["thread"] != id {
			t.Fatalf("Subscribe = %+v, %v", res, err)
		}
	}
	if n := e.m.FirePlugin("hello", "Hello", "thread", map[string]string{"thread": b.ID}, "for b", nil); n != 1 {
		t.Fatalf("woke %d, want 1", n)
	}
	e.waitItems(b.ID, "b's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if n := len(wakes(e.items(a.ID).Items)); n != 0 {
		t.Errorf("a got %d wakes", n)
	}
}

// A source that goes sends each subscriber one last wake and removes its subscriptions;
// the other sources' stay.
func TestPluginWakesGone(t *testing.T) {
	e := newEnv(t)
	e.m.SetPluginWakes(&fakePluginWakes{})
	parent := e.stopped("parent")
	for _, target := range []string{"hello/tick", "hello/gone"} {
		if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPlugin: target, Repeat: true}); err != nil {
			t.Fatal(err)
		}
	}
	if n := e.m.PluginWakesGone("hello", "Hello", []string{"gone"}, "no longer in its manifest"); n != 1 {
		t.Fatalf("gone %d, want 1", n)
	}
	items := e.waitItems(parent.ID, "the last wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if w := wakes(items)[0]; w.WakeTitle != "Hello: gone — source gone (no longer in its manifest)" || !strings.Contains(w.WakeJSON, `"payload": null`) {
		t.Errorf("wake = %q\n%s", w.WakeTitle, w.WakeJSON)
	}
	if subs := e.m.PluginSubscriptions("hello"); len(subs) != 1 || subs[0].TargetID != "hello/tick" {
		t.Errorf("left %+v", subs)
	}
	if n := e.m.PluginWakesGone("hello", "Hello", nil, "disabled"); n != 1 {
		t.Fatalf("gone %d, want 1", n)
	}
	e.waitItems(parent.ID, "the second last wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	if n := e.m.PluginWakesGone("hello", "Hello", nil, "disabled"); n != 0 {
		t.Errorf("gone again %d", n)
	}
	e.restart()
	if subs := e.m.PluginSubscriptions(""); len(subs) != 0 {
		t.Errorf("after restart %+v", subs)
	}
}

// The wake limit applies to plugin fires: a dropped one does not count as delivered,
// and a one-shot it dropped stays for the next.
func TestPluginWakeLimit(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.WakeLimit = 1 })
	e.m.SetPluginWakes(&fakePluginWakes{})
	parent := e.stopped("parent")
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPlugin: "hello/tick", Repeat: true}); err != nil {
		t.Fatal(err)
	}
	once, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPlugin: "hello/gone"})
	if err != nil {
		t.Fatal(err)
	}
	if n := e.m.FirePlugin("hello", "Hello", "tick", nil, "one", nil); n != 1 {
		t.Fatalf("first fire woke %d", n)
	}
	if n := e.m.FirePlugin("hello", "Hello", "gone", nil, "two", nil); n != 0 {
		t.Fatalf("a fire over the limit woke %d", n)
	}
	if _, kept := e.subscription(once.Subscription.ID); !kept {
		t.Error("a one-shot the limit dropped went")
	}
}
