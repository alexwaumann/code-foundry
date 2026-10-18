package plugintest

import (
	"context"
	"fmt"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// Surfaces is an in-memory plugin.Surfaces for API tests: availability from Available,
// and each WatchSurface streams what the test sends with Push.
type Surfaces struct {
	mu sync.Mutex
	// Available maps "<plugin>/<surface>" to whether it is available (any context);
	// missing is unavailable with Why.
	Available map[string]bool
	Why       string
	// Unknown marks "<plugin>/<surface>" unavailable for now (a fact not known yet).
	Unknown map[string]bool
	// Elements is what SurfaceElements returns.
	Elements []plugin.SurfaceElement
	// ActErr, when set, is Act's error.
	ActErr  error
	acts    []plugin.ActRequest
	watches []chan plugin.SurfaceUpdate
	refs    []plugin.SurfaceRef
}

var _ plugin.Surfaces = (*Surfaces)(nil)

// NewSurfaces returns an empty fake.
func NewSurfaces() *Surfaces { return &Surfaces{Available: map[string]bool{}} }

// SurfaceAvailable implements plugin.Surfaces.
func (s *Surfaces) SurfaceAvailable(p, surface string, _ command.Context) plugin.Availability {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Available[p+"/"+surface] {
		return plugin.Availability{Available: true}
	}
	return plugin.Availability{Unknown: s.Unknown[p+"/"+surface], Reason: s.Why}
}

// WatchSurface implements plugin.Surfaces: the instance key is
// <plugin>/<surface>/thread:<thread id>; updates come from Push.
func (s *Surfaces) WatchSurface(ctx context.Context, ref plugin.SurfaceRef) (string, <-chan plugin.SurfaceUpdate, error) {
	s.mu.Lock()
	if !s.Available[ref.Plugin+"/"+ref.Surface] && ref.Instance == "" {
		s.mu.Unlock()
		return "", nil, fmt.Errorf("%w: %s", plugin.ErrFailedPrecondition, s.Why)
	}
	in := make(chan plugin.SurfaceUpdate, 16)
	s.watches = append(s.watches, in)
	s.refs = append(s.refs, ref)
	s.mu.Unlock()
	out := make(chan plugin.SurfaceUpdate)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case u := <-in:
				select {
				case out <- u:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	key := ref.Instance
	if key == "" {
		key = plugin.InstanceKey(ref.Plugin, ref.Surface, "thread:"+ref.Context.ActiveThreadID)
	}
	return key, out, nil
}

// Push sends u to every watch so far.
func (s *Surfaces) Push(u plugin.SurfaceUpdate) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, w := range s.watches {
		w <- u
	}
}

// Watches returns how many WatchSurface calls there were.
func (s *Surfaces) Watches() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.watches)
}

// Refs returns the WatchSurface refs.
func (s *Surfaces) Refs() []plugin.SurfaceRef {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]plugin.SurfaceRef(nil), s.refs...)
}

// SurfaceElements implements plugin.Surfaces.
func (s *Surfaces) SurfaceElements(string, uint64) []plugin.SurfaceElement {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Elements
}

// Act implements plugin.Surfaces: it records req and answers version req.Version (1 for
// 0) or ActErr.
func (s *Surfaces) Act(_ context.Context, req plugin.ActRequest) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.acts = append(s.acts, req)
	if s.ActErr != nil {
		return 0, s.ActErr
	}
	return max(req.Version, 1), nil
}

// Acts returns the recorded Act calls.
func (s *Surfaces) Acts() []plugin.ActRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]plugin.ActRequest(nil), s.acts...)
}
