package gitops

import "sync"

// lanes runs jobs one at a time per key (a worktree path), in submission order, with at
// most `workers` jobs running across all keys. A lane exists while it has a running or
// waiting job; its goroutine drains it and then removes it.
type lanes struct {
	sem chan struct{}

	mu    sync.Mutex
	queue map[string][]func()
	wg    sync.WaitGroup
}

func newLanes(workers int) *lanes {
	if workers <= 0 {
		workers = 1
	}
	return &lanes{sem: make(chan struct{}, workers), queue: map[string][]func(){}}
}

// submit queues job on key's lane. It reports whether the job has to wait behind an
// earlier job on the same key.
func (l *lanes) submit(key string, job func()) (waits bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	q, busy := l.queue[key]
	l.queue[key] = append(q, job)
	if busy {
		return true
	}
	l.wg.Go(func() { l.drain(key) })
	return false
}

func (l *lanes) drain(key string) {
	for {
		l.mu.Lock()
		q := l.queue[key]
		if len(q) == 0 {
			delete(l.queue, key)
			l.mu.Unlock()
			return
		}
		job := q[0]
		l.mu.Unlock()

		l.sem <- struct{}{}
		job()
		<-l.sem

		// Pop only after running, so the lane stays "busy" for submit while job runs.
		l.mu.Lock()
		l.queue[key] = l.queue[key][1:]
		l.mu.Unlock()
	}
}

// wait blocks until every lane has drained.
func (l *lanes) wait() { l.wg.Wait() }
