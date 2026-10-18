package daemon

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

type countChecks struct{ n atomic.Int32 }

func (c *countChecks) CheckUpdates(context.Context, bool) ([]plugin.PluginUpdate, error) {
	c.n.Add(1)
	return nil, nil
}

// fakeUpdater is an update.Service whose Snapshot says enabled or not.
type fakeUpdater struct {
	update.Service
	enabled bool
}

func (f fakeUpdater) Snapshot() update.Status { return update.Status{Enabled: f.enabled} }

func waitCount(t *testing.T, c *countChecks, want int32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for c.n.Load() != want {
		if time.Now().After(deadline) {
			t.Fatalf("checks = %d, want %d", c.n.Load(), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPluginUpdateChecksRideTheUpdater(t *testing.T) {
	tests := []struct {
		name    string
		enabled bool
	}{
		{name: "after each update check", enabled: true},
		{name: "on their own when updates are disabled", enabled: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(update.EnvInitialDelay, "0s")
			b := bus.New()
			c := &countChecks{}
			stop := startPluginUpdateChecks(context.Background(), slog.New(slog.DiscardHandler), b, fakeUpdater{enabled: tt.enabled}, c)
			defer stop()
			if !tt.enabled {
				waitCount(t, c, 1)
				return
			}
			at := time.Unix(100, 0)
			bus.Publish(b, update.Event{Status: update.Status{Checking: true}}) // no check time: nothing
			bus.Publish(b, update.Event{Status: update.Status{LastCheckedAt: at}})
			waitCount(t, c, 1)
			bus.Publish(b, update.Event{Status: update.Status{LastCheckedAt: at, State: update.Available}}) // same check
			bus.Publish(b, update.Event{Status: update.Status{LastCheckedAt: at.Add(time.Hour)}})
			waitCount(t, c, 2)
		})
	}
}
