package daemon_test

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
	"github.com/alexwaumann/code-foundry/internal/wstunnel/wstunneltest"
)

// The real daemon: EventService.Watch through the tunnel on the loopback listener, the route
// absent from the pages listener, and at shutdown the end of stream, a clean close, and Run
// returning with the tunnel drained.
func TestTunnelOnTheRunningDaemon(t *testing.T) {
	home, err := os.MkdirTemp("/tmp", "cf-ws-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("HOME", t.TempDir())
	p := paths.New(home)
	runCtx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(runCtx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}}) }()
	t.Cleanup(func() {
		stop()
		<-done
	})
	var ep client.Endpoint
	for i := 0; ; i++ {
		if ep, err = client.ReadEndpoint(p); err == nil {
			break
		}
		if i > 400 {
			t.Fatalf("daemon did not start: %v", err)
		}
		time.Sleep(25 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	root := "ws" + strings.TrimPrefix(ep.BaseURL, "http") + "/stream"
	origin := []string{"wails://localhost"}
	c, _, err := wstunneltest.Dial{URL: root + codefoundryv1connect.EventServiceWatchProcedure, Origins: origin}.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Conn.CloseNow() }()
	body, err := wstunneltest.Body(&v1.WatchEventsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, wstunneltest.Headers(ep.Token), body); err != nil {
		t.Fatal(err)
	}
	head, err := c.ReadHead(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != http.StatusOK {
		t.Fatalf("head = %+v", head)
	}
	if f, err := c.ReadFrame(ctx); err != nil || f.End() {
		t.Fatalf("first frame = %+v, err %v", f, err)
	}

	raw, err := os.ReadFile(p.PagesPort())
	if err != nil {
		t.Fatal(err)
	}
	pages := "ws://127.0.0.1:" + strings.TrimSpace(string(raw)) + "/stream"
	if _, resp, err := (wstunneltest.Dial{URL: pages + codefoundryv1connect.EventServiceWatchProcedure, Origins: origin}).Open(ctx); err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("pages listener: resp %v, err %v", resp, err)
	}

	stop()
	for {
		f, err := c.ReadFrame(ctx)
		if err != nil {
			t.Fatalf("the stream ended without its end of stream: %v", err)
		}
		if f.End() {
			break
		}
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Errorf("close = %v, want 1000", code)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon.Run = %v", err)
		}
		done <- nil // for the cleanup
	case <-ctx.Done():
		t.Fatal("daemon did not shut down")
	}
	// Drained before the stores closed.
	logs, err := os.ReadFile(p.DaemonLog())
	if err != nil {
		t.Fatal(err)
	}
	closed, stores := strings.Index(string(logs), "tunnel closed"), strings.Index(string(logs), "closing stores")
	if closed < 0 || stores < closed {
		t.Errorf("tunnel closed at %d, stores closing at %d in:\n%s", closed, stores, logs)
	}
}
