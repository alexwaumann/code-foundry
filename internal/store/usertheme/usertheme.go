// Package usertheme is the user's own colour themes: one JSON file per theme in the
// themes directory (paths.Themes), in the curated catalog's format plus `from` and
// `created_by` (theme.File; docs/notes/user-themes.md). The theme.* commands write it
// through Store (Save, Duplicate, Restore, Delete, DeleteFile); a file written or edited
// by hand is read the same way. A file that does not validate is listed in the snapshot's
// Issues with why, never rewritten by a read; DeleteFile removes one on request.
//
// Every read leaves a Snapshot; one that differs from the last runs the OnChange hooks
// (the settings store, which validates appearance.theme_dark / theme_light against the
// themes) and is published on the bus as Changed. Watch reads again on every change to
// the directory, so a hand edit is published within a moment (watch.go). The store
// stores files and derives no colour: the GUI resolves a theme's slots. It keeps the
// previous versions of each theme (history.go) and the ids it has seen (seen.go).
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
// The files of the themes in use (Options.InUse) are always read.
const MaxFiles = 500

// Sentinel errors; use errors.Is. Validation problems wrap theme.ErrInvalid.
var (
	// ErrNotFound: no theme with that id (Delete: no user theme; Duplicate, Get: none
	// at all; Restore: no such version kept; DeleteFile: no such file that did not load).
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
	// History is the versions kept of each theme (history.go), newest first; the
	// current version is not among them unless it was restored.
	History map[string][]string
	// Version grows by one per change in this daemon's lifetime.
	Version uint64
	set     theme.Set
}

// Set is the themes a setting can name: these and the catalog, and the user themes
// that went away (seen.go) or whose file no longer reads, for fallback.
func (s *Snapshot) Set() theme.Set { return s.set }

// Get returns the user theme with id.
func (s *Snapshot) Get(id string) (theme.File, bool) {
	i := slices.IndexFunc(s.Themes, func(f theme.File) bool { return f.ID == id })
	if i < 0 {
		return theme.File{}, false
	}
	return s.Themes[i].Clone(), true
}

// Issue returns the issue of the file named name ("ocean.json"), or, when name is an id,
// of the file <id>.json in any case.
func (s *Snapshot) Issue(name string) (Issue, bool) {
	for _, is := range s.Issues {
		if is.File == name {
			return is, true
		}
	}
	if theme.ValidID(name) {
		for _, is := range s.Issues {
			if strings.EqualFold(is.File, name+Ext) {
				return is, true
			}
		}
	}
	return Issue{}, false
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
	// InUse names the themes the slots name (the daemon reads settings.toml): their files
	// are read first, so a directory of more than MaxFiles never drops them. Asked only
	// then; nil: none.
	InUse func() []string
}

// Store reads and writes the themes directory. Methods are safe for concurrent use.
type Store struct {
	opts Options
	log  *slog.Logger

	// mu serialises reads and writes, so snapshots are built and published in order.
	mu    sync.Mutex
	hooks []func(*Snapshot)
	// seen is every user theme id read valid, now or before (seen.go), with its from;
	// nil until the first read.
	seen map[string]string
	// noted is the forgiveness notes last logged per file (theme.ParseStored).
	noted map[string]string
	// deleting is the id Delete is removing: its versions are not kept.
	deleting string
	snap     atomic.Pointer[Snapshot]
}

// New returns a store with an empty snapshot; call Load to read the directory.
func New(opts Options) *Store {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	s := &Store{opts: opts, log: opts.Log, noted: map[string]string{}}
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
	// Path is the file written (a symlink's target when <id>.json is a link).
	Path string
	// Replaced is true when a theme with the id was there before.
	Replaced bool
	// PreviousVersion is the version of the user theme this write replaced, kept in its
	// history (Restore puts it back); "" when there was none, or it is the same version.
	PreviousVersion string
}

