// Package memory is the app memory: the user's standing preferences about Code Foundry
// and how the model inside it behaves ("always open PRs as drafts"). Claude Code's own
// memory is keyed by directory, so it fragments across worktrees and does not cover the
// app; these reach every thread instead: the thread store reads them at every spawn and
// appends them to --append-system-prompt (docs/notes/control-3-app-memory.md).
//
// The memory is one plain markdown file (paths.Memory), one "- <text>" line per entry
// and nothing else, at most MaxEntries entries and MaxBytes bytes. The daemon owns it:
// the memory.* commands read and write it through Store, every write is atomic, and a
// missing file is an empty memory.
package memory

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// The caps: an add that would pass either fails with ErrFull.
const (
	MaxEntries = 40
	MaxBytes   = 4096
)

// Sentinel errors; use errors.Is.
var (
	// ErrInvalidArgument: an empty or multi-line entry, an index out of range, a
	// substring that matches more than one entry.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrNotFound: Remove matched no entry.
	ErrNotFound = errors.New("not found")
	// ErrFull: Add would pass MaxEntries or MaxBytes.
	ErrFull = errors.New("memory is full")
)

// Entry is one remembered preference and its 1-based position in the file.
type Entry struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
}

// Store reads and writes the memory file. Writes are serialised by a mutex and land
// with a rename, so a reader (a spawn) sees the old file or the new one, never half.
type Store struct {
	path string
	log  *slog.Logger
	mu   sync.Mutex
}

// New returns a Store for the file at path. Nothing is read or created until used.
// log nil is slog.Default().
func New(path string, log *slog.Logger) *Store {
	if log == nil {
		log = slog.Default()
	}
	return &Store{path: path, log: log}
}

// Path is the memory file.
func (s *Store) Path() string { return s.path }

// Texts are the entries' texts in file order, read from the file now (nil when it is
// missing). The thread store calls it at every spawn.
func (s *Store) Texts() ([]string, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("memory: read %s: %w", s.path, err)
	}
	return Parse(string(b)), nil
}

// Entries are the entries with their indexes, read from the file now.
func (s *Store) Entries() ([]Entry, error) {
	texts, err := s.Texts()
	if err != nil {
		return nil, err
	}
	return entries(texts), nil
}

// Added is what Add did.
type Added struct {
	Entry Entry
	// Duplicate: the memory had the text already (Entry is that one); nothing changed.
	Duplicate bool
}

