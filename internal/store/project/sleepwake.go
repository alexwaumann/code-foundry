package project

import (
	"context"
	"sync"
	"time"
)

// Sleep/wake detection parameters for the project store.
const (
	wakeCheckInterval  = 5 * time.Second
	sleepSkewThreshold = 10 * time.Second
	sleepTickMargin    = 15 * time.Second
)

// wakeSample captures wall and monotonic readings at the same instant. wall has its
// monotonic reading stripped via Round(0); mono retains it when available.
type wakeSample struct {
	wall time.Time
	mono time.Time
}

func systemWakeSample() wakeSample {
	t := time.Now()
	return wakeSample{wall: t.Round(0), mono: t}
}

// wakeConfig injects deterministic sleep/wake triggers in tests. Nil in production.
type wakeConfig struct {
	tickInterval time.Duration
	ticks        <-chan time.Time
	sample       func() wakeSample
}

// sleepJump reports whether the transition (wallDelta, monoDelta) indicates a sleep/wake
// jump, returning the estimated sleep duration. Backward wall-clock jumps never trigger.
func sleepJump(wallDelta, monoDelta, tickInterval time.Duration, fromTick bool) (time.Duration, bool) {
	if skew := wallDelta - monoDelta; skew >= sleepSkewThreshold {
		return skew, true
	}
	if fromTick && tickInterval > 0 && wallDelta >= tickInterval+sleepTickMargin {
		return wallDelta - tickInterval, true
	}
	return 0, false
}

type sleepDetector struct {
	mu           sync.Mutex
	tickInterval time.Duration
	sample       func() wakeSample
	last         wakeSample
}

func newSleepDetector(tickInterval time.Duration, sample func() wakeSample) *sleepDetector {
	if tickInterval <= 0 {
		tickInterval = wakeCheckInterval
	}
	if sample == nil {
		sample = systemWakeSample
	}
	return &sleepDetector{
		tickInterval: tickInterval,
		sample:       sample,
		last:         sample(),
	}
}

func (d *sleepDetector) checkTick() (time.Duration, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cur := d.sample()
	wallDelta := cur.wall.Sub(d.last.wall)
	monoDelta := cur.mono.Sub(d.last.mono)
	d.last = cur
	return sleepJump(wallDelta, monoDelta, d.tickInterval, true)
}

// runWakeMonitor periodically checks for wall-clock jumps across system sleep and
// triggers onWake when the host resumes. Exits cleanly when ctx is cancelled.
func (g *Git) runWakeMonitor(ctx context.Context) {
	var tickInterval time.Duration
	var sample func() wakeSample
	var ticks <-chan time.Time
	if g.wakeCfg != nil {
		tickInterval = g.wakeCfg.tickInterval
		sample = g.wakeCfg.sample
		ticks = g.wakeCfg.ticks
	}
	det := newSleepDetector(tickInterval, sample)
	if ticks == nil {
		interval := wakeCheckInterval
		if tickInterval > 0 {
			interval = tickInterval
		}
		t := time.NewTicker(interval)
		defer t.Stop()
		ticks = t.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			if jump, ok := det.checkTick(); ok {
				g.onWake(jump)
			}
		}
	}
}

// onWake schedules a low-priority reconcile and base refresh for live projects and nudges
// the fetch loop so remote changes that landed during sleep are picked up promptly rather
// than waiting for the next 2-15 minute scheduled tick.
func (g *Git) onWake(jump time.Duration) {
	now := g.now()
	ids := g.projectIDs()
	liveCount := 0
	for _, id := range ids {
		if !g.projectLive(id, now) {
			continue
		}
		liveCount++
		g.sched.requestPrio(jobKey{kind: jobReconcile, projectID: id}, prioLow)
		g.sched.requestPrio(jobKey{kind: jobBase, projectID: id}, prioLow)
	}
	select {
	case g.fetchWake <- struct{}{}:
	default:
	}
	g.log.Info("project wake detected", "jump", jump.Round(time.Second).String(), "live_projects", liveCount)
}
