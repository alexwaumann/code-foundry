package project

import (
	"context"
	"slices"
	"sync"
	"time"
)

// priority orders jobs in the scheduler: prioHigh is for user-waited calls and active
// worktrees; prioLow is for background polls, startup reconciles, and idle worktrees.
type priority uint8

const (
	prioLow priority = iota
	prioHigh
)

type jobKind uint8

const (
	// jobReconcile owns a project's metadata, worktree set, and fs routes.
	jobReconcile jobKind = iota + 1
	// jobStatus owns one worktree's snapshot slot.
	jobStatus
	// jobDetail owns one worktree's cached detail (detail.go).
	jobDetail
	// jobBase owns a project's resolved base sha (base.go).
	jobBase
	// jobFiles owns one worktree's collected file changes (files.go).
	jobFiles
)

func (k jobKind) String() string {
	switch k {
	case jobReconcile:
		return "reconcile"
	case jobStatus:
		return "status"
	case jobDetail:
		return "detail"
	case jobBase:
		return "base"
	case jobFiles:
		return "files"
	}
	return "jobKind(?)"
}

// jobKey identifies a job. A key is never run by two workers at once, which is what
// makes each snapshot slot single-writer.
type jobKey struct {
	kind      jobKind
	projectID string
	path      string // worktree path for jobStatus, jobDetail, jobFiles
}

type jobState struct {
	queued    bool
	running   bool
	rerun     bool
	prio      priority // priority of queued entry
	rerunPrio priority // highest priority requested for pending rerun
	// waiters are released when a run that starts after they were added finishes.
	waiters []chan struct{}
}

// scheduler is a bounded worker pool over deduplicated job keys with two priority tiers
// (prioHigh before prioLow). Requests for a key that is already queued coalesce (and a
// prioHigh request promotes a queued prioLow job); requests for a key that is running
// schedule one rerun after it finishes at the highest requested priority.
type scheduler struct {
	mu     sync.Mutex
	cond   *sync.Cond
	high   []jobKey
	low    []jobKey
	jobs   map[jobKey]*jobState
	closed bool
	wg     sync.WaitGroup
}

func newScheduler(ctx context.Context, workers int, run func(context.Context, jobKey)) *scheduler {
	s := &scheduler{jobs: map[jobKey]*jobState{}}
	s.cond = sync.NewCond(&s.mu)
	for range workers {
		s.wg.Go(func() { s.work(ctx, run) })
	}
	return s
}

// request schedules k at prioLow and returns a channel closed once a run of k that
// started after this call has finished (or the scheduler closed).
func (s *scheduler) request(k jobKey) <-chan struct{} {
	return s.requestPrio(k, prioLow)
}

// requestHigh schedules k at prioHigh, promoting it if already queued at prioLow.
func (s *scheduler) requestHigh(k jobKey) <-chan struct{} {
	return s.requestPrio(k, prioHigh)
}

// requestPrio schedules k at priority p and returns a channel closed once a run of k
// that started after this call has finished (or the scheduler closed).
func (s *scheduler) requestPrio(k jobKey, p priority) <-chan struct{} {
	ch := make(chan struct{})
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		close(ch)
		return ch
	}
	st := s.jobs[k]
	if st == nil {
		st = &jobState{}
		s.jobs[k] = st
	}
	st.waiters = append(st.waiters, ch)
	switch {
	case st.running:
		st.rerun = true
		if p > st.rerunPrio {
			st.rerunPrio = p
		}
	case st.queued:
		if p > st.prio {
			// Promote from low to high queue.
			if idx := slices.Index(s.low, k); idx >= 0 {
				s.low = slices.Delete(s.low, idx, idx+1)
			}
			st.prio = p
			s.high = append(s.high, k)
			s.cond.Signal()
		}
	default:
		st.queued = true
		st.prio = p
		if p == prioHigh {
			s.high = append(s.high, k)
		} else {
			s.low = append(s.low, k)
		}
		s.cond.Signal()
	}
	return ch
}

