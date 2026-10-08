package settings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// DefaultDebounce coalesces the burst of fs events one save produces.
const DefaultDebounce = 100 * time.Millisecond

// ErrFileInvalid is returned by Update while the file has a syntax error: rewriting it
// would throw away the user's unparsed edits.
var ErrFileInvalid = errors.New("settings file has a syntax error")

// ValidationError rejects an Update. Issues has one entry per rejected key.
type ValidationError struct {
	Issues []Issue
}

func (e *ValidationError) Error() string {
	msgs := make([]string, len(e.Issues))
	for i, is := range e.Issues {
		msgs[i] = is.Key + ": " + is.Message
	}
	return "invalid settings: " + strings.Join(msgs, "; ")
}

// Service is the settings store as the API and commands see it. *Store implements it;
// settingstest.Fake is the in-memory fake.
type Service interface {
	// Snapshot returns the current snapshot. Never nil.
	Snapshot() *Snapshot
	// Fields returns every field in display order, including one keybinding field per
	// command once SetCommands has been called.
	Fields() []Field
	// Update applies a partial change (key -> string-encoded value; "" resets the key).
	// It fails with *ValidationError or ErrFileInvalid and then changes nothing.
	Update(ctx context.Context, partial map[string]string) (*Snapshot, error)
	// Watch returns the current snapshot followed by every change until ctx ends.
	Watch(ctx context.Context) <-chan *Snapshot
}

// Options configures Open.
type Options struct {
	// Path is the settings file. Required.
	Path string
	// Bus receives Changed. Default: a private bus.
	Bus *bus.Bus
	Log *slog.Logger
	// Debounce coalesces file events. Default DefaultDebounce.
	Debounce time.Duration
}

// Store is the file-backed settings store. Methods are safe for concurrent use.
type Store struct {
	opts Options
	log  *slog.Logger

	// mu guards everything below and serializes recompute+publish, so snapshots are
	// published in revision order and hooks see every change in order.
	mu      sync.Mutex
	raw     map[string]string
	cmds    []CommandInfo
	loadErr string
	startup map[string]string // Restart fields' values at Open
	hooks   []func(*Snapshot)

	snap atomic.Pointer[Snapshot]

	watcher *fsnotify.Watcher
	stop    chan struct{}
	wg      sync.WaitGroup
}

var _ Service = (*Store)(nil)

// Open loads the settings file (creating it with every default commented out if it
// does not exist) and starts watching it. A file that does not parse is reported in
// Snapshot.LoadError and the defaults apply; Open fails only on I/O errors. Close stops
// the watcher.
func Open(ctx context.Context, opts Options) (*Store, error) {
	if opts.Path == "" {
		return nil, errors.New("settings: Options.Path is required")
	}
	if opts.Bus == nil {
		opts.Bus = bus.New()
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Debounce <= 0 {
		opts.Debounce = DefaultDebounce
	}
	s := &Store{opts: opts, log: opts.Log, raw: map[string]string{}, stop: make(chan struct{})}

	data, err := os.ReadFile(opts.Path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := writeAtomic(opts.Path, render(nil)); err != nil {
			return nil, err
		}
	case err != nil:
		return nil, fmt.Errorf("settings: read %s: %w", opts.Path, err)
	default:
		if raw, err := decode(data); err != nil {
			s.loadErr = err.Error()
			s.log.Warn("settings file does not parse; using defaults", "path", opts.Path, "err", err)
		} else {
			s.raw = raw
		}
	}
	r := resolve(s.raw, nil)
	s.startup = map[string]string{}
	for _, f := range staticFields {
		if f.Restart {
			s.startup[f.Key] = r.values[f.Key]
		}
	}
	s.snap.Store(s.build(r, 1))
	for _, is := range r.issues {
		s.log.Warn("settings: value ignored", "key", is.Key, "reason", is.Message)
	}

	if err := s.startWatcher(ctx); err != nil {
		// Live reload is a convenience; the store works without it.
		s.log.Warn("settings: not watching the file for changes", "err", err)
	}
	return s, nil
}

// Close stops the watcher.
func (s *Store) Close() error {
	select {
	case <-s.stop:
		return nil
	default:
	}
	close(s.stop)
	var err error
	if s.watcher != nil {
		err = s.watcher.Close()
	}
	s.wg.Wait()
	return err
}

// Path is the settings file.
func (s *Store) Path() string { return s.opts.Path }

// Snapshot returns the current snapshot.
func (s *Store) Snapshot() *Snapshot { return s.snap.Load() }

// Settings returns the current typed settings.
func (s *Store) Settings() Settings { return s.Snapshot().Settings }

// Fields returns every field in display order.
func (s *Store) Fields() []Field {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append(slices.Clone(staticFields), keybindingFields(s.cmds)...)
}

// SetCommands tells the store which commands exist, which enables the keybinding
// fields and full validation of keybinding overrides (unknown commands, collisions).
func (s *Store) SetCommands(cmds []CommandInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cmds = slices.Clone(cmds)
	if s.cmds == nil {
		s.cmds = []CommandInfo{}
	}
	r := resolve(s.raw, s.cmds)
	for _, is := range r.issues {
		if isKeybindingKey(is.Key) {
			s.log.Warn("settings: keybinding ignored", "key", is.Key, "reason", is.Message)
		}
	}
	s.publishLocked(r)
}

// OnChange registers fn to run synchronously on every published change, before the
// bus event, and runs it once now with the current snapshot. Consumers that must be up
// to date by the time clients see the event (the command registry's keybindings) use
// it. fn must not call Update or SetCommands.
func (s *Store) OnChange(fn func(*Snapshot)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks = append(s.hooks, fn)
	fn(s.Snapshot())
}

// Update applies a partial change, validates the result, writes the file atomically,
// and publishes. Unknown keys and invalid values are rejected with *ValidationError.
func (s *Store) Update(_ context.Context, partial map[string]string) (*Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != "" {
		return nil, fmt.Errorf("%w: %s; fix %s by hand first", ErrFileInvalid, s.loadErr, s.opts.Path)
	}
	known := map[string]bool{}
	for _, f := range append(slices.Clone(staticFields), keybindingFields(s.cmds)...) {
		known[f.Key] = true
	}
	var bad []Issue
	next := maps.Clone(s.raw)
	for k, v := range partial {
		if !known[k] && !(s.cmds == nil && isKeybindingKey(k)) {
			bad = append(bad, Issue{k, "unknown setting"})
			continue
		}
		if v == "" {
			delete(next, k)
		} else {
			next[k] = v
		}
	}
	r := resolve(next, s.cmds)
	for _, is := range r.issues {
		if _, ok := partial[is.Key]; ok {
			bad = append(bad, is)
		}
	}
	if len(bad) > 0 {
		slices.SortFunc(bad, func(a, b Issue) int { return strings.Compare(a.Key, b.Key) })
		return nil, &ValidationError{Issues: dedupeIssues(bad)}
	}
	if err := writeAtomic(s.opts.Path, render(r.accepted)); err != nil {
		return nil, err
	}
	// The file now holds exactly the accepted values; keeping raw equal to it makes the
	// watcher's reload of our own write a no-op.
	s.raw = r.accepted
	s.publishLocked(resolve(s.raw, s.cmds))
	return s.Snapshot(), nil
}

// reload re-reads the file after an fs event.
func (s *Store) reload() {
	data, err := os.ReadFile(s.opts.Path)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.raw, s.loadErr = map[string]string{}, ""
	case err != nil:
		s.log.Warn("settings: reload failed", "err", err)
		return
	default:
		raw, derr := decode(data)
		if derr != nil {
			if s.loadErr != derr.Error() {
				s.log.Warn("settings file does not parse; keeping the previous values", "err", derr)
			}
			s.loadErr = derr.Error()
		} else {
			s.raw, s.loadErr = raw, ""
		}
	}
	s.publishLocked(resolve(s.raw, s.cmds))
}

