package daemon_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// TestLayoutEndToEnd runs the daemon: the layout source starts with one space, an op
// applied through LayoutService arrives as a delta, and the layout (a focus-only change
// included) is the same after the daemon restarts.
func TestLayoutEndToEnd(t *testing.T) {
	// Socket paths must fit in 104 bytes, so the home lives under /tmp.
	home, err := os.MkdirTemp("/tmp", "cf-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	base, _ := filepath.EvalSymlinks(t.TempDir())
	t.Setenv("HOME", base)
	p := paths.New(home)

	start := func() (*client.Client, func()) {
		ctx, stop := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}}) }()
		ep := waitEndpoint(t, p)
		return client.NewLoopback(ep.BaseURL, ep.Token), func() {
			stop()
			if err := <-done; err != nil {
				t.Errorf("daemon: %v", err)
			}
		}
	}

	c, stop := start()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	stream, err := c.Events.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{
		Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_LAYOUT}, ClientKind: v1.ClientKind_CLIENT_KIND_CLI,
	}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.LayoutEvent {
		t.Helper()
		for stream.Receive() {
			if l := stream.Msg().GetLayout(); l != nil {
				return l
			}
		}
		t.Fatalf("stream ended: %v", stream.Err())
		return nil
	}
	snap := next().GetSnapshot()
	if len(snap.GetSpaces()) != 1 || snap.GetSpaces()[0].GetName() != "Main" {
		t.Fatalf("snapshot = %v", snap)
	}
	main := snap.GetSpaces()[0].GetId()

	apply := func(op *v1.LayoutOp) *v1.ApplyLayoutResponse {
		t.Helper()
		res, err := c.Layout.Apply(ctx, connect.NewRequest(&v1.ApplyLayoutRequest{Op: op, ClientId: "e2e"}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg
	}
	res := apply(&v1.LayoutOp{Op: &v1.LayoutOp_NewSpace{NewSpace: &v1.NewSpaceOp{Name: "Review"}}})
	d := next()
	if d.GetRev() != res.GetRev() || d.GetClientId() != "e2e" || len(d.GetDelta().GetSpaces()) != 1 ||
		d.GetDelta().GetSpaces()[0].GetId() != res.GetSpaceId() {
		t.Fatalf("delta = %v; want the new space %s at rev %d", d, res.GetSpaceId(), res.GetRev())
	}
	review := res.GetSpaceId()
	apply(&v1.LayoutOp{Op: &v1.LayoutOp_AddTab{AddTab: &v1.AddTabOp{SpaceId: review, Tab: &v1.LayoutTab{Kind: "prs"}, Focus: true}}})
	next()
	// Focus-only: written within a second, or at shutdown.
	last := apply(&v1.LayoutOp{Op: &v1.LayoutOp_SwitchSpace{SwitchSpace: &v1.SwitchSpaceOp{SpaceId: main}}})
	if d := next(); d.GetRev() != last.GetRev() || d.GetDelta().GetCurrentSpaceId() != main {
		t.Fatalf("switch delta = %v", d)
	}
	before, err := c.Layout.Get(ctx, connect.NewRequest(&v1.GetLayoutRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	stop()

	c, stop = start()
	defer stop()
	ctx2, cancel2 := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel2()
	after, err := c.Layout.Get(ctx2, connect.NewRequest(&v1.GetLayoutRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	b, a := before.Msg.GetLayout(), after.Msg.GetLayout()
	if a.GetRev() != b.GetRev() || a.GetCurrentSpaceId() != main || len(a.GetSpaces()) != 2 ||
		a.GetSpaces()[1].GetRoot().GetPane().GetTabs()[0].GetKind() != "prs" {
		t.Errorf("after restart:\n%v\nwant\n%v", a, b)
	}
}
