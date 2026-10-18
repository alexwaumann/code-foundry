package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// The manifest beside the plugin is valid and declares every command it serves.
func TestManifest(t *testing.T) {
	data, err := os.ReadFile("plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	m, warnings, err := pluginsdk.LoadManifest(data)
	if err != nil || len(warnings) > 0 {
		t.Fatalf("plugin.json: %v %v", err, warnings)
	}
	served := plugin().Commands
	for _, c := range m.Commands {
		if served[c.Name] == nil {
			t.Errorf("%s declared but not served", c.Name)
		}
	}
	if len(served) != len(m.Commands) {
		t.Errorf("serves %d commands, declares %d", len(served), len(m.Commands))
	}
}

func TestCommands(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{
		Name:    "hello",
		Granted: pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true},
		Invoke: func(_ context.Context, p pluginsdk.InvokeParams) (pluginsdk.CommandResult, error) {
			return pluginsdk.CommandResult{Message: "to " + p.Context.ThreadID + ": " + p.Args["text"]}, nil
		},
	})
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return len(h.Logs()) > 0 })
	if l := h.Logs()[0]; l.Msg != "hello is up" {
		t.Errorf("first log %+v", l)
	}
	tests := []struct {
		cmd  string
		args map[string]string
		uctx pluginsdk.UiContext
		want string
	}{
		{"greet", map[string]string{"name": "Ada"}, pluginsdk.UiContext{}, "Hello, Ada!"},
		{"send", map[string]string{"text": "hi"}, pluginsdk.UiContext{ThreadID: "t-1"}, "sent: to t-1: hi"},
		{"send", map[string]string{"text": "hi", "thread": "t-2"}, pluginsdk.UiContext{ThreadID: "t-1"}, "sent: to t-2: hi"},
		{"recall", nil, pluginsdk.UiContext{}, "nothing remembered yet"},
		{"remember", map[string]string{"word": "swordfish"}, pluginsdk.UiContext{}, "remembered"},
		{"recall", nil, pluginsdk.UiContext{}, "the word is swordfish"},
		{"forget", nil, pluginsdk.UiContext{}, "forgotten"},
		{"recall", nil, pluginsdk.UiContext{}, "nothing remembered yet"},
	}
	for _, tt := range tests {
		res, err := h.Command(ctx, tt.cmd, tt.args, tt.uctx)
		if err != nil || !strings.HasPrefix(res.Message, tt.want) {
			t.Errorf("%s %v = %q, %v; want %q", tt.cmd, tt.args, res.Message, err, tt.want)
		}
	}
	if _, err := h.Command(ctx, "send", map[string]string{"text": "x"}, pluginsdk.UiContext{}); err == nil || !strings.Contains(err.Error(), "no thread") {
		t.Errorf("send without a thread: %v", err)
	}
	for _, l := range h.Logs() {
		if strings.Contains(fmt.Sprint(l.Msg, l.Attrs), "swordfish") {
			t.Errorf("the secret was logged: %+v", l)
		}
	}
	// Init pushed CF_HELLO=1 and subscribed to the thread list.
	if envs := h.Environments(); len(envs) != 1 || envs[0].Env["CF_HELLO"] != "1" || envs[0].Scope == nil || !envs[0].Scope.NoProject {
		t.Errorf("environments = %+v", envs)
	}
	if subs := h.Subscriptions(); len(subs) != 1 || len(subs[0]) != 1 || subs[0][0] != "threads" {
		t.Errorf("subscriptions = %v", subs)
	}
	for _, ev := range []string{`{"threadList":{"snapshot":{}}}`, `{"threadList":{"updated":{"id":"s-1"}},"seq":"4"}`} {
		if err := h.Event(pluginsdk.Event{Subscription: "sub-1", Event: json.RawMessage(ev)}); err != nil {
			t.Fatal(err)
		}
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool {
		res, err := h.Command(ctx, "events", nil, pluginsdk.UiContext{})
		return err == nil && res.Message == "2 thread list events"
	})
	if !slices.ContainsFunc(h.Logs(), func(l pluginsdk.LogParams) bool { return l.Msg == "event" && l.Attrs["kind"] == "threadList.updated" }) {
		t.Errorf("no event logged: %+v", h.Logs())
	}
	// flag raises and clears hello's flag on the thread.
	if res, err := h.Command(ctx, "flag", map[string]string{"level": "attention", "reason": "look"}, pluginsdk.UiContext{ThreadID: "t-1"}); err != nil || res.Message != "attention flag on t-1: look" {
		t.Errorf("flag = %+v, %v", res, err)
	}
	if res, err := h.Command(ctx, "flag", map[string]string{"level": "none"}, pluginsdk.UiContext{ThreadID: "t-1"}); err != nil || res.Message != "cleared the flag on t-1" {
		t.Errorf("flag none = %+v, %v", res, err)
	}
	if f := h.Flags(); len(f) != 2 || f[0].ThreadID != "t-1" || f[0].Level != "attention" || f[1].Level != "none" {
		t.Errorf("flags = %+v", f)
	}
	if _, err := h.Command(ctx, "flag", nil, pluginsdk.UiContext{}); err == nil || !strings.Contains(err.Error(), "no thread") {
		t.Errorf("flag without a thread: %v", err)
	}
	if err := h.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}
