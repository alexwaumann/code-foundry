package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/awaumann/code-foundry/internal/api"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/store/update"
	"github.com/awaumann/code-foundry/internal/store/update/updatetest"
)

// TestWatchRelaunch serves UpdateService on a Unix socket, as the daemon does, and checks
// that the host's watcher relaunches exactly once per request.
func TestWatchRelaunch(t *testing.T) {
	home, err := os.MkdirTemp("/tmp", "cf-relaunch-") // short: sun_path is 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	p := paths.New(home)

	b := bus.New()
	store := update.Start(context.Background(), update.Options{
		Current: "v0.1.0", Source: updatetest.NewSource("v0.1.0"), Installer: updatetest.NewInstaller(nil),
		InstalledVersion: updatetest.NewOnDisk("v0.1.0").Version, Bus: b, InitialDelay: time.Hour,
	})
	t.Cleanup(store.Close)
	route := api.NewUpdate(store, b, nil).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	ln, err := net.Listen("unix", p.Socket())
	if err != nil {
		t.Fatal(err)
	}
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	srv := &http.Server{Handler: mux, Protocols: &protocols}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	var relaunches atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchRelaunch(ctx, p, slog.New(slog.DiscardHandler), func() { relaunches.Add(1) })

	// Wait for the watcher's stream to be subscribed: the request is then delivered.
	deadline := time.Now().Add(5 * time.Second)
	for store.RequestRelaunch() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("watcher never subscribed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for relaunches.Load() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("relaunches = %d, want 1", relaunches.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Status changes alone never relaunch.
	if _, err := store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := relaunches.Load(); n != 1 {
		t.Fatalf("relaunches = %d after a status change, want 1", n)
	}
}