// Save validates f and writes it as <id>.json, replacing a user theme with the same id
// (whose version is kept, history.go). A curated id is refused (ErrCurated). A file
// named <id>.json in another case is renamed to it; a symlink is written through.
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
	was, replaced := s.Snapshot().Get(f.ID)
	if err := os.MkdirAll(s.opts.Dir, 0o700); err != nil {
		return Saved{}, fmt.Errorf("themes: %w", err)
	}
	path, mode, existed, err := s.target(f.ID)
	if err != nil {
		return Saved{}, err
	}
	replaced = replaced || existed // an invalid file with that name: overwritten too
	if err := writeAtomic(path, f.Marshal(), mode); err != nil {
		return Saved{}, err
	}
	s.log.Info("themes: saved", "id", f.ID, "replaced", replaced, "created_by", f.CreatedBy)
	s.loadLocked()
	out := Saved{File: f, Path: path, Replaced: replaced}
	if v := was.Version(); was.ID != "" && v != f.Version() && slices.Contains(s.Snapshot().History[f.ID], v) {
		out.PreviousVersion = v
	}
	return out, nil
}

// target is where a save of id writes: <id>.json, after renaming a file whose name
// differs from it only in case (a case-insensitive volume would keep the old name over
// the rename), or the target of <id>.json when it is a symlink (a theme kept in a dotfiles
// repository stays there). mode is the replaced file's, else 0600.
func (s *Store) target(id string) (path string, mode fs.FileMode, existed bool, err error) {
	path, mode = s.Path(id), 0o600
	if entries, err := os.ReadDir(s.opts.Dir); err == nil && !slices.ContainsFunc(entries, func(e fs.DirEntry) bool { return e.Name() == id+Ext }) {
		// Only when no entry has the exact name: on a case-sensitive volume both may be
		// there, and the rename would replace the other file.
		for _, e := range entries {
			if n := e.Name(); strings.EqualFold(n, id+Ext) {
				if err := os.Rename(filepath.Join(s.opts.Dir, n), path); err != nil {
					return "", 0, false, fmt.Errorf("themes: rename %s to %s%s: %w", n, id, Ext, err)
				}
				s.log.Info("themes: renamed to its id", "file", n, "id", id)
				break
			}
		}
	}
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return path, mode, false, nil
	case err != nil:
		return "", 0, false, fmt.Errorf("themes: write %s: %w", path, err)
	case fi.Mode()&fs.ModeSymlink != 0:
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", 0, false, fmt.Errorf("themes: %s%s is a link to a file that is not there (%w); fix or remove the link", id, Ext, err)
		}
		path = real
		if fi, err = os.Stat(real); err != nil {
			return "", 0, false, fmt.Errorf("themes: write %s: %w", real, err)
		}
	}
	if !fi.Mode().IsRegular() {
		return "", 0, false, fmt.Errorf("themes: %s is not a regular file; move it out of the themes directory", path)
	}
	return path, fi.Mode().Perm(), true, nil
}

// Duplicate copies the theme id (user or curated) into a new user theme: id
// "<id>-copy", then "<id>-copy-2", ...; name the given one, else "<name> copy" (then
// "<name> copy 2", ...); from id; createdBy the thread that asked ("" for the user).
// The colours, overrides and source are the original's; pair is not copied (the
// original's pair is the original's: a copy has none until one is made for it).
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
	cp.ID, cp.From, cp.CreatedBy, cp.Pair = newID, src.ID, createdBy, ""
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

// Delete removes the user theme id's file and its kept versions, and returns what it
// held. A curated id is ErrCurated; an id with no valid theme is ErrNotFound (DeleteFile
// removes a file that does not read).
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
	if err := os.RemoveAll(s.historyDir(id)); err != nil {
		s.log.Warn("themes: cannot remove the kept versions", "id", id, "err", err)
	}
	s.deleting = id
	s.loadLocked()
	s.deleting = ""
	return f, nil
}

