// Package usertheme is the user's own colour themes: one JSON file per theme in the
// themes directory (paths.Themes), in the curated catalog's format plus `from` and
// `created_by` (theme.File; docs/notes/user-themes.md). The theme.* commands write it
// through Store (Save, Duplicate, Delete); a file written or edited by hand is read the
// same way. A file that does not validate is listed in the snapshot's Issues with why,
// never deleted or rewritten.
//
// Every read leaves a Snapshot; one that differs from the last runs the OnChange hooks
// (the settings store, which validates appearance.theme_dark / theme_light against the
// themes) and is published on the bus as Changed. Watch reads again on every change to
// the directory, so a hand edit is published within a moment (watch.go). The store
// stores files and derives no colour: the GUI resolves a theme's slots.
package usertheme

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// Ext is a theme file's extension: <id>.json.
const Ext = ".json"

// MaxFiles bounds the files read from the directory; the rest are listed as issues.
const MaxFiles = 500

// Sentinel errors; use errors.Is. Validation problems wrap theme.ErrInvalid.
var (
	// ErrNotFound: no theme with that id (Delete: no user theme; Duplicate, Get: none
	// at all).
	ErrNotFound = errors.New("no such theme")
	// ErrCurated: the id is a curated theme's, which a user theme cannot replace, and
	// Delete cannot remove.
	ErrCurated = errors.New("curated theme")
)

// Issue is a file in the directory that is not a theme the app can use, and why.
type Issue struct {
	// File is its name in the directory ("ocean.json").
	File    string
	Message string
}

// Snapshot is the directory as last read. It is immutable once published.
type Snapshot struct {
	// Themes are the valid user themes, by name, then id.
	Themes []theme.File
	// Issues are the files that are not, by file name.
	Issues []Issue
	// Version grows by one per change in this daemon's lifetime.
	Version uint64
	set     theme.Set
}

// Set is the themes a setting can name: these and the catalog, and the user themes
// that went away while the daemon ran (or whose file no longer reads), for fallback.
func (s *Snapshot) Set() theme.Set { return s.set }

// Get returns the user theme with id.
func (s *Snapshot) Get(id string) (theme.File, bool) {
	i := slices.IndexFunc(s.Themes, func(f theme.File) bool { return f.ID == id })
	if i < 0 {
		return theme.File{}, false
	}
	return s.Themes[i].Clone(), true
}

// Changed is published on the bus after every change to the snapshot.
type Changed struct {
	Snapshot *Snapshot
}

// Options configures New.
type Options struct {
	// Dir is the themes directory, made on the first write. Required.
	Dir string
	// Bus receives Changed; nil publishes nothing.
	Bus *bus.Bus
	Log *slog.Logger
	// WatchRetry is how often Watch looks for a directory that is not there; default 2s.
	WatchRetry time.Duration
}

// Store reads and writes the themes directory. Methods are safe for concurrent use.
type Store struct {
	opts Options
	log  *slog.Logger

	// mu serialises reads and writes, so snapshots are built and published in order.
	mu    sync.Mutex
	hooks []func(*Snapshot)
	// gone is every user theme id seen in this daemon's lifetime that is not valid now,
	// with its from (theme.Set.Fallback).
	gone map[string]string
	snap atomic.Pointer[Snapshot]
}

// New returns a store with an empty snapshot; call Load to read the directory.
func New(opts Options) *Store {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	s := &Store{opts: opts, log: opts.Log, gone: map[string]string{}}
	s.snap.Store(&Snapshot{Themes: []theme.File{}, set: theme.NewSet(nil, nil)})
	return s
}

// Dir is the themes directory.
func (s *Store) Dir() string { return s.opts.Dir }

// Path is where the theme id lives (or would).
func (s *Store) Path(id string) string { return filepath.Join(s.opts.Dir, id+Ext) }

// Snapshot is the directory as last read, without reading it.
func (s *Store) Snapshot() *Snapshot { return s.snap.Load() }

// OnChange registers fn to run synchronously on every change, before the bus event,
// and runs it once now. A write (Save, Duplicate, Delete) returns after its hooks ran,
// so a setting can name the theme it saved at once. fn must not call back into the store.
func (s *Store) OnChange(fn func(*Snapshot)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks = append(s.hooks, fn)
	fn(s.Snapshot())
}

// Load reads the directory now, publishes what changed and returns the snapshot.
func (s *Store) Load() *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	return s.Snapshot()
}