// publishLocked publishes r if it changes anything observable. s.mu must be held.
func (s *Store) publishLocked(r resolved) {
	cur := s.Snapshot()
	next := s.build(r, cur.Revision+1)
	if sameState(cur, next) {
		return
	}
	s.snap.Store(next)
	for _, fn := range s.hooks {
		fn(next)
	}
	bus.Publish(s.opts.Bus, Changed{Snapshot: next})
}

func (s *Store) build(r resolved, rev uint64) *Snapshot {
	var pending []string
	for _, f := range staticFields {
		if f.Restart && r.values[f.Key] != s.startup[f.Key] {
			pending = append(pending, f.Key)
		}
	}
	return &Snapshot{
		Settings: r.settings, Values: r.values, Path: s.opts.Path, Revision: rev,
		LoadError: s.loadErr, Issues: r.issues, RestartPending: pending,
	}
}

// startWatcher watches the file's directory (an atomic save replaces the file, which
// would end a watch on the file itself) and reloads after a quiet period.
func (s *Store) startWatcher(ctx context.Context) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(filepath.Dir(s.opts.Path)); err != nil {
		_ = w.Close()
		return err
	}
	s.watcher = w
	name := filepath.Base(s.opts.Path)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		var (
			timer *time.Timer
			fire  <-chan time.Time
		)
		for {
			select {
			case <-ctx.Done():
				return
			case <-s.stop:
				return
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if filepath.Base(ev.Name) != name {
					continue
				}
				if timer == nil {
					timer = time.NewTimer(s.opts.Debounce)
				} else {
					timer.Reset(s.opts.Debounce)
				}
				fire = timer.C
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				s.log.Warn("settings: watcher error", "err", err)
			case <-fire:
				fire = nil
				s.reload()
			}
		}
	}()
	return nil
}

// Watch returns the current snapshot followed by every change until ctx ends. If the
// consumer falls behind, intermediate snapshots are skipped, never the latest.
func (s *Store) Watch(ctx context.Context) <-chan *Snapshot {
	sub := bus.Subscribe[Changed](s.opts.Bus, 16)
	out := make(chan *Snapshot, 1)
	out <- s.Snapshot()
	go func() {
		defer close(out)
		defer sub.Close()
		dropped := uint64(0)
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-sub.C():
				if !ok {
					return
				}
				snap := ev.Snapshot
				if d := sub.Dropped(); d != dropped {
					dropped, snap = d, s.Snapshot()
				}
				select {
				case out <- snap:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}
