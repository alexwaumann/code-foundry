// Package updatetest provides fakes for the updater's release source and installer, so
// tests drive the real update.Store state machine without gh or the network.
package updatetest

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// Source is a fake update.Source. Set the stable answer with Set and the tip answer
// with SetTip; without SetTip, tip answers like stable.
type Source struct {
	mu       sync.Mutex
	tag      string
	tip      string
	hasTip   bool
	err      error
	channels []update.Channel
	gate     chan struct{} // set by Block
	entered  chan struct{} // a call reached the gate
}

var _ update.Source = (*Source)(nil)

// NewSource returns a source that reports tag.
func NewSource(tag string) *Source { return &Source{tag: tag} }

// Set changes what Latest returns for stable (and for tip unless SetTip was called).
func (s *Source) Set(tag string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tag, s.err = tag, err
}

// SetTip changes what Latest returns for the tip channel.
func (s *Source) SetTip(tag string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tip, s.hasTip = tag, true
}

// Calls returns how many times Latest was called.
func (s *Source) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.channels)
}

// Channels returns the channel of every Latest call, in order.
func (s *Source) Channels() []update.Channel {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]update.Channel(nil), s.channels...)
}

// Block makes Latest wait (after recording the call) until Unblock.
func (s *Source) Block() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gate = make(chan struct{})
	s.entered = make(chan struct{}, 16)
}

// Unblock releases every waiting and future Latest.
func (s *Source) Unblock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gate != nil {
		close(s.gate)
		s.gate = nil
	}
}

// WaitBlocked waits until a Latest call is held by Block.
func (s *Source) WaitBlocked(t testing.TB) {
	t.Helper()
	s.mu.Lock()
	entered := s.entered
	s.mu.Unlock()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no Latest call reached the block")
	}
}

// Latest implements update.Source.
func (s *Source) Latest(ctx context.Context, ch update.Channel) (string, error) {
	s.mu.Lock()
	s.channels = append(s.channels, ch)
	if gate := s.gate; gate != nil {
		s.entered <- struct{}{}
		s.mu.Unlock()
		select {
		case <-gate:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		s.mu.Lock()
	}
	defer s.mu.Unlock()
	if ch == update.ChannelTip && s.hasTip {
		return s.tip, s.err
	}
	return s.tag, s.err
}

// NotesURL implements update.Source.
func (s *Source) NotesURL(tag string) string { return "https://example.test/releases/" + tag }

// Installer is a fake update.Installer over two fake directories: the install on disk
// (OnDisk, may be nil) and the staged download (Staged). Download reports the Progress
// lines, blocks until Release (when Hold is set), then returns DownloadErr or stages the
// tag. Install returns InstallErr, fails when the tag is not staged (like
// install.sh --apply-staged), else moves the staged version onto disk. Point
// update.Options.StagedVersion at Staged().Version.
type Installer struct {
	Progress []string
	// DownloadErr and InstallErr fail the respective step.
	DownloadErr, InstallErr error
	// Hold makes Download wait for Release.
	Hold bool
	// DownloadAs is the version a successful download stages; the tag when empty.
	DownloadAs string
	// InstallAs is the version a successful install leaves on disk; the staged version
	// when empty.
	InstallAs string

	mu        sync.Mutex
	downloads []string
	installs  []string
	release   chan struct{}
	onDisk    *OnDisk
	staged    *OnDisk
}

var _ update.Installer = (*Installer)(nil)

// NewInstaller returns an installer that installs into disk (may be nil) and stages into
// a fresh Staged directory (nothing staged).
func NewInstaller(disk *OnDisk) *Installer {
	return &Installer{release: make(chan struct{}), onDisk: disk, staged: NewOnDisk("")}
}

// Staged is the fake staged download, for update.Options.StagedVersion.
func (i *Installer) Staged() *OnDisk { return i.staged }

// Release lets a held Download finish.
func (i *Installer) Release() { close(i.release) }

// Calls returns the tags Download was called with.
func (i *Installer) Calls() []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]string(nil), i.downloads...)
}

// Installs returns the tags Install was called with.
func (i *Installer) Installs() []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]string(nil), i.installs...)
}

// Download implements update.Installer.
func (i *Installer) Download(ctx context.Context, tag string, progress func(string)) error {
	i.mu.Lock()
	i.downloads = append(i.downloads, tag)
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
	if i.DownloadErr != nil {
		i.staged.Set("") // install.sh removes the stage on failure
		return i.DownloadErr
	}
	v := tag
	if i.DownloadAs != "" {
		v = i.DownloadAs
	}
	i.staged.Set(v)
	return nil
}

// Install implements update.Installer.
func (i *Installer) Install(_ context.Context, tag string) error {
	i.mu.Lock()
	i.installs = append(i.installs, tag)
	i.mu.Unlock()
	if i.InstallErr != nil {
		return i.InstallErr
	}
	staged, _ := i.staged.Version()
	if staged != tag {
		return fmt.Errorf("installer: no staged download of %s (staged %q)", tag, staged)
	}
	if i.onDisk != nil {
		v := staged
		if i.InstallAs != "" {
			v = i.InstallAs
		}
		i.onDisk.Set(v)
	}
	i.staged.Set("")
	return nil
}

// OnDisk is a fake version file, for update.Options.InstalledVersion and
// update.Options.StagedVersion.
type OnDisk struct {
	mu sync.Mutex
	v  string
}

// NewOnDisk returns an installed version starting at v.
func NewOnDisk(v string) *OnDisk { return &OnDisk{v: v} }

// Set changes the version on disk.
func (d *OnDisk) Set(v string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.v = v
}

// Version implements update.Options.InstalledVersion and StagedVersion.
func (d *OnDisk) Version() (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.v, nil
}
