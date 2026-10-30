package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

type countingRefresher struct{ n atomic.Int32 }

func (c *countingRefresher) RefreshEditorApps() { c.n.Add(1) }

func TestEditorAppsRefreshOnSettingsChange(t *testing.T) {
	b := bus.New()
	r := &countingRefresher{}
	stop := startEditorAppsRefresh(context.Background(), r, b)
	defer stop()
	bus.Publish(b, settings.Changed{})
	deadline := time.Now().Add(5 * time.Second)
	for r.n.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if r.n.Load() != 1 {
		t.Errorf("refreshes = %d, want 1", r.n.Load())
	}
}
