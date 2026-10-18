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
func (surface) Close()                                          {}

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
