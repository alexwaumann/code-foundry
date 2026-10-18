package plugintest_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

type surface struct{}

func (surface) Act(context.Context, pluginsdk.SurfaceAct) error { return errors.New("no") }
func (surface) Visibility(bool)                                 {}
func (surface) Close(pluginsdk.CloseReason)                     {}

// Start waits for Init, which sees the preset secrets and flags; OpenSurfaceWith hands
// the plugin its facts; WaitFor also notices state the host never sees.
func TestStartOptionsAndSurfaceFacts(t *testing.T) {
	var initFlags, initSecret atomic.Value
	var later atomic.Bool
	p := pluginsdk.Plugin{
		Init: func(ctx context.Context, h *pluginsdk.Host) error {
			time.Sleep(50 * time.Millisecond) // Start must wait for this
			initFlags.Store(len(h.Flags()))
			v, _, err := h.Secrets().Get(ctx, "token")
			initSecret.Store(v)
			go func() { time.Sleep(30 * time.Millisecond); later.Store(true) }()
			return err
		},
		Surfaces: map[string]pluginsdk.SurfaceFactory{
			"runs": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				var pr struct {
					Repo   string `json:"repo"`
					Number int    `json:"number"`
				}
				if err := json.Unmarshal(open.Facts["pr"], &pr); err != nil {
					return nil, err
				}
				return surface{}, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{ui.NewText("pr", ui.Plain(pr.Repo))}})
			},
		},
	}
	h := plugintest.Start(t, p, plugintest.Options{
		Granted: pluginsdk.Permissions{Secrets: true},
		Secrets: map[string]string{"token": "t0k"},
		Flags:   []pluginsdk.Flag{{ThreadID: "s-1", Level: pluginsdk.FlagError, Reason: "old"}},
	})
	if initFlags.Load() != 1 || initSecret.Load() != "t0k" {
		t.Fatalf("after Start: flags %v, secret %v", initFlags.Load(), initSecret.Load())
	}
	if h.DataDir() == "" {
		t.Error("no data dir")
	}
	h.WaitFor(2*time.Second, func(*plugintest.Host) bool { return later.Load() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const inst = "test/runs/pr:octo/app#12"
	err := h.OpenSurfaceWith(ctx, pluginsdk.SurfaceOpen{Instance: inst, Surface: "runs",
		Facts: map[string]json.RawMessage{"pr": json.RawMessage(`{"repo":"octo/app","number":12,"url":"https://github.com/octo/app/pull/12"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := h.View(inst); string(raw) != `{"nodes":[{"key":"pr","text":{"content":"octo/app"}}]}` {
		t.Errorf("view %s", raw)
	}
}

// reasonSurface records why it was closed.
type reasonSurface struct{ got chan pluginsdk.CloseReason }

func (reasonSurface) Act(context.Context, pluginsdk.SurfaceAct) error { return nil }
func (reasonSurface) Visibility(bool)                                 {}
func (s reasonSurface) Close(r pluginsdk.CloseReason)                 { s.got <- r }

// Surface.Close gets the host's reason; the SDK closes the rest with shutdown.
func TestCloseReasons(t *testing.T) {
	got := make(chan pluginsdk.CloseReason, 8)
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			return reasonSurface{got: got}, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{ui.NewText("t", ui.Plain("x"))}})
		},
	}}
	h := plugintest.Start(t, p, plugintest.Options{})
	for _, tt := range []struct {
		inst  string
		close func(string) error
		want  pluginsdk.CloseReason
	}{
		{"p/s/thread:a", h.CloseSurface, pluginsdk.CloseIdle},
		{"p/s/thread:b", func(i string) error { return h.CloseSurfaceFor(i, pluginsdk.CloseContextGone) }, pluginsdk.CloseContextGone},
		{"p/s/thread:c", func(i string) error { return h.CloseSurfaceFor(i, pluginsdk.CloseUnavailable) }, pluginsdk.CloseUnavailable},
	} {
		if err := h.OpenSurface(context.Background(), tt.inst, "s", pluginsdk.UiContext{}); err != nil {
			t.Fatal(err)
		}
		if err := tt.close(tt.inst); err != nil {
			t.Fatal(err)
		}
		select {
		case r := <-got:
			if r != tt.want {
				t.Errorf("%s: closed for %q, want %q", tt.inst, r, tt.want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: not closed", tt.inst)
		}
	}
}