// Get returns the theme id: a user theme (user true) or a curated one.
func (s *Store) Get(id string) (f theme.File, user bool, err error) {
	if f, ok := s.Snapshot().Get(id); ok {
		return f, true, nil
	}
	if f, ok := theme.Curated(id); ok {
		return f, false, nil
	}
	return theme.File{}, false, fmt.Errorf("%w %q", ErrNotFound, id)
}

// Saved is what a write did.
type Saved struct {
	File theme.File
	// Path is the file written.
	Path string
	// Replaced is true when a theme with the id was there before.
	Replaced bool
}

// Save validates f and writes it as <id>.json, replacing a user theme with the same id.
// A curated id is refused (ErrCurated).
func (s *Store) Save(f theme.File) (Saved, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(f)
}

func (s *Store) saveLocked(f theme.File) (Saved, error) {
	// Round trip through the file format, so what is saved is exactly what a read sees.
	f, err := theme.ParseFile(f.Marshal())
	if err != nil {
		return Saved{}, err
	}
	if theme.IsCurated(f.ID) {
		return Saved{}, fmt.Errorf("%w: %q is a curated theme's id; save under another id (theme duplicate %s makes a copy)", ErrCurated, f.ID, f.ID)
	}
	_, replaced := s.Snapshot().Get(f.ID)
	path := s.Path(f.ID)
	if !replaced {
		_, err := os.Lstat(path)
		replaced = err == nil // an invalid file with that name: overwritten too
	}
	if err := os.MkdirAll(s.opts.Dir, 0o700); err != nil {
		return Saved{}, fmt.Errorf("themes: %w", err)
	}
	if err := writeAtomic(path, f.Marshal()); err != nil {
		return Saved{}, err
	}
	s.log.Info("themes: saved", "id", f.ID, "replaced", replaced, "created_by", f.CreatedBy)
	s.loadLocked()
	return Saved{File: f, Path: path, Replaced: replaced}, nil
}

// Duplicate copies the theme id (user or curated) into a new user theme: id
// "<id>-copy", then "<id>-copy-2", ...; name the given one, else "<name> copy" (then
// "<name> copy 2", ...); from id; createdBy the thread that asked ("" for the user).
// Everything else (colours, overrides, pair, source) is the original's.
func (s *Store) Duplicate(id, name, createdBy string) (Saved, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	src, _, err := s.Get(id)
	if err != nil {
		return Saved{}, err
	}
	taken := func(c string) bool {
		if theme.IsCurated(c) {
			return true
		}
		if _, ok := s.Snapshot().Get(c); ok {
			return true
		}
		_, err := os.Lstat(s.Path(c))
		return err == nil
	}
	base := strings.TrimSuffix(id[:min(len(id), theme.MaxIDLen-len("-copy-99"))], "-") + "-copy"
	newID := base
	n := 1
	for ; taken(newID); n++ {
		newID = base + "-" + strconv.Itoa(n+1)
	}
	cp := src.Clone()
	cp.ID, cp.From, cp.CreatedBy = newID, src.ID, createdBy
	cp.Name = strings.TrimSpace(name)
	if cp.Name == "" {
		cp.Name = src.Name + " copy"
		if n > 1 {
			cp.Name += " " + strconv.Itoa(n)
		}
		if r := []rune(cp.Name); len(r) > theme.MaxNameLen {
			cp.Name = string(r[:theme.MaxNameLen])
		}
	}
	return s.saveLocked(cp)
}

// Delete removes the user theme id's file and returns what it held. A curated id is
// ErrCurated; an id with no valid theme is ErrNotFound (a file that does not read is
// the user's to fix or remove by hand).
func (s *Store) Delete(id string) (theme.File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if theme.IsCurated(id) {
		return theme.File{}, fmt.Errorf("%w: %q is a curated theme; only your own themes can be deleted", ErrCurated, id)
	}
	f, ok := s.Snapshot().Get(id)
	if !ok {
		return theme.File{}, fmt.Errorf("%w %q among your themes", ErrNotFound, id)
	}
	if err := os.Remove(s.Path(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return theme.File{}, fmt.Errorf("themes: delete %s: %w", id, err)
	}
	s.log.Info("themes: deleted", "id", id)
	s.loadLocked()
	return f, nil
}

// loadLocked reads the directory and publishes the snapshot if it changed. s.mu held.
func (s *Store) loadLocked() {
	themes, issues, headers := s.read()
	prev := s.Snapshot()
	valid := map[string]bool{}
	for _, f := range themes {
		valid[f.ID] = true
		delete(s.gone, f.ID)
	}
	for _, f := range prev.Themes {
		if !valid[f.ID] {
			s.gone[f.ID] = f.From
		}
	}
	// A file that does not validate but names its id (and from) counts as a theme that
	// went away: a setting naming it falls back to its from, even at the first read.
	for _, h := range headers {
		if !valid[h.ID] && theme.ValidID(h.ID) {
			if _, seen := s.gone[h.ID]; !seen || h.From != "" {
				s.gone[h.ID] = h.From
			}
		}
	}
	user := make([]theme.Theme, len(themes))
	for i, f := range themes {
		user[i] = f.Theme()
	}
	next := &Snapshot{Themes: themes, Issues: issues, Version: prev.Version, set: theme.NewSet(user, s.gone)}
	if same(prev, next) {
		return
	}
	next.Version = prev.Version + 1
	for _, is := range issues {
		if !slices.Contains(prev.Issues, is) {
			s.log.Warn("themes: file not loaded", "file", is.File, "reason", is.Message)
		}
	}
	s.snap.Store(next)
	for _, fn := range s.hooks {
		fn(next)
	}
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, Changed{Snapshot: next})
	}
}

