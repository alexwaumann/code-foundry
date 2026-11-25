package project

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedulerNeverRunsAKeyConcurrently(t *testing.T) {
	var (
		mu      sync.Mutex
		running = map[jobKey]bool{}
		overlap atomic.Bool
		runs    atomic.Int32
	)
	s := newScheduler(context.Background(), 4, func(_ context.Context, k jobKey) {
		mu.Lock()
		if running[k] {
			overlap.Store(true)
		}
		running[k] = true
		mu.Unlock()
		time.Sleep(2 * time.Millisecond)
		runs.Add(1)
		mu.Lock()
		running[k] = false
		mu.Unlock()
	})
	defer s.close()

	keys := []jobKey{{kind: jobStatus, path: "a"}, {kind: jobStatus, path: "b"}}
	var wg sync.WaitGroup
	for i := range 200 {
		wg.Go(func() { <-s.request(keys[i%2]) })
	}
	wg.Wait()
	if overlap.Load() {
		t.Fatal("a key ran on two workers at once")
	}
	// Requests coalesce: far fewer runs than requests, but at least one per key.
	if n := runs.Load(); n < 2 || n >= 200 {
		t.Fatalf("runs = %d, want coalescing", n)
	}
}

func TestSchedulerWaitSeesRunStartedAfterRequest(t *testing.T) {
	var version atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	first := true
	s := newScheduler(context.Background(), 1, func(context.Context, jobKey) {
		if first {
			first = false
			close(started)
			<-release
		}
		version.Add(1)
	})
	defer s.close()
	k := jobKey{kind: jobReconcile, projectID: "r"}
	s.request(k)
	<-started
	// The first run is in flight; a new waiter must get a rerun, not the old run.
	done := make(chan error, 1)
	go func() { done <- s.wait(context.Background(), k) }()
	time.Sleep(10 * time.Millisecond)
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if v := version.Load(); v != 2 {
		t.Fatalf("runs = %d, want 2 (rerun after in-flight run)", v)
	}
}

func TestSchedulerCloseReleasesWaiters(t *testing.T) {
	block := make(chan struct{})
	s := newScheduler(context.Background(), 1, func(context.Context, jobKey) { <-block })
	s.request(jobKey{kind: jobStatus, path: "busy"})
	ch := s.request(jobKey{kind: jobStatus, path: "queued"})
	go func() {
		time.Sleep(10 * time.Millisecond)
		close(block)
	}()
	s.close()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("waiter not released by close")
	}
	select {
	case <-s.request(jobKey{kind: jobStatus, path: "after"}):
	default:
		t.Fatal("request after close should be released immediately")
	}
}

func TestSchedulerPriorityAndPromotion(t *testing.T) {
	gate := make(chan struct{})
	started := make(chan struct{})
	var (
		mu    sync.Mutex
		order []string
	)
	s := newScheduler(context.Background(), 1, func(_ context.Context, k jobKey) {
		if k.path == "blocker" {
			close(started)
			<-gate
			return
		}
		mu.Lock()
		order = append(order, k.path)
		mu.Unlock()
	})
	defer s.close()

	s.request(jobKey{kind: jobStatus, path: "blocker"})
	<-started

	// Queue three low-priority jobs, then promote "low-2" to prioHigh and add "hi-new".
	s.request(jobKey{kind: jobStatus, path: "low-1"})
	s.request(jobKey{kind: jobStatus, path: "low-2"})
	s.request(jobKey{kind: jobStatus, path: "low-3"})
	chPromoted := s.requestHigh(jobKey{kind: jobStatus, path: "low-2"})
	chHi := s.requestHigh(jobKey{kind: jobStatus, path: "hi-new"})
	chLowLast := s.request(jobKey{kind: jobStatus, path: "low-3"})

	close(gate)
	<-chPromoted
	<-chHi
	<-chLowLast

	mu.Lock()
	defer mu.Unlock()
	want := []string{"low-2", "hi-new", "low-1", "low-3"}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}

func TestSchedulerRunningRerunPromotesPriority(t *testing.T) {
	gate := make(chan struct{})
	started := make(chan struct{})
	var (
		mu    sync.Mutex
		runs  int
		order []string
	)
	s := newScheduler(context.Background(), 1, func(_ context.Context, k jobKey) {
		mu.Lock()
		runs++
		n := runs
		if n == 1 {
			mu.Unlock()
			close(started)
			<-gate
			return
		}
		order = append(order, k.path)
		mu.Unlock()
	})
	defer s.close()

	running := jobKey{kind: jobStatus, path: "target"}
	s.request(running)
	<-started

	// Queue a low-priority job, then request a low rerun and promote it with prioHigh.
	chOther := s.request(jobKey{kind: jobStatus, path: "other-low"})
	s.request(running)
	chHi := s.requestHigh(running)

	close(gate)
	<-chHi
	<-chOther

	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "target" || order[1] != "other-low" {
		t.Fatalf("rerun order = %v, want [target other-low]", order)
	}
}

func TestDebouncerCancel(t *testing.T) {
	var fired atomic.Int32
	d := newDebouncer(30*time.Millisecond, func(jobKey) { fired.Add(1) })
	defer d.close()
	a, b := jobKey{kind: jobStatus, path: "a"}, jobKey{kind: jobStatus, path: "b"}
	d.trigger(a)
	d.trigger(b)
	d.cancel(a)
	d.cancel(jobKey{kind: jobStatus, path: "never armed"})
	time.Sleep(80 * time.Millisecond)
	if n := fired.Load(); n != 1 {
		t.Fatalf("fired %d times, want 1 (b only)", n)
	}
	// Cancelled and re-armed: the new timer fires once.
	d.trigger(a)
	d.cancel(a)
	d.trigger(a)
	time.Sleep(80 * time.Millisecond)
	if n := fired.Load(); n != 2 {
		t.Fatalf("fired %d times, want 2", n)
	}
}

func TestDebouncerCoalesces(t *testing.T) {
	var fired atomic.Int32
	d := newDebouncer(30*time.Millisecond, func(jobKey) { fired.Add(1) })
	k := jobKey{kind: jobStatus, path: "x"}
	for range 50 {
		d.trigger(k)
	}
	time.Sleep(80 * time.Millisecond)
	if n := fired.Load(); n != 1 {
		t.Fatalf("fired %d times, want 1", n)
	}
	d.trigger(k)
	d.close()
	time.Sleep(60 * time.Millisecond)
	if n := fired.Load(); n != 1 {
		t.Fatalf("fired after close: %d", n)
	}
}
