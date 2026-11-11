package plugin_test

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// Ten seconds of more than 50 views a second throttle a surface and raise its flood
// issue; a quiet minute after the last flooding second lifts both.
func TestSurfaceFloodThrottleLifts(t *testing.T) {
	var skew atomic.Int64
	e := newSurfEnv(t, func(o *plugin.Options) {
		o.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	})
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	waitOpen(t, e, w.key)
	act := func(key string) {
		t.Helper()
		if _, err := e.act(w.key, plugin.ActRequest{Key: key}); err != nil {
			t.Fatal(err)
		}
	}
	flooded := func(p plugin.Plugin) bool {
		return strings.Contains(strings.Join(p.Issues, "\n"), "surface panel flood: ")
	}
	for range 11 {
		act("flood")
		skew.Add(int64(time.Second))
	}
	e.wait("surf", "the flood issue", flooded)
	e.waitLog("sends more than 50 views a second")

	skew.Add(int64(30 * time.Second))
	act("inc")
	if p, _ := e.m.Snapshot().Plugin("surf"); !flooded(p) {
		t.Fatalf("lifted after 30 quiet seconds: %v", p.Issues)
	}

	skew.Add(int64(31 * time.Second))
	act("inc")
	e.wait("surf", "the flood issue cleared", func(p plugin.Plugin) bool { return !flooded(p) })
	e.waitLog("is back under 50 views a second")
}
