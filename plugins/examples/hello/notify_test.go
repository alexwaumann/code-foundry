package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// startNotifying runs hello granted its manifest's permissions, against its manifest's
// commands and wakes; host/invoke answers and records the show calls.
func startNotifying(t *testing.T) (*plugintest.Host, func() []pluginsdk.InvokeParams) {
	t.Helper()
	data, err := os.ReadFile("plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	mf, _, err := pluginsdk.LoadManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var shows []pluginsdk.InvokeParams
	g := mf.Permissions
	g.Threads, g.Terminals = false, false // the demo's own thread and terminal are not under test
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello", Granted: g, Commands: mf.Commands, Wakes: mf.Wakes,
		Invoke: func(_ context.Context, p pluginsdk.InvokeParams) (pluginsdk.CommandResult, error) {
			mu.Lock()
			defer mu.Unlock()
			if p.Command == "plugin.hello.show.demo" {
				shows = append(shows, p)
			}
			return pluginsdk.CommandResult{Message: "opened"}, nil
		}})
	return h, func() []pluginsdk.InvokeParams {
		mu.Lock()
		defer mu.Unlock()
		return append([]pluginsdk.InvokeParams(nil), shows...)
	}
}

// notify posts the build notification on a thread (once: the same content again is
// unchanged); pressing Open run runs hello's open-run, which picks Build #5 for the
// thread's demo and asks the host to show the demo there, taking the user's focus; the
// demo opens on the Runs tab with Build #5 chosen. --withdraw takes it back.
func TestNotifyOpensTheRun(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h, shows := startNotifying(t)
	for _, want := range []string{"notification build-5 posted (shown)", "notification build-5 unchanged (shown)"} {
		res, err := h.Command(ctx, "notify", nil, pluginsdk.UiContext{ThreadID: "s-1"})
		if err != nil || res.Message != want {
			t.Fatalf("notify = %q, %v; want %q", res.Message, err, want)
		}
	}
	n, status, _ := h.Notification(buildKey)
	if status != plugintest.StatusShown || n.ThreadID != "s-1" || n.Level != pluginsdk.NotifyError || len(n.Actions) != 2 ||
		n.Actions[0].Command != "open-run" || n.Actions[0].Args["run"] != "runs-run-5" || n.Actions[0].Args["thread"] != "s-1" {
		t.Fatalf("posted %+v (%s)", n, status)
	}

	res, err := h.PressAction(ctx, buildKey, 0)
	if err != nil || res.Message != "Build #5 on s-1: the demo opens on it (opened)" {
		t.Fatalf("Open run = %q, %v", res.Message, err)
	}
	if s := shows(); len(s) != 1 || s[0].Context.ThreadID != "s-1" || s[0].Args["focus"] != "true" {
		t.Fatalf("show calls %+v", s)
	}
	if _, status, _ := h.Notification(buildKey); status != plugintest.StatusResolved {
		t.Errorf("after Open run: %s", status)
	}
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	if v := view(t, h); v.Tabs.Active != "run-list" || !strings.Contains(string(mustView(t, h)), `"runs-facts"`) {
		t.Fatalf("the demo opened on %s without the run's detail", v.Tabs.Active)
	}

	// The open demo switches when another button asks.
	h2 := h.Version(inst)
	if _, err := h.Command(ctx, "open-run", map[string]string{"run": "runs-run-3", "thread": "s-1"}, pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) > h2 })
	if !strings.Contains(string(mustView(t, h)), "cf/retry") {
		t.Error("the open demo did not switch to Build #3")
	}

	// Posting again after the user resolved it: the content is unchanged, so it stays
	// closed; --withdraw finds nothing active.
	if res, _ := h.Command(ctx, "notify", nil, pluginsdk.UiContext{ThreadID: "s-1"}); res.Message != "notification build-5 unchanged (resolved)" {
		t.Errorf("re-post = %q", res.Message)
	}
	if res, _ := h.Command(ctx, "notify", map[string]string{"withdraw": "true"}, pluginsdk.UiContext{}); res.Message != "no notification to withdraw" {
		t.Errorf("withdraw = %q", res.Message)
	}
	if _, err := h.Command(ctx, "notify", map[string]string{"time-sensitive": "true"}, pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	if res, _ := h.Command(ctx, "notify", map[string]string{"withdraw": "true"}, pluginsdk.UiContext{}); res.Message != "withdrew build-5" {
		t.Errorf("withdraw = %q", res.Message)
	}
	if w := h.NotificationWithdrawals(); len(w) != 2 || w[1] != buildKey {
		t.Errorf("withdrawals %v", w)
	}
	if _, err := h.Command(ctx, "notify", nil, pluginsdk.UiContext{}); err == nil {
		t.Error("notify without a thread went")
	}
}

func mustView(t *testing.T, h *plugintest.Host) []byte {
	t.Helper()
	raw, ok := h.View(inst)
	if !ok {
		t.Fatal("no view")
	}
	return raw
}

// Each tick carries a notification: raised when no thread is subscribed, not raised when
// one got the wake, raised either way when time-sensitive; one per every, updated in
// place.
func TestTickNotification(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h, _ := startNotifying(t)
	fire := func(args map[string]string) string {
		t.Helper()
		res, err := h.Command(ctx, "fire-tick", args, pluginsdk.UiContext{})
		if err != nil {
			t.Fatal(err)
		}
		line, _, _ := strings.Cut(res.Message, "\n")
		return line
	}
	if got := fire(map[string]string{"every": "1h"}); got != "fired tick for every=1h: woke 0; notification tick-1h posted" {
		t.Errorf("no subscriber: %q", got)
	}
	if _, err := h.SubscribeWake("tick", map[string]string{"every": "1h"}, pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	if got := fire(map[string]string{"every": "1h"}); got != "fired tick for every=1h: woke 1; a thread got it, so no notification" {
		t.Errorf("subscribed: %q", got)
	}
	if n, _, _ := h.Notification("tick-1h"); n.Title != "Tick 1 (every 1h)" {
		t.Errorf("a routed tick changed the notification: %+v", n)
	}
	if got := fire(map[string]string{"every": "1h", "time-sensitive": "true"}); got != "fired tick for every=1h: woke 1; notification tick-1h updated" {
		t.Errorf("time-sensitive, subscribed: %q", got)
	}
	if n, _, _ := h.Notification("tick-1h"); n.Title != "Tick 3 (every 1h)" || !n.TimeSensitive || n.Actions[0].Command != "fire-tick" {
		t.Errorf("after the time-sensitive tick: %+v", n)
	}
	if res, err := h.PressAction(ctx, "tick-1h", 0); err != nil || !strings.HasPrefix(res.Message, "fired tick for every=1h: woke 1") {
		t.Errorf("Fire again = %q, %v", res.Message, err)
	}
}
