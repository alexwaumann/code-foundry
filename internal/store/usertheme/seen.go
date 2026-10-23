package usertheme

import (
	"encoding/json"
	"errors"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// The seen index (docs/notes/theme-fuzz-daemon.md): every user theme id the store has read
// valid, with its from, kept in SeenFile in the themes directory. A theme that is no
// longer valid counts as gone with that from (theme.Set.Fallback), so a slot falls back
// the same way whether the theme went while the daemon ran, before it restarted, or while
// the app was closed. A dot file: a read skips it, and the watch ignores it.
const (
	SeenFile = ".seen.json"
	// maxSeen bounds the index; past it the gone ids go first, by id.
	maxSeen = 2 * MaxFiles
)

type seenIndex struct {
	// Themes maps an id to its from ("" for none).
	Themes map[string]string `json:"themes"`
}

// loadSeen reads the index once, on the first read of the directory. A missing or
// unreadable index is empty (the fallback is then the default, as before it existed).
func (s *Store) loadSeen() {
	if s.seen != nil {
		return
	}
	s.seen = map[string]string{}
	data, err := os.ReadFile(filepath.Join(s.opts.Dir, SeenFile))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("themes: cannot read the seen index", "err", err)
		}
		return
	}
	var idx seenIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		s.log.Warn("themes: the seen index does not read; starting a new one", "err", err)
		return
	}
	for id, from := range idx.Themes {
		if theme.ValidID(id) && (from == "" || theme.ValidID(from)) && !theme.IsCurated(id) {
			s.seen[id] = from
		}
	}
}

// noteSeen records the valid themes of a read and writes the index when it changed. The
// directory is not made for it: with no directory there is nothing to remember.
func (s *Store) noteSeen(valid []theme.File) {
	before := maps.Clone(s.seen)
	for _, f := range valid {
		s.seen[f.ID] = f.From
	}
	if over := len(s.seen) - maxSeen; over > 0 {
		live := map[string]bool{}
		for _, f := range valid {
			live[f.ID] = true
		}
		for _, id := range slices.Sorted(maps.Keys(s.seen)) {
			if over == 0 {
				break
			}
			if !live[id] {
				delete(s.seen, id)
				over--
			}
		}
	}
	if maps.Equal(before, s.seen) {
		return
	}
	if fi, err := os.Stat(s.opts.Dir); err != nil || !fi.IsDir() {
		return
	}
	data, err := json.MarshalIndent(seenIndex{Themes: s.seen}, "", "  ")
	if err == nil {
		err = writeAtomic(filepath.Join(s.opts.Dir, SeenFile), append(data, '\n'), 0o600)
	}
	if err != nil {
		s.log.Warn("themes: cannot write the seen index", "err", err)
	}
}
