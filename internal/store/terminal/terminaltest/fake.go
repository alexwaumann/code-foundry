// Package terminaltest provides an in-memory terminal.Store for tests of code that
// consumes terminals (API handlers, the session store). No PTYs or emulators are
// involved: tests drive output, titles, and exits explicitly.
package terminaltest

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/terminal"
)

// Fake implements terminal.Store. The snapshot of a fake terminal is simply all output
// emitted so far.
type Fake struct {
	bus *bus.Bus
	// Now is the clock used for StartedAt/ExitedAt.
	Now func() time.Time
	// CreateErr, if set, is returned by Create.
	CreateErr error

	mu    sync.Mutex
	next  int
	terms map[string]*fakeTerm
}

type fakeTerm struct {
	info    terminal.Terminal
	spec    terminal.Spec
	output  []byte
	written []byte
	subs    map[chan terminal.AttachEvent]struct{}
}

var _ terminal.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, Now: time.Now, terms: map[string]*fakeTerm{}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Create records spec and returns a running terminal with id "fake-N".
func (f *Fake) Create(_ context.Context, spec terminal.Spec) (terminal.Terminal, error) {
	if f.CreateErr != nil {
		return terminal.Terminal{}, f.CreateErr
	}
	if len(spec.Argv) == 0 {
		return terminal.Terminal{}, fmt.Errorf("%w: empty argv", terminal.ErrInvalidSpec)
	}
	cols, rows := spec.Cols, spec.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	f.mu.Lock()
	f.next++
	t := &fakeTerm{
		info: terminal.Terminal{
			ID:        fmt.Sprintf("fake-%d", f.next),
			Argv:      slices.Clone(spec.Argv),
			Cwd:       spec.Cwd,
			Pid:       10000 + f.next,
			Cols:      cols,
			Rows:      rows,
			State:     terminal.StateRunning,
			StartedAt: f.Now(),
			Labels:    maps.Clone(spec.Labels),
		},
		spec: spec,
		subs: map[chan terminal.AttachEvent]struct{}{},
	}
	f.terms[t.info.ID] = t
	info := t.info
	f.mu.Unlock()
	bus.Publish(f.bus, terminal.TerminalUpdated{Terminal: info})
	return info, nil
}

func (f *Fake) get(id string) (*fakeTerm, error) {
	t, ok := f.terms[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", terminal.ErrNotFound, id)
	}
	return t, nil
}

// List returns all terminals in creation order.
func (f *Fake) List(context.Context) []terminal.Terminal {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]terminal.Terminal, 0, len(f.terms))
	for _, t := range f.terms {
		out = append(out, t.info)
	}
	slices.SortFunc(out, func(a, b terminal.Terminal) int { return a.Pid - b.Pid })
	return out
}

// Get returns one terminal.
func (f *Fake) Get(_ context.Context, id string) (terminal.Terminal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, err := f.get(id)
	if err != nil {
		return terminal.Terminal{}, err
	}
	return t.info, nil
}

// Write records input; see Written.
func (f *Fake) Write(_ context.Context, id string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, err := f.get(id)
	if err != nil {
		return err
	}
	if t.info.State == terminal.StateExited {
		return terminal.ErrExited
	}
	t.written = append(t.written, data...)
	return nil
}

// Resize updates the size and notifies subscribers.
func (f *Fake) Resize(_ context.Context, id string, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return fmt.Errorf("%w: size %dx%d", terminal.ErrInvalidSpec, cols, rows)
	}
	return f.update(id, func(t *fakeTerm) []terminal.AttachEvent {
		t.info.Cols, t.info.Rows = cols, rows
		return []terminal.AttachEvent{{Resized: &terminal.Size{Cols: cols, Rows: rows}}}
	})
}

// Kill exits a running terminal with code 129 (SIGHUP).
func (f *Fake) Kill(_ context.Context, id string) error {
	f.mu.Lock()
	t, err := f.get(id)
	running := err == nil && t.info.State == terminal.StateRunning
	f.mu.Unlock()
	if err != nil || !running {
		return err
	}
	return f.Exit(id, 128+1)
}

