package repo

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
	k := jobKey{kind: jobReconcile, repoID: "r"}
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
