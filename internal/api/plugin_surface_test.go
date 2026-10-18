package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/plugintest"
)

func newSurfaceServer(t *testing.T) (*plugintest.Fake, *plugintest.Surfaces, codefoundryv1connect.PluginServiceClient) {
	t.Helper()
	b := bus.New()
	fake, surfaces := plugintest.New(b), plugintest.NewSurfaces()
	h := NewPlugin(fake, b).WithSurfaces(surfaces)
	h.beat = 50 * time.Millisecond
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, surfaces, codefoundryv1connect.NewPluginServiceClient(srv.Client(), srv.URL)
}

var helloRef = &v1.SurfaceRef{Plugin: "hello", Surface: "main", Context: &v1.UiContext{ActiveThreadId: "s-1"}}

func TestPluginListSurfaceAvailability(t *testing.T) {
	fake, surfaces, c := newSurfaceServer(t)
	p := helloPlugin()
	p.Enabled = true
	fake.Put(p)
	surfaces.Why = "it shows a thread"
	list, err := c.List(context.Background(), connect.NewRequest(&v1.ListPluginsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	s := list.Msg.GetPlugins()[0].GetSurfaces()[0]
	if s.GetAvailable() || s.GetUnavailableReason() != "it shows a thread" || s.GetShowCommand() != "plugin.hello.show.main" ||
		s.GetKind() != "plugin.hello.main" || s.GetScope() != "thread" {
		t.Errorf("surface %v", s)
	}
	surfaces.Unknown = map[string]bool{"hello/main": true}
	list, _ = c.List(context.Background(), connect.NewRequest(&v1.ListPluginsRequest{}))
	if s := list.Msg.GetPlugins()[0].GetSurfaces()[0]; s.GetAvailable() || !s.GetUnknown() {
		t.Errorf("a clause not known yet: %v", s)
	}
	surfaces.Available["hello/main"] = true
	list, _ = c.List(context.Background(), connect.NewRequest(&v1.ListPluginsRequest{Context: &v1.UiContext{ActiveThreadId: "s-1"}}))
	if s := list.Msg.GetPlugins()[0].GetSurfaces()[0]; !s.GetAvailable() {
		t.Errorf("surface %v", s)
	}
}

func TestWatchSurface(t *testing.T) {
	_, surfaces, c := newSurfaceServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := c.WatchSurface(ctx, connect.NewRequest(&v1.WatchSurfaceRequest{Ref: helloRef})); err != nil {
		t.Fatal(err)
	}
	surfaces.Available["hello/main"] = true
	stream, err := c.WatchSurface(ctx, connect.NewRequest(&v1.WatchSurfaceRequest{Ref: helloRef}))
	if err != nil {
		t.Fatal(err)
	}
	for surfaces.Watches() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if ref := surfaces.Refs()[0]; ref.Context.ActiveThreadID != "s-1" || ref.Plugin != "hello" {
		t.Errorf("ref %+v", ref)
	}
	key := "hello/main/thread:s-1"
	surfaces.Push(plugin.SurfaceUpdate{State: &plugin.SurfaceState{Instance: key, Phase: plugin.PhaseLive}})
	surfaces.Push(plugin.SurfaceUpdate{View: &plugin.SurfaceView{Instance: key, Version: 3, JSON: []byte(`{"nodes":[]}`)}})
	surfaces.Push(plugin.SurfaceUpdate{Append: &plugin.SurfaceAppend{Instance: key, Version: 3, Key: "log", Text: "x\n"}})
	surfaces.Push(plugin.SurfaceUpdate{Toast: &plugin.SurfaceToast{Instance: key, Level: "error", Text: "boom"}})
	var got []string
	beats := 0
	for (len(got) < 4 || beats == 0) && stream.Receive() {
		m := stream.Msg()
		switch {
		case m.GetState() != nil:
			got = append(got, "state "+m.GetState().GetPhase().String())
		case m.GetView() != nil:
			got = append(got, fmt.Sprintf("view %d %s", m.GetView().GetVersion(), m.GetView().GetViewJson()))
		case m.GetAppend() != nil:
			got = append(got, "append "+m.GetAppend().GetKey()+" "+m.GetAppend().GetText())
		case m.GetToast() != nil:
			got = append(got, "toast "+m.GetToast().GetText())
		case m.GetHeartbeat() != nil:
			beats++
		}
	}
	want := fmt.Sprint([]string{"state SURFACE_PHASE_LIVE", `view 3 {"nodes":[]}`, "append log x\n", "toast boom"})
	if fmt.Sprint(got) != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestGetSurfaceAndAct(t *testing.T) {
	_, surfaces, c := newSurfaceServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	surfaces.Available["hello/main"] = true
	surfaces.Elements = []plugin.SurfaceElement{{Key: "go", Kind: "click", Action: "go", Label: "Go"}}
	key := "hello/main/thread:s-1"
	go func() {
		for surfaces.Watches() == 0 {
			time.Sleep(5 * time.Millisecond)
		}
		surfaces.Push(plugin.SurfaceUpdate{State: &plugin.SurfaceState{Instance: key, Phase: plugin.PhaseOpening}})
		surfaces.Push(plugin.SurfaceUpdate{View: &plugin.SurfaceView{Instance: key, Version: 1, JSON: []byte(`{"nodes":[{"key":"cached"}]}`)}})
		surfaces.Push(plugin.SurfaceUpdate{State: &plugin.SurfaceState{Instance: key, Phase: plugin.PhaseLive}})
		surfaces.Push(plugin.SurfaceUpdate{View: &plugin.SurfaceView{Instance: key, Version: 2, JSON: []byte(`{"nodes":[]}`)}})
	}()
	res, err := c.GetSurface(ctx, connect.NewRequest(&v1.GetSurfaceRequest{Ref: helloRef}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetView().GetVersion() != 2 || res.Msg.GetState().GetPhase() != v1.SurfacePhase_SURFACE_PHASE_LIVE ||
		len(res.Msg.GetElements()) != 1 || res.Msg.GetElements()[0].GetKind() != "click" {
		t.Errorf("get %v", res.Msg)
	}

	values, _ := structpb.NewStruct(map[string]any{"name": "Ada", "on": true, "tags": []any{"a"}})
	v := "x"
	act, err := c.Act(ctx, connect.NewRequest(&v1.SurfaceActRequest{Instance: key, Version: 2, Key: "go", Action: "go", Value: &v, Values: values}))
	if err != nil || act.Msg.GetVersion() != 2 {
		t.Fatalf("act %v %v", act, err)
	}
	got := surfaces.Acts()[0]
	if got.Instance != key || got.Key != "go" || *got.Value != "x" || got.Values["on"] != true || fmt.Sprint(got.Values["tags"]) != "[a]" {
		t.Errorf("act request %+v", got)
	}
	surfaces.ActErr = fmt.Errorf("%w: it broke", plugin.ErrPluginRefused)
	if _, err := c.Act(ctx, connect.NewRequest(&v1.SurfaceActRequest{Instance: key, Key: "go"})); connect.CodeOf(err) != connect.CodeAborted {
		t.Errorf("plugin error: %v", err)
	}
	surfaces.ActErr = fmt.Errorf("%w: gone", plugin.ErrFailedPrecondition)
	if _, err := c.Act(ctx, connect.NewRequest(&v1.SurfaceActRequest{Instance: key, Key: "go"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("precondition: %v", err)
	}
}

func TestSurfacesUnimplemented(t *testing.T) {
	_, c := newPluginServer(t)
	_, err := c.Act(context.Background(), connect.NewRequest(&v1.SurfaceActRequest{}))
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeUnimplemented {
		t.Errorf("act without surfaces: %v", err)
	}
}
