package project

import (
	"context"
	"path/filepath"
	"sync"
	"time"
)

// Activity tiers (docs/notes/git-activity-tiers.md). The fetch loop and the backstop
// poll's reconcile run each project on one of two cadences:
//
//   - live: some worktree of the project is active: it has a live thread
//     (SetLiveWorktrees: not archived, not snoozed) or was asked for its detail
//     (WorktreeDetail) within DetailWatch. Reconciled every PollInterval, fetched every
//     FetchInterval.
//   - idle: everything else. Reconciled every IdlePollInterval, fetched every
//     IdleFetchInterval.
//
// The poll's status refreshes are tiered per worktree (wtPollSched): an active worktree
// is refreshed when its status is older than PollInterval, any other one when it is
// older than IdlePollInterval, even when a sibling is live
// (docs/notes/project-rescan-idle-poll.md).
//
// A project or worktree that turns active is checked at once: a fetch, reconcile or
// status older than the live interval runs now rather than at the next tick. Threads
// also drive status refreshes directly: Touch (a file-editing tool result, debounced)
// and TouchNow (a turn end).

// Defaults for the idle tier and Touch. Idle poll aligns with IdleFetchInterval (15m)
// so idle projects do not stagger redundant background sweeps.
const (
	DefaultIdlePollInterval  = 15 * time.Minute
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

// elapsedSince returns how much time has elapsed between last and now, taking the larger
// of wall-clock delta (so system sleep advances intervals on macOS/Linux where monotonic
// time pauses) and monotonic delta (so a backward wall-clock jump does not stall tiers).
// If both are negative (a backward jump on a wall-only clock with no monotonic reading),
// ok is false and callers treat the item as due immediately rather than stalling.
func elapsedSince(last, now time.Time) (time.Duration, bool) {
	elapsed := max(now.Round(0).Sub(last.Round(0)), now.Sub(last))
	if elapsed < 0 {
		return 0, false
	}
	return elapsed, true
}

// due reports whether project id, live or not, is due at now.
func (s *tierSched) due(id string, live bool, now time.Time) bool {
	last := s.lastRun(id)
	if last.IsZero() {
		return true
	}
	elapsed, ok := elapsedSince(last, now)
	return !ok || elapsed >= s.tier.every(live)
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
		elapsed, ok := elapsedSince(last, now)
		if !ok {
			return 0
		}
		w = min(w, s.tier.every(live(id))-elapsed)
	}
	return max(w, 0)
}

// tierLoop runs run(id) for every project when it is due, first after first (nudges
// are ignored until then), then whenever the next project is due or nudge fires
// (a project turned live). wake (optional, active immediately) forces a round for live
// projects after system sleep/wake. extra (optional) runs after every round from the
// first on and returns how long until it next has work; the loop sleeps until the
// sooner of that and the next project. name labels the debug log.
func (g *Git) tierLoop(ctx context.Context, name string, s *tierSched, first time.Duration, nudge, wake <-chan struct{}, run func(context.Context, string), extra func(now time.Time) time.Duration) {
	t := g.newLoopTimer(name, first)
	defer t.Stop()
	var nudged <-chan struct{}
	firstDone := false
	for {
		forceLive := false
		select {
		case <-ctx.Done():
			return
		case <-t.C():
			firstDone = true
			nudged = nudge
		case <-nudged:
		case <-wake:
			forceLive = true
			t.Stop()
		}
		ids := g.projectIDs()
		s.forget(ids)
		for _, id := range ids {
			if ctx.Err() != nil {
				return
			}
			now := g.now()
			live := g.projectLive(id, now)
			due := (!forceLive || firstDone) && s.due(id, live, now)
			if !((forceLive && live) || due) {
				continue
			}
			g.log.Debug(name, "project", id, "tier", tierName(live))
			s.ran(id, now)
			run(ctx, id)
		}
		now := g.now()
		if !firstDone {
			t.Reset(first)
			continue
		}
		w := s.wait(ids, func(id string) bool { return g.projectLive(id, now) }, now)
		if extra != nil {
			w = min(w, extra(now))
		}
		t.Reset(w)
	}
}

// tierTimer is a tier loop's timer: a time.Timer, or a test's (Options.loopTimers).
type tierTimer interface {
	C() <-chan time.Time
	Reset(time.Duration)
	Stop()
}

type stdTimer struct{ t *time.Timer }

func (t stdTimer) C() <-chan time.Time   { return t.t.C }
func (t stdTimer) Reset(d time.Duration) { t.t.Reset(d) }
func (t stdTimer) Stop()                 { t.t.Stop() }

// newLoopTimer starts the timer of the tier loop called name.
func (g *Git) newLoopTimer(name string, d time.Duration) tierTimer {
	if g.loopTimers != nil {
		return g.loopTimers(name, d)
	}
	return stdTimer{time.NewTimer(d)}
}

