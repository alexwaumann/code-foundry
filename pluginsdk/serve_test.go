package pluginsdk_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

func testPlugin(initDone chan<- struct{}) pluginsdk.Plugin {
	return pluginsdk.Plugin{
		Init: func(ctx context.Context, h *pluginsdk.Host) error {
			h.Log().Info("started", "name", h.Name())
			close(initDone)
			return nil
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"greet": func(_ context.Context, _ *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return pluginsdk.CommandResult{Message: "hello " + req.Arg("name")}, nil
			},
			"remember": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return pluginsdk.CommandResult{}, h.Secrets().Set(ctx, "word", req.Arg("word"))
			},
			"recall": func(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				v, ok, err := h.Secrets().Get(ctx, "word")
				if err != nil || !ok {
					return pluginsdk.CommandResult{}, errors.Join(err, errors.New("nothing remembered"))
				}
				return pluginsdk.CommandResult{Message: v}, nil
			},
			"send": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return h.Invoke(ctx, "thread.send", map[string]string{"text": req.Arg("text")}, req.Context)
			},
		},
	}
}

func TestServeCommands(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	initDone := make(chan struct{})
	h := plugintest.Start(t, testPlugin(initDone), plugintest.Options{
		Name:    "hello",
		Granted: pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true},
		Invoke: func(_ context.Context, p pluginsdk.InvokeParams) (pluginsdk.CommandResult, error) {
			return pluginsdk.CommandResult{Message: "sent to " + p.Context.ThreadID}, nil
		},
	})
	<-initDone
	h.WaitFor(time.Second, func(h *plugintest.Host) bool { return len(h.Logs()) == 1 })
	if l := h.Logs()[0]; l.Msg != "started" || l.Attrs["name"] != "hello" || l.Level != "info" {
		t.Errorf("log %+v", l)
	}

	res, err := h.Command(ctx, "greet", map[string]string{"name": "Ada"}, pluginsdk.UiContext{})
	if err != nil || res.Message != "hello Ada" {
		t.Fatalf("greet = %+v, %v", res, err)
	}
	if _, err := h.Command(ctx, "nope", nil, pluginsdk.UiContext{}); pluginsdk.ErrorCode(err) != pluginsdk.CodeNotFound {
		t.Errorf("unknown command: %v", err)
	}
	if _, err := h.Command(ctx, "remember", map[string]string{"word": "s3cret"}, pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	if v, ok := h.Secret("word"); !ok || v != "s3cret" {
		t.Errorf("secret = %q %v", v, ok)
	}
	if res, err := h.Command(ctx, "recall", nil, pluginsdk.UiContext{}); err != nil || res.Message != "s3cret" {
		t.Errorf("recall = %+v, %v", res, err)
	}
	res, err = h.Command(ctx, "send", map[string]string{"text": "hi"}, pluginsdk.UiContext{ThreadID: "t-1"})
	if err != nil || res.Message != "sent to t-1" {
		t.Fatalf("send = %+v, %v", res, err)
	}
	if inv := h.Invocations(); len(inv) != 1 || inv[0].Args["text"] != "hi" {
		t.Errorf("invocations %+v", inv)
	}
	if err := h.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestServePermissionDenied(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	initDone := make(chan struct{})
	h := plugintest.Start(t, testPlugin(initDone), plugintest.Options{})
	if _, err := h.Command(ctx, "remember", map[string]string{"word": "x"}, pluginsdk.UiContext{}); pluginsdk.ErrorCode(err) != pluginsdk.CodePermissionDenied {
		t.Errorf("secrets without permission: %v", err)
	}
	if _, err := h.Command(ctx, "send", map[string]string{"text": "x"}, pluginsdk.UiContext{}); pluginsdk.ErrorCode(err) != pluginsdk.CodePermissionDenied {
		t.Errorf("invoke without permission: %v", err)
	}
}

func TestServeInitErrorEndsServe(t *testing.T) {
	h := plugintest.Start(t, pluginsdk.Plugin{Init: func(context.Context, *pluginsdk.Host) error {
		return errors.New("no config")
	}}, plugintest.Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Serve returns; the conn closes and calls fail.
	for {
		if err := h.Ping(ctx); err != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Until Init returns, Serve holds back what the host sends (the re-armed wake
// subscriptions, wake/armed, events, new subscriptions, commands); then the
// notifications reach their handlers in the order they came.
func TestServeHoldsBackUntilInit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	release := make(chan struct{})
	var mu sync.Mutex
	var seen []string
	note := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, s)
	}
	got := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(seen)
	}
	p := pluginsdk.Plugin{
		Init: func(context.Context, *pluginsdk.Host) error {
			<-release
			note("init")
			return nil
		},
		OnWakeSubscribed: func(_ context.Context, _ *pluginsdk.Host, s pluginsdk.WakeSubscription) {
			note(fmt.Sprintf("subscribed %s rearm=%v", s.Subscription, s.Rearm))
		},
		OnWakeArmed: func(_ context.Context, _ *pluginsdk.Host, n int) { note(fmt.Sprintf("armed %d", n)) },
		OnWakeUnsubscribed: func(_ context.Context, _ *pluginsdk.Host, u pluginsdk.WakeUnsubscribed) {
			note("unsubscribed " + u.Subscription)
		},
		OnEvent: func(_ context.Context, _ *pluginsdk.Host, ev pluginsdk.Event) { note("event " + ev.Subscription) },
		Commands: map[string]pluginsdk.CommandFunc{
			"hi": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				note("command")
				return pluginsdk.CommandResult{Message: "hi"}, nil
			},
		},
	}
	h := plugintest.Start(t, p, plugintest.Options{NoInitWait: true, WakeSubscriptions: []pluginsdk.WakeSubscription{
		{Subscription: "sub-a", Source: "tick"}, {Subscription: "sub-b", Source: "tick"},
	}})
	if err := h.Event(pluginsdk.Event{Subscription: "ev-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.SubscribeWake("tick", nil, pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	if err := h.UnsubscribeWake("sub-a"); err != nil {
		t.Fatal(err)
	}
	cmd := make(chan error, 1)
	go func() {
		_, err := h.Command(ctx, "hi", nil, pluginsdk.UiContext{})
		cmd <- err
	}()
	if err := h.Ping(ctx); err != nil { // ping is answered while Init runs
		t.Fatalf("ping during Init: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if s := got(); len(s) != 0 {
		t.Fatalf("handlers ran before Init returned: %q", s)
	}
	close(release)
	if err := <-cmd; err != nil {
		t.Fatalf("command after Init: %v", err)
	}
	h.WaitFor(time.Second, func(*plugintest.Host) bool { return len(got()) == 8 })
	s := got()
	if s[0] != "init" {
		t.Errorf("first = %q, want init", s[0])
	}
	notes := slices.DeleteFunc(slices.Clone(s[1:]), func(x string) bool { return x == "command" })
	want := []string{"subscribed sub-a rearm=true", "subscribed sub-b rearm=true", "armed 2", "event ev-1",
		"subscribed wsub-1 rearm=false", "unsubscribed sub-a"}
	if !slices.Equal(notes, want) {
		t.Errorf("notifications %q, want %q", notes, want)
	}
}

// A command held back while Init fails gets an error, not its handler.
func TestServeHeldBackWhenInitFails(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	fail := make(chan struct{})
	ran := make(chan struct{}, 1)
	h := plugintest.Start(t, pluginsdk.Plugin{
		Init: func(context.Context, *pluginsdk.Host) error {
			<-fail
			return errors.New("no config")
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"hi": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				ran <- struct{}{}
				return pluginsdk.CommandResult{}, nil
			},
		},
	}, plugintest.Options{NoInitWait: true})
	cmd := make(chan error, 1)
	go func() {
		_, err := h.Command(ctx, "hi", nil, pluginsdk.UiContext{})
		cmd <- err
	}()
	time.Sleep(50 * time.Millisecond)
	close(fail)
	if err := <-cmd; err == nil {
		t.Error("command answered after Init failed")
	}
	select {
	case <-ran:
		t.Error("the command's handler ran though Init failed")
	default:
	}
}
