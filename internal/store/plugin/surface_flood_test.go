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
	// The host's clock moves only when the test moves it. A clock of time.Now plus the skew
	// also counted the real time each act took: under load (-race, a busy runner) one flood
	// of 100 views took over a second, so a window was more than two seconds old when the
	// next one began and did not count as a flooding second (docs/notes/flaky-ci-tests.md).
	base := time.Now()
	var skew atomic.Int64
	e := newSurfEnv(t, func(o *plugin.Options) {
		o.Now = func() time.Time { return base.Add(time.Duration(skew.Load())) }
	})
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
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

// A surface that floods and then goes silent is let go on a timer, a quiet FloodQuiet
// after its last flooding second: no further view is needed to lift the throttle and
// clear its flood issue.
func TestSurfaceFloodThrottleLiftsWhenSilent(t *testing.T) {
	tests := []struct {
		name string
		more bool // one more view a second after the flood, then silence
	}{
		{name: "silent after the flood"},
		{name: "one more view, then silent", more: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The clock moves only when the test moves it (TestSurfaceFloodThrottleLifts);
			// FloodQuiet is longer than one step of it, so the timer cannot lift the
			// throttle during the flood however long an act takes.
			base := time.Now()
			var skew atomic.Int64
			e := newSurfEnv(t, func(o *plugin.Options) {
				o.Now = func() time.Time { return base.Add(time.Duration(skew.Load())) }
				o.FloodQuiet = 1500 * time.Millisecond
			})
			w := e.watch("panel", s1)
			w.view("first view", contains("count 0"))
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
			if tt.more {
				act("inc")
			}
			skew.Add(int64(2 * time.Second))
			e.wait("surf", "the flood issue cleared", func(p plugin.Plugin) bool { return !flooded(p) })
			e.waitLog("is back under 50 views a second")
		})
	}
}