func same(a, b *Snapshot) bool {
	if !slices.Equal(a.Issues, b.Issues) || len(a.Themes) != len(b.Themes) || !maps.Equal(a.set.Gone(), b.set.Gone()) {
		return false
	}
	for i := range a.Themes {
		if string(a.Themes[i].Marshal()) != string(b.Themes[i].Marshal()) {
			return false
		}
	}
	return true
}

// read lists the directory: the valid themes (by name, then id), the files that are
// not, and the headers of those that name an id. A directory that is not there is
// empty.
func (s *Store) read() ([]theme.File, []Issue, []theme.Header) {
	entries, err := os.ReadDir(s.opts.Dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("themes: cannot read the directory", "dir", s.opts.Dir, "err", err)
		}
		return []theme.File{}, nil, nil
	}
	themes := []theme.File{}
	var issues []Issue
	var headers []theme.Header
	n := 0
	for _, e := range entries {
		name := e.Name()
		if !relevant(name) || e.IsDir() {
			continue
		}
		if n++; n > MaxFiles {
			issues = append(issues, Issue{File: name, Message: fmt.Sprintf("not read: the directory has more than %d theme files", MaxFiles)})
			continue
		}
		f, h, err := readFile(filepath.Join(s.opts.Dir, name))
		if h.ID != "" {
			headers = append(headers, h)
		}
		if err != nil {
			issues = append(issues, Issue{File: name, Message: err.Error()})
			continue
		}
		themes = append(themes, f)
	}
	slices.SortFunc(themes, func(a, b theme.File) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.ID, b.ID))
	})
	slices.SortFunc(issues, func(a, b Issue) int { return cmp.Compare(a.File, b.File) })
	return themes, issues, headers
}

// readFile reads one theme file. The header is what a file names of itself, also when
// it does not validate (the file name stands in for an id it lacks).
func readFile(path string) (theme.File, theme.Header, error) {
	stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	fi, err := os.Stat(path)
	if err != nil {
		return theme.File{}, theme.Header{}, fmt.Errorf("cannot read: %w", err)
	}
	if !fi.Mode().IsRegular() {
		return theme.File{}, theme.Header{}, errors.New("not a regular file")
	}
	if fi.Size() > theme.MaxFileBytes {
		return theme.File{}, theme.Header{ID: stem}, fmt.Errorf("more than %d KiB", theme.MaxFileBytes>>10)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return theme.File{}, theme.Header{}, fmt.Errorf("cannot read: %w", err)
	}
	h, _ := theme.ReadHeader(data)
	if h.ID == "" {
		h.ID = stem
	}
	f, err := theme.ParseFile(data)
	switch {
	case err != nil:
		return theme.File{}, h, errors.New(strings.TrimPrefix(err.Error(), theme.ErrInvalid.Error()+": "))
	case f.ID != stem:
		return theme.File{}, theme.Header{ID: stem, From: f.From}, fmt.Errorf("its id %q does not match the file name; name the file %s%s", f.ID, f.ID, Ext)
	case theme.IsCurated(f.ID):
		return theme.File{}, theme.Header{}, fmt.Errorf("%q is a curated theme's id; give the theme (and the file) another id", f.ID)
	}
	return f, h, nil
}

// relevant: a theme file's name, not a write's temporary dot file.
func relevant(name string) bool {
	return !strings.HasPrefix(name, ".") && strings.EqualFold(filepath.Ext(name), Ext)
}

// writeAtomic writes data to path through a temporary file in the same directory.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	return nil
}