func tierName(live bool) string {
	if live {
		return "live"
	}
	return "idle"
}

// poll is the project half of the backstop poll: a reconcile (worktrees, metadata,
// stream sync, base resolution), at the project's tier. The worktrees' statuses are
// the other half, tiered per worktree (pollWorktrees).
func (g *Git) poll(_ context.Context, id string) {
	if g.project(id) == nil {
		return
	}
	g.sched.requestPrio(jobKey{kind: jobReconcile, projectID: id}, prioLow)
}

// wtPollSched decides when each worktree's backstop status refresh is due. It is owned
// by the poll loop's goroutine.
type wtPollSched struct {
	tier tier
	// seed is the last poll of a worktree the loop has not polled yet: the loop's
	// start (Start's reconcile just refreshed everything).
	seed time.Time
	last map[jobKey]time.Time
}

func newWtPollSched(t tier, seed time.Time) *wtPollSched {
	return &wtPollSched{tier: t, seed: seed, last: map[jobKey]time.Time{}}
}

// remaining is how long until a worktree is due: its interval (live when active)
// less the time since it was last refreshed, by this poll or by anything else
// (refreshed: its status's RefreshedAt, zero when it has none). Zero means due now.
// A refresh time that lies in the future (a wall-clock jump back, on a time with no
// monotonic reading) is ignored; a last poll in the future makes it due.
func (s *wtPollSched) remaining(k jobKey, active bool, refreshed, now time.Time) time.Duration {
	last, ok := s.last[k]
	if !ok {
		last = s.seed
	}
	elapsed, ok := elapsedSince(last, now)
	if !ok {
		return 0
	}
	if !refreshed.IsZero() {
		if e, ok := elapsedSince(refreshed, now); ok {
			elapsed = min(elapsed, e)
		}
	}
	return max(s.tier.every(active)-elapsed, 0)
}

// pollWorktrees is the worktree half of the backstop poll, run by the poll loop after
// every round: a low-priority status refresh of every worktree of a git project whose
// status is older than its tier's interval (live for an active worktree, idle for the
// rest, whatever its siblings are), so nothing the stream missed stays stale longer
// than that. It returns how long until the next worktree is due (at most the live
// interval, so a worktree that turned active is looked at again soon).
func (g *Git) pollWorktrees(s *wtPollSched, now time.Time) time.Duration {
	type wt struct {
		key       jobKey
		refreshed time.Time
	}
	var wts []wt
	g.mu.RLock()
	for id, st := range g.projects {
		if !st.meta.Load().Git {
			continue // no status to refresh (nogit.go)
		}
		for p, slot := range st.wts {
			wts = append(wts, wt{
				key:       jobKey{kind: jobStatus, projectID: id, path: p},
				refreshed: slot.cur.Load().Status.RefreshedAt,
			})
		}
	}
	g.mu.RUnlock()
	wait := s.tier.live
	seen := make(map[jobKey]bool, len(wts))
	for _, w := range wts {
		seen[w.key] = true
		active := g.worktreeActive(w.key.projectID, w.key.path)
		r := s.remaining(w.key, active, w.refreshed, now)
		if r == 0 {
			g.log.Debug("poll", "project", w.key.projectID, "worktree", w.key.path, "tier", tierName(active))
			s.last[w.key] = now
			g.sched.requestPrio(w.key, prioLow)
			r = s.tier.every(active)
		}
		wait = min(wait, r)
	}
	for k := range s.last {
		if !seen[k] {
			delete(s.last, k) // removed worktree or project
		}
	}
	return wait
}

// worktreeActive reports whether the worktree at path is active (has a live thread or a
// recent WorktreeDetail watch).
func (g *Git) worktreeActive(projectID, path string) bool {
	return g.isLive(path) || g.detailWatched(projectID, path, g.now())
}

// treeWindow returns the tree debounce window for k: activeTreeWindow for an active
// worktree (live thread or watched detail), else the default treeDeb window.
func (g *Git) treeWindow(k jobKey) time.Duration {
	if k.path != "" && g.worktreeActive(k.projectID, k.path) {
		return g.activeTreeWindow
	}
	return g.treeDeb.window
}

// eventPrio returns prioHigh for jobs targeting an active worktree (or a live project
// for project-wide jobs) and prioLow for idle worktrees and projects.
func (g *Git) eventPrio(k jobKey) priority {
	if k.path != "" {
		if g.worktreeActive(k.projectID, k.path) {
			return prioHigh
		}
		return prioLow
	}
	if k.projectID != "" && g.projectLive(k.projectID, g.now()) {
		return prioHigh
	}
	return prioLow
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
		g.sched.requestHigh(k)
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