// DeleteFile removes a file of the directory that did not load (an Issue), named by its
// file name or, for <id>.json in any case, by the id. A symlink is removed, not its
// target. ErrNotFound when no such file is listed.
func (s *Store) DeleteFile(name string) (Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	is, ok := s.Snapshot().Issue(name)
	if !ok {
		return Issue{}, fmt.Errorf("%w: no file %q among those that did not load", ErrNotFound, name)
	}
	if err := os.Remove(filepath.Join(s.opts.Dir, is.File)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return Issue{}, fmt.Errorf("themes: delete %s: %w", is.File, err)
	}
	s.log.Info("themes: deleted a file that did not load", "file", is.File)
	s.loadLocked()
	return is, nil
}

// loadLocked reads the directory and publishes the snapshot if it changed. s.mu held.
func (s *Store) loadLocked() {
	s.loadSeen()
	themes, issues, headers := s.read()
	prev := s.Snapshot()
	valid := map[string]bool{}
	for _, f := range themes {
		valid[f.ID] = true
	}
	// A valid version that changed or went away is kept (history.go), however it went.
	for _, f := range prev.Themes {
		if f.ID == s.deleting {
			continue
		}
		if now := slices.IndexFunc(themes, func(n theme.File) bool { return n.ID == f.ID }); now < 0 || themes[now].Version() != f.Version() {
			s.keepVersion(f)
		}
	}
	s.noteSeen(themes)
	gone := map[string]string{}
	for id, from := range s.seen {
		if !valid[id] {
			gone[id] = from
		}
	}
	// A file that does not validate but names its id (and from) counts as a theme that
	// went away: a setting naming it falls back to its from, even at the first read.
	for _, h := range headers {
		if !valid[h.ID] && theme.ValidID(h.ID) && !theme.IsCurated(h.ID) {
			if _, seen := gone[h.ID]; !seen || h.From != "" {
				gone[h.ID] = h.From
			}
		}
	}
	user := make([]theme.Theme, len(themes))
	for i, f := range themes {
		user[i] = f.Theme()
	}
	next := &Snapshot{Themes: themes, Issues: issues, History: s.readAllHistory(), Version: prev.Version, set: theme.NewSet(user, gone)}
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
	if !slices.Equal(a.Issues, b.Issues) || len(a.Themes) != len(b.Themes) || !maps.Equal(a.set.Gone(), b.set.Gone()) ||
		!maps.EqualFunc(a.History, b.History, slices.Equal) {
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
// empty. Past MaxFiles, the files of the themes in use are read first.
func (s *Store) read() ([]theme.File, []Issue, []theme.Header) {
	entries, err := os.ReadDir(s.opts.Dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("themes: cannot read the directory", "dir", s.opts.Dir, "err", err)
		}
		return []theme.File{}, nil, nil
	}
	var names []string
	exact := map[string]bool{}
	for _, e := range entries {
		if name := e.Name(); relevant(name) && !e.IsDir() {
			names = append(names, name)
			exact[name] = true
		}
	}
	if len(names) > MaxFiles && s.opts.InUse != nil {
		inUse := map[string]bool{}
		for _, id := range s.opts.InUse() {
			inUse[strings.ToLower(id+Ext)] = true
		}
		slices.SortStableFunc(names, func(a, b string) int {
			return cmp.Compare(boolRank(!inUse[strings.ToLower(a)]), boolRank(!inUse[strings.ToLower(b)]))
		})
	}
	themes := []theme.File{}
	var issues []Issue
	var headers []theme.Header
	notes := map[string]string{}
	for n, name := range names {
		if n >= MaxFiles {
			issues = append(issues, Issue{File: name, Message: fmt.Sprintf("not read: over the %d-file limit of the themes directory", MaxFiles)})
			continue
		}
		f, h, forgiven, err := readFile(filepath.Join(s.opts.Dir, name), exact)
		if h.ID != "" {
			headers = append(headers, h)
		}
		if err != nil {
			issues = append(issues, Issue{File: name, Message: err.Error()})
			continue
		}
		if len(forgiven) > 0 {
			notes[name] = strings.Join(forgiven, "; ")
		}
		themes = append(themes, f)
	}
	for name, note := range notes {
		if s.noted[name] != note {
			s.log.Info("themes: read leniently (the file is put right on its next save)", "file", name, "note", note)
		}
	}
	s.noted = notes
	slices.SortFunc(themes, func(a, b theme.File) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.ID, b.ID))
	})
	slices.SortFunc(issues, func(a, b Issue) int { return cmp.Compare(a.File, b.File) })
	return themes, issues, headers
}

