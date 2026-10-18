package pluginsdk_test

import (
	"context"
	"errors"
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