// Remove forgets an exited terminal.
func (f *Fake) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	t, err := f.get(id)
	if err != nil {
		f.mu.Unlock()
		return err
	}
	if t.info.State == terminal.StateRunning {
		f.mu.Unlock()
		return terminal.ErrRunning
	}
	for ch := range t.subs {
		close(ch)
	}
	t.subs = map[chan terminal.AttachEvent]struct{}{}
	delete(f.terms, id)
	f.mu.Unlock()
	bus.Publish(f.bus, terminal.TerminalRemoved{ID: id})
	return nil
}

// Attach sends a snapshot (all output so far) and then live events. Channels hold 1024
// events; like the real store, a subscriber that falls that far behind is dropped.
func (f *Fake) Attach(ctx context.Context, id string) (<-chan terminal.AttachEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, err := f.get(id)
	if err != nil {
		return nil, err
	}
	ch := make(chan terminal.AttachEvent, 1024)
	ch <- terminal.AttachEvent{Snapshot: &terminal.Snapshot{
		Data: slices.Clone(t.output), Cols: t.info.Cols, Rows: t.info.Rows, AltScreen: t.info.AltScreen,
	}}
	if t.info.State == terminal.StateExited {
		ch <- terminal.AttachEvent{Exited: &terminal.Exit{Code: t.info.ExitCode}}
	}
	t.subs[ch] = struct{}{}
	go func() {
		<-ctx.Done()
		f.mu.Lock()
		defer f.mu.Unlock()
		if _, ok := t.subs[ch]; ok {
			delete(t.subs, ch)
			close(ch)
		}
	}()
	return ch, nil
}

// Watch merges bus events like the real store.
func (f *Fake) Watch(ctx context.Context) (<-chan terminal.Event, error) {
	return terminal.WatchBus(ctx, f.bus), nil
}

// ---- test controls ----

// Emit appends program output and forwards it to attached subscribers.
func (f *Fake) Emit(id string, data []byte) error {
	return f.apply(id, false, func(t *fakeTerm) []terminal.AttachEvent {
		t.output = append(t.output, data...)
		return []terminal.AttachEvent{{Output: slices.Clone(data)}}
	})
}

// SetTitle sets the title and publishes an update.
func (f *Fake) SetTitle(id, title string) error {
	return f.update(id, func(t *fakeTerm) []terminal.AttachEvent { t.info.Title = title; return nil })
}

// SetAltScreen sets the alt-screen flag and publishes an update.
func (f *Fake) SetAltScreen(id string, alt bool) error {
	return f.update(id, func(t *fakeTerm) []terminal.AttachEvent { t.info.AltScreen = alt; return nil })
}

// Exit marks a terminal exited with code.
func (f *Fake) Exit(id string, code int) error {
	return f.update(id, func(t *fakeTerm) []terminal.AttachEvent {
		t.info.State = terminal.StateExited
		t.info.ExitCode = code
		t.info.ExitedAt = f.Now()
		return []terminal.AttachEvent{{Exited: &terminal.Exit{Code: code}}}
	})
}

// Written returns all input written to a terminal.
func (f *Fake) Written(id string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if t, ok := f.terms[id]; ok {
		return slices.Clone(t.written)
	}
	return nil
}

// Spec returns the spec a terminal was created with.
func (f *Fake) Spec(id string) (terminal.Spec, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.terms[id]
	if !ok {
		return terminal.Spec{}, false
	}
	return t.spec, true
}

func (f *Fake) update(id string, fn func(*fakeTerm) []terminal.AttachEvent) error {
	return f.apply(id, true, fn)
}

// apply runs fn under the lock, delivers its events like the real store (a subscriber
// whose buffer is nearly full gets Dropped and is closed), and optionally publishes.
func (f *Fake) apply(id string, publish bool, fn func(*fakeTerm) []terminal.AttachEvent) error {
	f.mu.Lock()
	t, err := f.get(id)
	if err != nil {
		f.mu.Unlock()
		return err
	}
	for _, ev := range fn(t) {
		for ch := range t.subs {
			if len(ch) >= cap(ch)-1 {
				ch <- terminal.AttachEvent{Dropped: true}
				close(ch)
				delete(t.subs, ch)
				continue
			}
			ch <- ev
		}
	}
	info := t.info
	f.mu.Unlock()
	if publish {
		bus.Publish(f.bus, terminal.TerminalUpdated{Terminal: info})
	}
	return nil
}
