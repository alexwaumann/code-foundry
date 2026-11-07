package browser

import (
	"context"
	"time"
)

// A page decides how often the events below arrive, and it can make thousands a second: document.open
// in a loop made 74,000 goroutines in 15 s when each event started its own work. So what an event
// needs done goes on its target's queue, and one goroutine per target works through it at a set pace.
// Asking twice before it gets there is asking once.

// job is a piece of follow-up work on a target.
type job uint8

const (
	jobHistory job = 1 << iota // read back, forward and the title
	jobCast                    // start the frames again after a navigation
	jobShot                    // send the page as it now is
	jobOrigin                  // ask a page Chrome did not name who it is
	jobSelect                  // read what the user's press opened
)

// paced are the jobs an event asks for, which a page can ask for at will. A select is the user's.
const paced = jobHistory | jobCast | jobShot | jobOrigin

const (
	// jobGap is the least time between two rounds of paced work on one target.
	jobGap = 100 * time.Millisecond
	// historyShare keeps reading a page's history to a tenth of the time: a history of 2 MB
	// addresses is 100 MB that Chrome's main thread has to write out, and every surface waits.
	historyShare = 10
	maxJobGap    = 10 * time.Second
)

// workQueue is a target's queue. Its fields need Store.mu.
type workQueue struct {
	jobs    job
	running bool
}

// schedule asks for work on t, and starts its goroutine if there is none. Needs Store.mu.
func (s *Store) schedule(in *instance, t *target, j job) {
	t.queue.jobs |= j
	if !t.queue.running {
		t.queue.running = true
		go s.work(in, t)
	}
}

// work is a target's one goroutine, until its queue is empty.
func (s *Store) work(in *instance, t *target) {
	ctx := context.Background()
	for {
		s.mu.Lock()
		jobs := t.queue.jobs
		t.queue.jobs = 0
		if jobs == 0 || in.targets[t.id] != t {
			t.queue.running = false
			s.mu.Unlock()
			return
		}
		shown := t.casting && t.surface.top() == t
		w, h := t.surface.w, t.surface.h
		s.mu.Unlock()
		if jobs&jobSelect != 0 {
			s.readSelect(ctx, in, t)
		}
		if jobs&jobOrigin != 0 {
			s.readOrigin(ctx, in, t)
		}
		if jobs&jobCast != 0 && shown {
			if err := s.startCast(ctx, in, t); err != nil {
				s.log.Debug("screencast after a navigation", "err", err)
			}
		}
		if jobs&jobShot != 0 && shown {
			s.firstFrame(in, t, w, h)
		}
		gap := jobGap
		if jobs&jobHistory != 0 {
			started := time.Now()
			s.refreshHistory(in, t)
			gap = min(max(gap, time.Since(started)*historyShare), maxJobGap)
		}
		if jobs&paced != 0 {
			time.Sleep(gap)
		}
	}
}

// What a page may send through the pipe. The pipe is every surface's, and Chrome's main thread with
// it: past a few thousand events a second, or a few MB of addresses, Chrome queues faster than it
// writes and every surface stops answering. Nothing a page does through the pipe is throttled by
// Chrome itself, and no event can be refused, so a page that spends its allowance is closed.
const (
	// allowance is what a page may spend at once, and earnRate what it earns back a second. A page
	// loading sends a few hundred events of a few hundred bytes; a page in a flood goes through
	// this in about a second.
	allowance = 8 << 20
	earnRate  = 1 << 20
	// eventCost is what an event costs on top of its size, for floods of small ones.
	eventCost = 1 << 10
)

// eventBudget is a page's allowance. Its fields need Store.mu.
type eventBudget struct {
	spent   float64
	charged time.Time
	over    bool
}

// charge spends a page's allowance for one event of n bytes, and reports whether the page may go on.
// One that ran out is closed, and what it still sends goes unread. Needs Store.mu.
func (s *Store) charge(in *instance, t *target, n int) bool {
	b := &t.budget
	if b.over {
		return false
	}
	now := time.Now()
	if !b.charged.IsZero() {
		b.spent = max(0, b.spent-now.Sub(b.charged).Seconds()*earnRate)
	}
	b.charged = now
	b.spent += float64(n + eventCost)
	if b.spent <= allowance {
		return true
	}
	b.over = true
	sf := t.surface
	sf.state.Notice = floodWords(t.shownOrigin())
	sf.publish()
	s.log.Warn("closed a page that flooded the browser")
	go func() {
		if err := in.call(context.Background(), "", "Target.closeTarget", map[string]any{"targetId": t.id}, nil); err != nil {
			s.log.Debug("close a flooding page", "err", err)
		}
	}()
	return false
}

// floodWords says what became of a page.
func floodWords(origin string) string {
	if site := siteOf(origin); site != "" {
		return "A page on " + clipHost(site) + " was closed: it was flooding the browser."
	}
	return "That page was closed: it was flooding the browser."
}
