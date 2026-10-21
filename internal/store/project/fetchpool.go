package project

import (
	"context"
	"sync"
)

// fetchConcurrency is how many projects the fetch loop fetches at once. The loop used
// to fetch one project after another, so one unreachable remote (a VPN-only host, a
// blackholed network: 75 s to time out a connect) delayed every project after it
// (fuzz finding git 9).
const fetchConcurrency = 3

// fetchPool runs the fetch loop's fetches in the background, at most fetchConcurrency
// at a time and never two for one project.
type fetchPool struct {
	once    sync.Once
	sem     chan struct{}
	mu      sync.Mutex
	running map[string]bool
}

func (p *fetchPool) init() {
	p.once.Do(func() {
		p.sem = make(chan struct{}, fetchConcurrency)
		p.running = map[string]bool{}
	})
}

// claim marks id fetching; false when a fetch of id is queued or running.
func (p *fetchPool) claim(id string) bool {
	p.init()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running[id] {
		return false
	}
	p.running[id] = true
	return true
}

func (p *fetchPool) release(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.running, id)
}

// fetchAsync is the fetch loop's run: it starts fetch(id) in the background and
// returns, so the loop goes on to the next project. A project whose previous fetch
// has not finished is skipped this round.
func (g *Git) fetchAsync(ctx context.Context, id string) {
	if !g.fetches.claim(id) {
		g.log.Debug("fetch still running; skipped this round", "project", id)
		return
	}
	g.wg.Go(func() {
		defer g.fetches.release(id)
		select {
		case g.fetches.sem <- struct{}{}:
		case <-ctx.Done():
			return
		}
		defer func() { <-g.fetches.sem }()
		g.fetch(ctx, id)
	})
}
