package memory

import (
	"errors"
	"io/fs"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// ImportedSuffix is appended to the legacy file's name once Import has read it.
const ImportedSuffix = ".imported"

// Imported is what Import did.
type Imported struct {
	// Entries is how many entries it wrote; Skipped how many lines it dropped as
	// malformed (no letter or digit in them); Existing how many the directory had
	// already (an import cut short and run again).
	Entries, Skipped, Existing int
	// Renamed is where the legacy file went; empty when there was none.
	Renamed string
}

// Import moves the single memory file from before the directory (Options.Legacy, one
// "- <text>" line per entry) into it, then renames the file to <name>.imported. It runs
// at every daemon start and does nothing once the file is gone. Each line Parse keeps
// becomes an entry with created the file's modification time (a millisecond apart, so
// the order stays) and no thread; a line with no letter or digit ("---", "***", a bullet
// alone) is dropped as malformed (Clean refuses the same text), and a line already in
// the directory (an import cut short) is not written twice. Lines past the caps are
// kept, like a hand edit: show and remove see them, threads get the first ones within
// the caps, and never one longer than MaxEntryChars (Injected).
func (s *Store) Import() (Imported, error) {
	var res Imported
	legacy := s.opts.Legacy
	if legacy == "" {
		return res, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fi, err := os.Stat(legacy)
	if errors.Is(err, fs.ErrNotExist) {
		return res, nil
	}
	if err != nil {
		return res, fileErr("import", legacy, err)
	}
	if !fi.Mode().IsRegular() {
		return res, fileErr("import", legacy, errors.New("not a regular file"))
	}
	b, err := os.ReadFile(legacy)
	if err != nil {
		return res, fileErr("import", legacy, err)
	}
	items, err := s.read()
	if err != nil {
		return res, err
	}
	have := map[string]bool{}
	for _, it := range items {
		have[strings.ToLower(it.Text)] = true
	}
	taken, err := s.names()
	if err != nil {
		return res, err
	}
	created := fi.ModTime().UTC().Truncate(time.Millisecond)
	texts, malformed := Parse(string(b))
	for _, line := range malformed {
		res.Skipped++
		s.log.Warn("memory: import skipped a malformed line", "file", legacy, "line", line, "why", NoLetter)
	}
	for i, text := range texts {
		if have[strings.ToLower(text)] {
			res.Existing++
			continue
		}
		if TooLong(text) {
			s.log.Warn("memory: imported an entry longer than an add allows; threads do not get it",
				"file", legacy, "chars", utf8.RuneCountInString(text), "max", MaxEntryChars)
		}
		name := fileName(text, taken)
		if err := s.writeFile(name, renderEntry(text, created.Add(time.Duration(i)*time.Millisecond), Origin{})); err != nil {
			return res, err
		}
		taken[strings.ToLower(name)] = true
		have[strings.ToLower(text)] = true
		res.Entries++
	}
	if _, err := s.reindex(); err != nil {
		return res, err
	}
	res.Renamed = legacy + ImportedSuffix
	if err := os.Rename(legacy, res.Renamed); err != nil {
		return Imported{}, fileErr("import", legacy, err)
	}
	s.log.Info("memory: imported the single memory file into the directory",
		"from", legacy, "renamed", res.Renamed, "dir", s.opts.Dir, "entries", res.Entries, "skipped", res.Skipped, "existing", res.Existing)
	return res, nil
}
