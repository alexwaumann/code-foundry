package plugintest_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// A plugin arms on wake/subscribed, disarms on wake/unsubscribed and fires through
// Host.FireWake; the fake records the fires, reaches the subscriptions the match covers,
// removes a one-shot one it reached, and refuses what the host would.
func TestWakes(t *testing.T) {
	var mu sync.Mutex
	armed := map[string]pluginsdk.WakeSubscription{}
	p := pluginsdk.Plugin{
		OnWakeSubscribed: func(_ context.Context, _ *pluginsdk.Host, s pluginsdk.WakeSubscription) {
			mu.Lock()
			armed[s.Subscription] = s
			mu.Unlock()
		},
		OnWakeUnsubscribed: func(_ context.Context, _ *pluginsdk.Host, u pluginsdk.WakeUnsubscribed) {
			mu.Lock()
			delete(armed, u.Subscription)
			mu.Unlock()
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"fire": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				match := map[string]string{}
				if pr := req.Arg("pr"); pr != "" {
					match["pr"] = pr
				}
				n, err := h.FireWake(ctx, req.Arg("source"), match, "checks done", map[string]any{"conclusion": "success"})
				if err != nil {
					return pluginsdk.CommandResult{}, err
				}
				return pluginsdk.CommandResult{Message: strings.Repeat("x", n)}, nil
			},
		},
	}
	h := plugintest.Start(t, p, plugintest.Options{Name: "gh", Wakes: []pluginsdk.WakeSpec{
		{Name: "checks-done", Title: "Checks done", Args: []pluginsdk.WakeArgSpec{{Name: "pr", Context: pluginsdk.WakeContextPR}}},
	}})
	nArmed := func() int { mu.Lock(); defer mu.Unlock(); return len(armed) }
	broad, err := h.SubscribeWake("checks-done", nil, pluginsdk.UiContext{ThreadID: "s-1"})
	if err != nil {
		t.Fatal(err)
	}
	once, err := h.SubscribeWakeWith(pluginsdk.WakeSubscription{Source: "checks-done", Args: map[string]string{"pr": "a/b#1"}})
	if err != nil {
		t.Fatal(err)
	}
	h.WaitFor(time.Second, func(*plugintest.Host) bool { return nArmed() == 2 })

	ctx := context.Background()
	fire := func(source, pr string) (int, error) {
		res, err := h.Command(ctx, "fire", map[string]string{"source": source, "pr": pr}, pluginsdk.UiContext{})
		return len(res.Message), err
	}
	if n, err := fire("checks-done", "a/b#2"); err != nil || n != 1 {
		t.Fatalf("fire for #2: %d, %v (only the broad subscription)", n, err)
	}
	if n, err := fire("checks-done", "a/b#1"); err != nil || n != 2 {
		t.Fatalf("fire for #1: %d, %v (both)", n, err)
	}
	h.WaitFor(time.Second, func(*plugintest.Host) bool { return nArmed() == 1 })
	if subs := h.WakeSubscriptions(); len(subs) != 1 || subs[0].Subscription != broad {
		t.Fatalf("live subscriptions %+v; the one-shot %s should be gone", subs, once)
	}
	if n, err := fire("checks-done", "a/b#1"); err != nil || n != 1 {
		t.Fatalf("fire again: %d, %v", n, err)
	}
	if _, err := fire("nope", ""); pluginsdk.ErrorCode(err) != pluginsdk.CodeNotFound {
		t.Fatalf("an undeclared source: %v", err)
	}
	fires := h.WakeFires()
	if len(fires) != 4 || fires[0].Title != "checks done" || string(fires[0].Payload) != `{"conclusion":"success"}` {
		t.Fatalf("fires %+v", fires)
	}
	if d := h.WakeDelivered(); len(d) != 4 || d[0] != 1 || d[1] != 2 || d[2] != 1 || d[3] != 0 {
		t.Fatalf("delivered %v", d)
	}
	if err := h.UnsubscribeWake(broad); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(time.Second, func(*plugintest.Host) bool { return nArmed() == 0 })
}

// FireWake checks the payload's size before it leaves the plugin; the fake refuses a
// title the host would.
func TestFireWakeLimits(t *testing.T) {
	errs := make(chan error, 2)
	p := pluginsdk.Plugin{Init: func(ctx context.Context, h *pluginsdk.Host) error {
		_, err := h.FireWake(ctx, "tick", nil, "big", strings.Repeat("x", pluginsdk.MaxWakePayload))
		errs <- err
		_, err = h.FireWake(ctx, "tick", nil, "two\nlines", nil)
		errs <- err
		return nil
	}}
	plugintest.Start(t, p, plugintest.Options{})
	if err := <-errs; err == nil || !strings.Contains(err.Error(), "payload") {
		t.Errorf("a big payload: %v", err)
	}
	if err := <-errs; pluginsdk.ErrorCode(err) != pluginsdk.CodeInvalidParams {
		t.Errorf("a two-line title: %v", err)
	}
}
