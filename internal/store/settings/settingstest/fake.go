// Package settingstest provides a settings.Service for tests of consumers (API
// handlers, commands): a real Store on a test directory that records Update calls, so
// validation never drifts from production.
package settingstest

import (
	"context"
	"log/slog"
	"maps"
	"path/filepath"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// Fake is a settings.Service backed by a real Store in a test directory.
type Fake struct {
	mu    sync.Mutex
	store *settings.Store
	// Updates records every partial passed to Update, accepted or not.
	Updates []map[string]string
}

var _ settings.Service = (*Fake)(nil)

// New returns a Fake whose file lives in dir (use t.TempDir()). b receives
// settings.Changed; nil uses a private bus.
func New(ctx context.Context, dir string, b *bus.Bus, cmds []settings.CommandInfo) (*Fake, error) {
	s, err := settings.Open(ctx, settings.Options{
		Path: filepath.Join(dir, settings.FileName), Bus: b, Log: slog.New(slog.DiscardHandler),
	})
	if err != nil {
		return nil, err
	}
	if cmds != nil {
		s.SetCommands(cmds)
	}
	return &Fake{store: s}, nil
}

// Close stops the underlying store.
func (f *Fake) Close() error { return f.store.Close() }

// Snapshot implements settings.Service.
func (f *Fake) Snapshot() *settings.Snapshot { return f.store.Snapshot() }

// Fields implements settings.Service.
func (f *Fake) Fields() []settings.Field { return f.store.Fields() }

// Update implements settings.Service and records the call.
func (f *Fake) Update(ctx context.Context, partial map[string]string) (*settings.Snapshot, error) {
	f.mu.Lock()
	f.Updates = append(f.Updates, maps.Clone(partial))
	f.mu.Unlock()
	return f.store.Update(ctx, partial)
}

// Watch returns the store's Watch channel.
func (f *Fake) Watch(ctx context.Context) <-chan *settings.Snapshot { return f.store.Watch(ctx) }
