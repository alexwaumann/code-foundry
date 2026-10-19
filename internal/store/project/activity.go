package project

import (
	"context"
	"path/filepath"
	"sync"
	"time"
)

// Activity tiers (docs/notes/git-activity-tiers.md). The backstop poll and the fetch
// loop run each project on one of two cadences:
//
//   - live: some worktree of the project has a live thread (SetLiveWorktrees: not
//     archived, not snoozed) or was asked for its detail (WorktreeDetail) within
//     DetailWatch. Polled every PollInterval, fetched every FetchInterval.
//   - idle: everything else. Polled every IdlePollInterval, fetched every
//     IdleFetchInterval.
//
// A project that turns live is checked at once: a fetch (or poll) older than the live
// interval runs now rather than at the next tick. Threads also drive status refreshes
// directly: Touch (a file-editing tool result, debounced) and TouchNow (a turn end).

// Defaults for the idle tier and Touch.
const (
	DefaultIdlePollInterval  = 10 * time.Minute
	DefaultIdleFetchInterval = 15 * time.Minute
	// DefaultTouchDebounce is Touch's per-worktree window: the first touch arms it,
	// later ones in the window are absorbed, and one status refresh runs when it ends.
	DefaultTouchDebounce = 3 * time.Second
)

// liveSet is the worktrees SetLiveWorktrees last named, symlinks resolved.
type liveSet struct {
	mu    sync.Mutex
	paths map[string]bool
}

// tier is a loop's two cadences.
type tier struct{ live, idle time.Duration }

func (t tier) every(live bool) time.Duration {
	if live {
		return t.live
	}
	return t.idle
}

// tiers resolves Options' live and idle intervals for one loop: live defaults to
// defLive, idle to defIdle, and idle is never shorter than live.
func tiers(live, idle, defLive, defIdle time.Duration) tier {
	t := tier{live: interval(live, defLive), idle: interval(idle, defIdle)}
	t.idle = max(t.idle, t.live)
	return t
}

// tierSched decides when each project's periodic job is due. It is owned by one loop
// goroutine.
type tierSched struct {
	tier tier
	// seed is the last run of a project the loop has not run yet: zero makes it due at
	// once (fetch), the loop's start makes it due one interval later (poll: Start's
	// reconcile just refreshed everything).
	seed time.Time
	last map[string]time.Time
}

func newTierSched(t tier, seed time.Time) *tierSched {
	return &tierSched{tier: t, seed: seed, last: map[string]time.Time{}}
}

func (s *tierSched) lastRun(id string) time.Time {
	if at, ok := s.last[id]; ok {
		return at
	}
	return s.seed
}

// due reports whether project id, live or not, is due at now.
func (s *tierSched) due(id string, live bool, now time.Time) bool {
	last := s.lastRun(id)
	return last.IsZero() || !now.Before(last.Add(s.tier.every(live)))
}

// ran records a run (or an attempt) of id at at.
func (s *tierSched) ran(id string, at time.Time) { s.last[id] = at }

// forget drops projects not in ids (unregistered).
func (s *tierSched) forget(ids []string) {
	keep := make(map[string]bool, len(ids))
	for _, id := range ids {
		keep[id] = true
	}
	for id := range s.last {
		if !keep[id] {
			delete(s.last, id)
		}
	}
}

// wait is how long until the next project is due, at most the live interval (so a new
// project, or one whose detail watch lapsed, is looked at again soon) and never
// negative.
func (s *tierSched) wait(ids []string, live func(string) bool, now time.Time) time.Duration {
	w := s.tier.live
	for _, id := range ids {
		last := s.lastRun(id)
		if last.IsZero() {
			return 0
		}
		w = min(w, last.Add(s.tier.every(live(id))).Sub(now))
	}
	return max(w, 0)
}

// tierLoop runs run(id) for every project when it is due, first after first (nudges
// are ignored until then), then whenever the next project is due or nudge fires
// (a project turned live). name labels the debug log.
func (g *Git) tierLoop(ctx context.Context, name string, s *tierSched, first time.Duration, nudge <-chan struct{}, run func(context.Context, string)) {
	t := time.NewTimer(first)
	defer t.Stop()
	var nudged <-chan struct{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-nudged:
		}
		nudged = nudge
		ids := g.projectIDs()
		s.forget(ids)
		for _, id := range ids {
			if ctx.Err() != nil {
				return
			}
			now := g.now()
			live := g.projectLive(id, now)
			if !s.due(id, live, now) {
				continue
			}
			g.log.Debug(name, "project", id, "tier", tierName(live))
			s.ran(id, now)
			run(ctx, id)
		}
		now := g.now()
		t.Reset(s.wait(ids, func(id string) bool { return g.projectLive(id, now) }, now))
	}
}

