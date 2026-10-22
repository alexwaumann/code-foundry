package memory

import (
	"cmp"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// The directory watch (docs/notes/memory-fixes-2.md): a hand edit, a file deleted in
// Finder or another program writing the directory reaches the Settings page within a
// moment, not with the next read. Like the settings store's watch of settings.toml it
// is fsnotify (kqueue here: no cgo, a descriptor per file, at most 40 entries and the
// index). The store's own writes are seen too; their read changes nothing, so nothing
// is published twice.
const (
	// watchDebounce coalesces the events one write or one save produces.
	watchDebounce = 100 * time.Millisecond
	// watchRetry is how often a directory that is not there yet (made on the first
	// write) or went away is looked for again.
	watchRetry = 2 * time.Second
)

// Watch follows the memory directory until ctx is done: every change to a file in it
// reads the memory again (Load), which publishes the change. A directory that does not
// exist yet is watched once it appears; one removed reads as empty and is watched again
// when it comes back. It returns at once; the work happens in its own goroutine.
func (s *Store) Watch(ctx context.Context) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		s.log.Warn("memory: not watching the directory; a hand edit shows with the next read", "dir", s.opts.Dir, "err", err)
		return
	}
	go s.watch(ctx, w)
}

func (s *Store) watch(ctx context.Context, w *fsnotify.Watcher) {
	defer func() { _ = w.Close() }()
	dir := filepath.Clean(s.opts.Dir)
	watching := false
	add := func() {
		if watching {
			return
		}
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				s.log.Debug("memory: directory not watchable", "dir", dir, "err", err)
			}
			return
		}
		if err := w.Add(dir); err != nil {
			s.log.Warn("memory: not watching the directory", "dir", dir, "err", err)
			return
		}
		watching = true
		s.log.Debug("memory: watching the directory", "dir", dir)
		s.Load() // anything made before the watch began
	}
	add()
	retry := time.NewTicker(cmp.Or(s.opts.WatchRetry, watchRetry))
	defer retry.Stop()
	var (
		timer *time.Timer
		fire  <-chan time.Time
	)
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-retry.C:
			add()
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			name := filepath.Clean(ev.Name)
			if name == dir {
				if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
					_ = w.Remove(dir)
					watching = false // looked for again on the next retry
				}
			} else if !relevant(filepath.Base(name)) {
				continue
			}
			if timer == nil {
				timer = time.NewTimer(watchDebounce)
			} else {
				timer.Reset(watchDebounce)
			}
			fire = timer.C
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			s.log.Warn("memory: watcher error", "dir", dir, "err", err)
		case <-fire:
			fire = nil
			s.Load()
		}
	}
}

// relevant reports a file whose change can change the memory: an entry file, not the
// index (never read) or a write's temporary dot file.
func relevant(name string) bool {
	return !strings.HasPrefix(name, ".") && strings.HasSuffix(strings.ToLower(name), ".md") && !strings.EqualFold(name, IndexFile)
}
