package daemon

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

type countSkills struct{ loads, refreshes atomic.Int32 }

func (c *countSkills) Load(context.Context) error    { c.loads.Add(1); return nil }
func (c *countSkills) Refresh(context.Context) error { c.refreshes.Add(1); return nil }

func waitFor(t *testing.T, what string, n *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for n.Load() != want {
		if time.Now().After(deadline) {
			t.Fatalf("%s = %d, want %d", what, n.Load(), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestStartSkills(t *testing.T) {
	tests := []struct {
		name    string
		enabled bool
	}{
		{name: "read at start, refresh after each update check", enabled: true},
		{name: "read at start, refresh on their own when updates are disabled", enabled: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(update.EnvInitialDelay, "0s")
			b := bus.New()
			c := &countSkills{}
			stop := startSkills(context.Background(), slog.New(slog.DiscardHandler), b, fakeUpdater{enabled: tt.enabled}, c)
			defer stop()
			waitFor(t, "loads", &c.loads, 1)
			if !tt.enabled {
				waitFor(t, "refreshes", &c.refreshes, 1)
				return
			}
			if c.refreshes.Load() != 0 {
				t.Fatal("refreshed before the first update check")
			}
			at := time.Unix(100, 0)
			bus.Publish(b, update.Event{Status: update.Status{LastCheckedAt: at}})
			waitFor(t, "refreshes", &c.refreshes, 1)
			bus.Publish(b, update.Event{Status: update.Status{LastCheckedAt: at}}) // same check
			bus.Publish(b, update.Event{Status: update.Status{LastCheckedAt: at.Add(time.Hour)}})
			waitFor(t, "refreshes", &c.refreshes, 2)
			if c.loads.Load() != 1 {
				t.Errorf("loads = %d", c.loads.Load())
			}
		})
	}
}
