package repo

import (
	"context"
	"sync"
	"time"
)

type jobKind uint8

const (
	// jobReconcile owns a repo's metadata, worktree set, and watches.
	jobReconcile jobKind = iota + 1
	// jobStatus owns one worktree's snapshot slot.
	jobStatus
	// jobDetail owns one worktree's cached detail (detail.go).
	jobDetail
	// jobBase owns a repo's resolved base sha (base.go).
	jobBase
)

// jobKey identifies a job. A key is never run by two workers at once, which is what
// makes each snapshot slot single-writer.
type jobKey struct {
	kind   jobKind
	repoID string
	path   string // worktree path for jobStatus
}

type jobState struct {
	queued  bool
	running bool
	rerun   bool
	// waiters are released when a run that starts after they were added finishes.
	waiters []chan struct{}
}

// scheduler is a bounded worker pool over deduplicated job keys. Requests for a key
// that is already queued coalesce; requests for a key that is running schedule one
// rerun after it finishes.
type scheduler struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  []jobKey
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

// request schedules k and returns a channel closed once a run of k that started after
// this call has finished (or the scheduler closed).
func (s *scheduler) request(k jobKey) <-chan struct{} {
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
	case !st.queued:
		st.queued = true
		s.queue = append(s.queue, k)
		s.cond.Signal()
	}
	return ch
}

// wait requests every key and blocks until all have run or ctx is done.
func (s *scheduler) wait(ctx context.Context, keys ...jobKey) error {
	chans := make([]<-chan struct{}, len(keys))
	for i, k := range keys {
		chans[i] = s.request(k)
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

func (s *scheduler) work(ctx context.Context, run func(context.Context, jobKey)) {
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.closed {
			s.cond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		k := s.queue[0]
		s.queue = s.queue[1:]
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
			s.queue = append(s.queue, k)
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
	s.queue = nil
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
	timers map[jobKey]*time.Timer
	fire   func(jobKey)
	closed bool
}

func newDebouncer(window time.Duration, fire func(jobKey)) *debouncer {
	return &debouncer{window: window, timers: map[jobKey]*time.Timer{}, fire: fire}
}

func (d *debouncer) trigger(k jobKey) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.timers[k] != nil {
		return
	}
	d.timers[k] = time.AfterFunc(d.window, func() {
		d.mu.Lock()
		delete(d.timers, k)
		closed := d.closed
		d.mu.Unlock()
		if !closed {
			d.fire(k)
		}
	})
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