func boolRank(b bool) int {
	if b {
		return 1
	}
	return 0
}

// readFile reads one theme file; names are the directory's theme file names. The header
// is what a file names of itself, also when it does not validate (the file name stands
// in for an id it lacks). forgiven is what theme.ParseStored put right.
func readFile(path string, names map[string]bool) (theme.File, theme.Header, []string, error) {
	stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	fi, err := os.Stat(path)
	if err != nil {
		if lfi, lerr := os.Lstat(path); lerr == nil && lfi.Mode()&fs.ModeSymlink != 0 {
			return theme.File{}, theme.Header{}, nil, errors.New("a link to a file that is not there")
		}
		return theme.File{}, theme.Header{}, nil, fmt.Errorf("cannot read: %w", err)
	}
	if !fi.Mode().IsRegular() {
		return theme.File{}, theme.Header{}, nil, errors.New("not a regular file")
	}
	if fi.Size() > theme.MaxFileBytes {
		return theme.File{}, theme.Header{ID: stem}, nil, fmt.Errorf("more than %d KiB", theme.MaxFileBytes>>10)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return theme.File{}, theme.Header{}, nil, fmt.Errorf("cannot read: %w", err)
	}
	h, _ := theme.ReadHeader(data)
	if h.ID == "" {
		h.ID = stem
	}
	// What an older release accepted is put right in what loads (the file is not
	// rewritten; its next save writes it right).
	f, forgiven, err := theme.ParseStored(data)
	switch {
	case err != nil:
		return theme.File{}, h, nil, errors.New(strings.TrimPrefix(err.Error(), theme.ErrInvalid.Error()+": "))
	case f.ID != stem && strings.EqualFold(f.ID, stem):
		return theme.File{}, theme.Header{ID: f.ID, From: f.From}, nil, fmt.Errorf("its name differs from its id %q only in case: name the file %s%s (theme save %s does)", f.ID, f.ID, Ext, f.ID)
	case f.ID != stem && names[f.ID+Ext]:
		// A copy (Finder's "ocean-dusk copy.json"): the id is the original's.
		return theme.File{}, theme.Header{}, nil, fmt.Errorf("its id %q is taken by %s%s: give this file a new \"id\" and name it after it (theme duplicate %s makes a copy that way)", f.ID, f.ID, Ext, f.ID)
	case f.ID != stem:
		return theme.File{}, theme.Header{ID: stem, From: f.From}, nil, fmt.Errorf("its id %q does not match the file name; name the file %s%s", f.ID, f.ID, Ext)
	case theme.IsCurated(f.ID):
		return theme.File{}, theme.Header{}, nil, fmt.Errorf("%q is a curated theme's id; give the theme (and the file) another id", f.ID)
	}
	return f, h, forgiven, nil
}

// relevant: a theme file's name, not a write's temporary dot file, the seen index or the
// history directory.
func relevant(name string) bool {
	return !strings.HasPrefix(name, ".") && strings.EqualFold(filepath.Ext(name), Ext)
}

// writeAtomic writes data to path through a temporary file in the same directory.
func writeAtomic(path string, data []byte, mode fs.FileMode) error {
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
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("themes: write %s: %w", path, err)
	}
	return nil
}
