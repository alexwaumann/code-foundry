package usertheme

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// Versions (docs/notes/theme-fuzz-daemon.md): every valid version of a user theme the
// store sees replaced (a save, the editor's Save, a thread's refinement, a hand edit) or
// removed by hand is kept in HistoryDir/<id>/<version>.json, the newest MaxHistory per
// theme, so a theme card's Undo can put the previous colours back (Restore). Delete
// removes a theme's versions with it. HistoryDir is a dot directory: a read skips it, and
// the watch ignores it.
const (
	HistoryDir = ".history"
	// MaxHistory bounds the versions kept per theme.
	MaxHistory = 10
)

var versionFile = regexp.MustCompile(`^[0-9a-f]{32}\.json$`)

func (s *Store) historyDir(id string) string { return filepath.Join(s.opts.Dir, HistoryDir, id) }

// keepVersion writes f into its theme's history (a version already there is touched, so
// it counts as the newest) and drops the oldest past MaxHistory. A failure is logged: the
// write that replaced f has happened.
func (s *Store) keepVersion(f theme.File) {
	dir := s.historyDir(f.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		s.log.Warn("themes: cannot keep the previous version", "id", f.ID, "err", err)
		return
	}
	if err := writeAtomic(filepath.Join(dir, f.Version()+Ext), f.Marshal(), 0o600); err != nil {
		s.log.Warn("themes: cannot keep the previous version", "id", f.ID, "err", err)
		return
	}
	versions := s.readHistory(f.ID)
	for _, v := range versions[min(len(versions), MaxHistory):] {
		_ = os.Remove(filepath.Join(dir, v+Ext))
	}
}

// readHistory is the versions kept of id, newest first.
func (s *Store) readHistory(id string) []string {
	entries, err := os.ReadDir(s.historyDir(id))
	if err != nil {
		return nil
	}
	type kept struct {
		v   string
		mod int64
	}
	var ks []kept
	for _, e := range entries {
		if !e.Type().IsRegular() || !versionFile.MatchString(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		ks = append(ks, kept{strings.TrimSuffix(e.Name(), Ext), fi.ModTime().UnixNano()})
	}
	slices.SortFunc(ks, func(a, b kept) int { return cmp.Or(cmp.Compare(b.mod, a.mod), cmp.Compare(a.v, b.v)) })
	out := make([]string, len(ks))
	for i, k := range ks {
		out[i] = k.v
	}
	return out
}

// readAllHistory is every theme's kept versions, newest first.
func (s *Store) readAllHistory() map[string][]string {
	entries, err := os.ReadDir(filepath.Join(s.opts.Dir, HistoryDir))
	if err != nil {
		return nil
	}
	out := map[string][]string{}
	for _, e := range entries {
		if !e.IsDir() || !theme.ValidID(e.Name()) {
			continue
		}
		if vs := s.readHistory(e.Name()); len(vs) > 0 {
			out[e.Name()] = vs
		}
	}
	return out
}

// Restore puts back a kept version of the user theme id (a theme card's Undo when the
// save replaced the theme the slot already showed): the version's file is written as
// <id>.json, exactly as it was (its created_by included), and what it replaces is kept in
// turn. ErrNotFound when that version is not kept (MaxHistory dropped it, or the theme
// was deleted).
func (s *Store) Restore(id, version string) (Saved, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !theme.ValidID(id) || !versionFile.MatchString(version+Ext) {
		return Saved{}, fmt.Errorf("%w: no version %q of %q", ErrNotFound, version, id)
	}
	data, err := os.ReadFile(filepath.Join(s.historyDir(id), version+Ext))
	if errors.Is(err, fs.ErrNotExist) {
		return Saved{}, fmt.Errorf("%w: the version of %q from before is no longer kept (only the last %d are)", ErrNotFound, id, MaxHistory)
	}
	if err != nil {
		return Saved{}, fmt.Errorf("themes: restore %s: %w", id, err)
	}
	f, _, err := theme.ParseStored(data)
	if err != nil {
		return Saved{}, fmt.Errorf("themes: restore %s: the kept version does not read: %w", id, err)
	}
	if f.ID != id {
		return Saved{}, fmt.Errorf("%w: the kept version of %q names %q", ErrNotFound, id, f.ID)
	}
	return s.saveLocked(f)
}

// HasVersion reports whether the user theme id's file is at version now or that version
// is kept (Restore can put it back).
func (s *Snapshot) HasVersion(id, version string) bool {
	if f, ok := s.Get(id); ok && f.Version() == version {
		return true
	}
	return slices.Contains(s.History[id], version)
}
