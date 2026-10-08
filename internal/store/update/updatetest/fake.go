// Package updatetest provides fakes for the updater's release source and installer, so
// tests drive the real update.Store state machine without gh or the network.
package updatetest

import (
	"context"
	"sync"

	"github.com/awaumann/code-foundry/internal/store/update"
)

// Source is a fake update.Source. Set Tag/Err with Set.
type Source struct {
	mu    sync.Mutex
	tag   string
	err   error
	calls int
}

var _ update.Source = (*Source)(nil)

// NewSource returns a source that reports tag.
func NewSource(tag string) *Source { return &Source{tag: tag} }

// Set changes what Latest returns.
func (s *Source) Set(tag string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tag, s.err = tag, err
}

// Calls returns how many times Latest was called.
func (s *Source) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// Latest implements update.Source.
func (s *Source) Latest(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.tag, s.err
}

// NotesURL implements update.Source.
func (s *Source) NotesURL(tag string) string { return "https://example.test/releases/" + tag }

// Installer is a fake update.Installer. Each Install reports the Progress lines, then
// blocks until Release is called (when Hold is set), then returns Err. On success it
// sets the shared OnDisk version, so the store's InstalledVersion sees the new bundle.
type Installer struct {
	Progress []string
	Err      error
	// Hold makes Install wait for Release.
	Hold bool
	// InstallAs is the version a successful install leaves on disk; the tag when empty.
	InstallAs string

	mu      sync.Mutex
	calls   []string
	release chan struct{}
	onDisk  *OnDisk
}

var _ update.Installer = (*Installer)(nil)

// NewInstaller returns an installer that records installs into disk (may be nil).
func NewInstaller(disk *OnDisk) *Installer {
	return &Installer{release: make(chan struct{}), onDisk: disk}
}

// Release lets a held Install finish.
func (i *Installer) Release() { close(i.release) }

// Calls returns the tags Install was called with.
func (i *Installer) Calls() []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]string(nil), i.calls...)
}

// Install implements update.Installer.
func (i *Installer) Install(ctx context.Context, tag string, progress func(string)) error {
	i.mu.Lock()
	i.calls = append(i.calls, tag)
	i.mu.Unlock()
	for _, l := range i.Progress {
		progress(l)
	}
	if i.Hold {
		select {
		case <-i.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if i.Err != nil {
		return i.Err
	}
	if i.onDisk != nil {
		v := tag
		if i.InstallAs != "" {
			v = i.InstallAs
		}
		i.onDisk.Set(v)
	}
	return nil
}

// OnDisk is a fake installed-bundle version for update.Options.InstalledVersion.
type OnDisk struct {
	mu sync.Mutex
	v  string
}

// NewOnDisk returns a bundle version starting at v.
func NewOnDisk(v string) *OnDisk { return &OnDisk{v: v} }

// Set changes the version on disk.
func (d *OnDisk) Set(v string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.v = v
}

// Version implements update.Options.InstalledVersion.
func (d *OnDisk) Version() (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.v, nil
}