// Add appends text as the last entry. text is trimmed; empty or multi-line text is
// ErrInvalidArgument. Text the memory has already (compared case-insensitively) is not
// added again: Added.Duplicate. Passing a cap is ErrFull, naming it.
func (s *Store) Add(text string) (Added, error) {
	text, err := Clean(text)
	if err != nil {
		return Added{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	texts, err := s.Texts()
	if err != nil {
		return Added{}, err
	}
	for i, t := range texts {
		if strings.EqualFold(t, text) {
			return Added{Entry: Entry{Index: i + 1, Text: t}, Duplicate: true}, nil
		}
	}
	if len(texts) >= MaxEntries {
		return Added{}, fmt.Errorf("%w: it holds at most %d entries and has %d; remove one first", ErrFull, MaxEntries, len(texts))
	}
	next := append(texts, text)
	data := Render(next)
	if len(data) > MaxBytes {
		return Added{}, fmt.Errorf("%w: it holds at most %d bytes (4 KiB) and would have %d with this entry; shorten it or remove one first",
			ErrFull, MaxBytes, len(data))
	}
	if err := s.write(data); err != nil {
		return Added{}, err
	}
	s.log.Info("memory: added", "index", len(next), "entries", len(next))
	return Added{Entry: Entry{Index: len(next), Text: text}}, nil
}

// Remove deletes one entry: ref is its 1-based index (digits only), or text found in
// exactly one entry (case-insensitive). An index out of range or a substring in several
// entries is ErrInvalidArgument (the message lists the matches); no match is ErrNotFound.
func (s *Store) Remove(ref string) (Entry, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return Entry{}, fmt.Errorf("%w: give an entry's number or text from it", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	texts, err := s.Texts()
	if err != nil {
		return Entry{}, err
	}
	i, err := find(texts, ref)
	if err != nil {
		return Entry{}, err
	}
	removed := Entry{Index: i + 1, Text: texts[i]}
	next := append(texts[:i:i], texts[i+1:]...)
	if err := s.write(Render(next)); err != nil {
		return Entry{}, err
	}
	s.log.Info("memory: removed", "index", removed.Index, "entries", len(next))
	return removed, nil
}

// Clear forgets every entry and returns how many there were.
func (s *Store) Clear() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	texts, err := s.Texts()
	if err != nil {
		return 0, err
	}
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, fmt.Errorf("memory: clear %s: %w", s.path, err)
	}
	s.log.Info("memory: cleared", "entries", len(texts))
	return len(texts), nil
}

// find is the index into texts that ref names (see Remove).
func find(texts []string, ref string) (int, error) {
	if n, err := strconv.Atoi(ref); err == nil && strings.Trim(ref, "0123456789") == "" {
		if n < 1 || n > len(texts) {
			if len(texts) == 0 {
				return 0, fmt.Errorf("%w: there is no entry %d: the memory is empty", ErrInvalidArgument, n)
			}
			return 0, fmt.Errorf("%w: there is no entry %d: the entries are 1 to %d", ErrInvalidArgument, n, len(texts))
		}
		return n - 1, nil
	}
	needle := strings.ToLower(ref)
	var hits []int
	for i, t := range texts {
		if strings.Contains(strings.ToLower(t), needle) {
			hits = append(hits, i)
		}
	}
	switch len(hits) {
	case 0:
		return 0, fmt.Errorf("%w: no entry contains %q", ErrNotFound, ref)
	case 1:
		return hits[0], nil
	}
	var b strings.Builder
	for _, i := range hits {
		fmt.Fprintf(&b, "\n  %d. %s", i+1, texts[i])
	}
	return 0, fmt.Errorf("%w: %q is in %d entries; give the number of one:%s", ErrInvalidArgument, ref, len(hits), b.String())
}

// Clean trims text and checks that it can be an entry: not empty, one line.
func Clean(text string) (string, error) {
	text = strings.TrimSpace(text)
	switch {
	case text == "", text == "-":
		return "", fmt.Errorf("%w: an empty entry", ErrInvalidArgument)
	case strings.ContainsAny(text, "\n\r"):
		return "", fmt.Errorf("%w: an entry is one line; add each preference on its own", ErrInvalidArgument)
	}
	return text, nil
}

// Parse reads the entries of a memory file: each non-blank line, trimmed, without its
// leading "- " (a line edited by hand without one counts as it is).
func Parse(file string) []string {
	var out []string
	for line := range strings.SplitSeq(file, "\n") {
		line = strings.TrimSpace(line)
		if t, ok := strings.CutPrefix(line, "- "); ok {
			line = strings.TrimSpace(t)
		}
		if line != "" && line != "-" {
			out = append(out, line)
		}
	}
	return out
}

// Render is the file for texts: one "- <text>" line each.
func Render(texts []string) string {
	var b strings.Builder
	for _, t := range texts {
		b.WriteString("- ")
		b.WriteString(t)
		b.WriteByte('\n')
	}
	return b.String()
}

func entries(texts []string) []Entry {
	out := make([]Entry, len(texts))
	for i, t := range texts {
		out[i] = Entry{Index: i + 1, Text: t}
	}
	return out
}

// write replaces the file with data: a temporary file beside it (0600), then a rename.
// An empty memory removes the file.
func (s *Store) write(data string) error {
	if data == "" {
		if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("memory: write %s: %w", s.path, err)
		}
		return nil
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("memory: write %s: %w", s.path, err)
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(s.path)+".*")
	if err != nil {
		return fmt.Errorf("memory: write %s: %w", s.path, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // gone after the rename
	if _, err := tmp.WriteString(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("memory: write %s: %w", s.path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("memory: write %s: %w", s.path, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("memory: write %s: %w", s.path, err)
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		return fmt.Errorf("memory: write %s: %w", s.path, err)
	}
	return nil
}