func tierName(live bool) string {
	if live {
		return "live"
	}
	return "idle"
}

// poll is the backstop poll of one project.
func (g *Git) poll(_ context.Context, id string) {
	st := g.project(id)
	if st == nil {
		return
	}
	if m := st.meta.Load(); m.Error != "" || !m.Git {
		// Failed projects have no watches left; retry so a moved-back project recovers.
		// A project without git has none either: its reconcile is a stat that notices a
		// .git created outside the app.
		g.sched.request(jobKey{kind: jobReconcile, projectID: id})
		return
	}
	// Re-resolving the base each round covers ref moves the watcher cannot see;
	// jobBase then refreshes every worktree's status.
	g.sched.request(jobKey{kind: jobBase, projectID: id})
}

// projectLive reports whether project id has a live worktree at now: one in the live
// set, or one whose detail was asked for within DetailWatch.
func (g *Git) projectLive(id string, now time.Time) bool {
	g.mu.RLock()
	st := g.projects[id]
	var paths []string
	if st != nil {
		paths = make([]string, 0, len(st.wts))
		for p := range st.wts {
			paths = append(paths, p)
		}
	}
	g.mu.RUnlock()
	if st == nil {
		return false
	}
	g.live.mu.Lock()
	for _, p := range paths {
		if g.live.paths[p] {
			g.live.mu.Unlock()
			return true
		}
	}
	g.live.mu.Unlock()
	ds := &g.details
	ds.mu.Lock()
	defer ds.mu.Unlock()
	for k, at := range ds.requested {
		if k.projectID == id && now.Sub(at) <= DetailWatch {
			return true
		}
	}
	return false
}

// SetLiveWorktrees implements Store.
func (g *Git) SetLiveWorktrees(paths []string) {
	next := make(map[string]bool, len(paths))
	for _, p := range paths {
		if p != "" {
			next[realDir(p)] = true
		}
	}
	g.live.mu.Lock()
	prev := g.live.paths
	g.live.paths = next
	g.live.mu.Unlock()
	gained := false
	for p := range next {
		if !prev[p] {
			gained = true
			break
		}
	}
	if gained || len(prev) != len(next) {
		g.log.Debug("live worktrees", "count", len(next))
	}
	if gained {
		g.nudgeTiers()
	}
}

// isLive reports whether the worktree at path (symlinks resolved) is in the live set.
func (g *Git) isLive(path string) bool {
	g.live.mu.Lock()
	defer g.live.mu.Unlock()
	return g.live.paths[path]
}

// nudgeTiers wakes the poll and fetch loops: a project may have turned live.
func (g *Git) nudgeTiers() {
	for _, ch := range []chan struct{}{g.pollNudge, g.fetchNudge} {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// Touch implements Store.
func (g *Git) Touch(path string) {
	if k, ok := g.statusKey(path); ok {
		g.touch.trigger(k)
	}
}

// TouchNow implements Store.
func (g *Git) TouchNow(path string) {
	if k, ok := g.statusKey(path); ok {
		g.log.Debug("worktree touched", "path", k.path, "debounced", false)
		g.touch.cancel(k) // this refresh covers a pending debounced one
		g.sched.request(k)
	}
}

// statusKey is the status job of the worktree at path (symlinks resolved).
func (g *Git) statusKey(path string) (jobKey, bool) {
	if path == "" {
		return jobKey{}, false
	}
	p := realDir(path)
	g.mu.RLock()
	defer g.mu.RUnlock()
	for id, st := range g.projects {
		if _, ok := st.wts[p]; ok {
			return jobKey{kind: jobStatus, projectID: id, path: p}, true
		}
	}
	return jobKey{}, false
}

// realDir cleans path and resolves its symlinks, keeping the cleaned path when it
// cannot be resolved (a removed worktree).
func realDir(path string) string {
	path = filepath.Clean(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return path
}