// wait requests every key at prioHigh and blocks until all have run or ctx is done.
func (s *scheduler) wait(ctx context.Context, keys ...jobKey) error {
	return s.waitPrio(ctx, prioHigh, keys...)
}

// waitPrio requests every key at priority p and blocks until all have run or ctx is done.
func (s *scheduler) waitPrio(ctx context.Context, p priority, keys ...jobKey) error {
	chans := make([]<-chan struct{}, len(keys))
	for i, k := range keys {
		chans[i] = s.requestPrio(k, p)
	}
	for _, ch := range chans {
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (s *scheduler) popLocked() jobKey {
	if len(s.high) > 0 {
		k := s.high[0]
		s.high[0] = jobKey{}
		s.high = s.high[1:]
		if len(s.high) == 0 {
			s.high = nil
		}
		return k
	}
	k := s.low[0]
	s.low[0] = jobKey{}
	s.low = s.low[1:]
	if len(s.low) == 0 {
		s.low = nil
	}
	return k
}

func (s *scheduler) work(ctx context.Context, run func(context.Context, jobKey)) {
	for {
		s.mu.Lock()
		for len(s.high) == 0 && len(s.low) == 0 && !s.closed {
			s.cond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		k := s.popLocked()
		st := s.jobs[k]
		st.queued, st.running = false, true
		waiters := st.waiters
		st.waiters = nil
		s.mu.Unlock()

		run(ctx, k)

		s.mu.Lock()
		st.running = false
		for _, ch := range waiters {
			close(ch)
		}
		switch {
		case st.rerun && !s.closed:
			st.rerun, st.queued = false, true
			st.prio = st.rerunPrio
			st.rerunPrio = prioLow
			if st.prio == prioHigh {
				s.high = append(s.high, k)
			} else {
				s.low = append(s.low, k)
			}
			s.cond.Signal()
		case len(st.waiters) == 0:
			delete(s.jobs, k)
		}
		s.mu.Unlock()
	}
}

// close stops the workers after their current job and releases every waiter.
func (s *scheduler) close() {
	s.mu.Lock()
	s.closed = true
	for _, st := range s.jobs {
		for _, ch := range st.waiters {
			close(ch)
		}
		st.waiters = nil
	}
	s.high = nil
	s.low = nil
	s.cond.Broadcast()
	s.mu.Unlock()
	s.wg.Wait()
}

// debouncer coalesces triggers per key: the first trigger arms a timer, triggers
// while it is armed are absorbed, and the key fires once when it expires. Latency is
// therefore bounded by the window even under a continuous stream of events.
type debouncer struct {
	mu     sync.Mutex
	window time.Duration
	timers map[jobKey]stopper
	fire   func(jobKey)
	closed bool
	// after arms a timer: time.AfterFunc, or a test's clock (setClock).
	after func(time.Duration, func()) stopper
}

// stopper is an armed timer.
type stopper interface{ Stop() bool }

func newDebouncer(window time.Duration, fire func(jobKey)) *debouncer {
	return &debouncer{window: window, timers: map[jobKey]stopper{}, fire: fire, after: afterFunc}
}

func afterFunc(d time.Duration, f func()) stopper { return time.AfterFunc(d, f) }

// setClock replaces the timers the debouncer arms from now on (tests).
func (d *debouncer) setClock(after func(time.Duration, func()) stopper) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.after = after
}

func (d *debouncer) trigger(k jobKey) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.timers[k] != nil {
		return
	}
	var t stopper
	t = d.after(d.window, func() {
		d.mu.Lock()
		mine := d.timers[k] == t // false once cancelled (or cancelled and re-armed)
		if mine {
			delete(d.timers, k)
		}
		fire := mine && !d.closed
		d.mu.Unlock()
		if fire {
			d.fire(k)
		}
	})
	d.timers[k] = t
}

// cancel drops k's armed timer, if any: the caller runs the job itself.
func (d *debouncer) cancel(k jobKey) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if t := d.timers[k]; t != nil {
		t.Stop()
		delete(d.timers, k)
	}
}

func (d *debouncer) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.closed = true
	for k, t := range d.timers {
		t.Stop()
		delete(d.timers, k)
	}
}
