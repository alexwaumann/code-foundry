package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// tick fires for each subscription's every, one loop per every; a one-shot goes after
// its first fire and its loop stops; fire-tick fires at once and ends with the
// subscribe line; a re-sent subscription (a restart's re-arm) is the same one.
func TestTick(t *testing.T) {
	data, err := os.ReadFile("plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	mf, _, err := pluginsdk.LoadManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello", Wakes: mf.Wakes,
		Granted: pluginsdk.Permissions{Commands: []string{"thread.send"}, Events: []string{"threads"}, SessionEnv: true}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := h.Command(ctx, "fire-tick", nil, pluginsdk.UiContext{})
	if err != nil || res.Message != "nobody subscribes to tick; subscribe a thread with: code-foundry thread subscribe --plugin hello/tick --arg every=2s" {
		t.Fatalf("fire-tick with no subscriber = %q, %v", res.Message, err)
	}

	fast, err := h.Subscribe("tick", map[string]string{"every": "40ms"}, pluginsdk.UiContext{ThreadID: "s-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.SubscribeWith(pluginsdk.WakeSubscription{Subscription: fast, Source: "tick", Args: map[string]string{"every": "40ms"}, Repeat: true}); err != nil {
		t.Fatal(err) // the re-arm after a restart: still one loop
	}
	if _, err := h.SubscribeWith(pluginsdk.WakeSubscription{Source: "tick", Args: map[string]string{"every": "60ms"}}); err != nil {
		t.Fatal(err)
	}
	fires := func(every string) (n, delivered int) {
		d := h.Delivered()
		for i, f := range h.Fires() {
			if f.Match["every"] == every {
				n++
				delivered += d[i]
			}
		}
		return n, delivered
	}
	h.WaitFor(5*time.Second, func(*plugintest.Host) bool { n, _ := fires("40ms"); return n >= 3 })
	h.WaitFor(5*time.Second, func(*plugintest.Host) bool { _, d := fires("60ms"); return d == 1 })
	// The one-shot went: its loop stops.
	time.Sleep(200 * time.Millisecond)
	n60, d60 := fires("60ms")
	time.Sleep(200 * time.Millisecond)
	if n, d := fires("60ms"); n != n60 || d != 1 || d60 != 1 {
		t.Errorf("60ms after its one-shot went: %d fires (%d before), %d delivered", n, n60, d)
	}
	if f := h.Fires()[0]; !strings.HasPrefix(f.Title, "tick 1 (every ") || !strings.Contains(string(f.Payload), `"n":1`) {
		t.Errorf("first fire %+v", f)
	}
	n40, d40 := fires("40ms")
	if d40 != n40 {
		t.Errorf("40ms: %d fires, %d delivered (one subscription, one loop)", n40, d40)
	}

	res, err = h.Command(ctx, "fire-tick", map[string]string{"every": "40ms"}, pluginsdk.UiContext{})
	if err != nil || !strings.HasPrefix(res.Message, "fired tick for every=40ms: woke 1\n") ||
		!strings.HasSuffix(res.Message, "Wait for the next one: code-foundry thread subscribe --plugin hello/tick --arg every=40ms") {
		t.Errorf("fire-tick = %q, %v", res.Message, err)
	}
	if err := h.Unsubscribe(fast); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	n40, _ = fires("40ms")
	time.Sleep(200 * time.Millisecond)
	if n, _ := fires("40ms"); n != n40 {
		t.Errorf("40ms kept firing after the last subscription went: %d, then %d", n40, n)
	}
}
