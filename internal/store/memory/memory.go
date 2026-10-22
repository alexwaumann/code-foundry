// Package memory is the app memory: the user's standing preferences about Code Foundry
// and how the model inside it behaves ("always open PRs as drafts"). Claude Code's own
// memory is keyed by directory, so it fragments across worktrees and does not cover the
// app; these reach every thread instead: the thread store reads them at every spawn and
// appends them to --append-system-prompt (docs/notes/control-3-app-memory.md).
//
// The memory is one plain markdown file (paths.Memory), one "- <text>" line per entry
// and nothing else, at most MaxEntries entries and MaxBytes bytes, each entry at most
// MaxEntryChars characters. The daemon owns it: the memory.* commands read and write it
// through Store, every write is atomic, and a missing file is an empty memory. A file
// edited by hand is read leniently (Parse) and capped for the prompt (Injected)
// (docs/notes/control-6-memory-fixes.md).
package memory

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// The caps: an add that would pass MaxEntries or MaxBytes fails with ErrFull; an entry
// longer than MaxEntryChars (characters, not bytes) is ErrInvalidArgument. Injected
// keeps a file edited past the first two within them.
const (
	MaxEntries    = 40
	MaxBytes      = 4096
	MaxEntryChars = 500
)

// Sentinel errors; use errors.Is.
var (
	// ErrInvalidArgument: an empty, multi-line or too long entry, an index out of
	// range, a substring that matches more than one entry.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrNotFound: Remove matched no entry.
	ErrNotFound = errors.New("not found")
	// ErrFull: Add would pass MaxEntries or MaxBytes.
	ErrFull = errors.New("memory is full")
)

// Entry is one remembered preference and its 1-based position in the memory.
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
// missing): every entry, also past the caps in a file edited by hand.
func (s *Store) Texts() ([]string, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fileErr("read", s.path, err)
	}
	return Parse(string(b)), nil
}

// Injected are the entries a thread's prompt carries, read now: Texts cut to the first
// MaxEntries that fit MaxBytes rendered. Only a file edited by hand holds more; what is
// left out is logged. The thread store calls it at every spawn.
func (s *Store) Injected() ([]string, error) {
	texts, err := s.Texts()
	if err != nil {
		return nil, err
	}
	kept := capped(texts)
	if len(kept) < len(texts) {
		s.log.Warn("memory: the file holds more than threads get; the rest is left out",
			"path", s.path, "entries", len(texts), "injected", len(kept), "max_entries", MaxEntries, "max_bytes", MaxBytes)
	}
	return kept, nil
}

// capped is the longest prefix of texts within MaxEntries and MaxBytes rendered.
func capped(texts []string) []string {
	n := 0
	for i, t := range texts {
		if i == MaxEntries {
			return texts[:i]
		}
		n += len("- ") + len(t) + len("\n") // its line (Render)
		if n > MaxBytes {
			return texts[:i]
		}
	}
	return texts
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

// Add appends text as the last entry. text is normalised (Clean); empty, multi-line or
// too long text is ErrInvalidArgument. Text the memory has already (normalised, compared
// case-insensitively) is not added again: Added.Duplicate. Passing a cap is ErrFull,
// naming it. by is the thread that asked ("" for none), for the log.
func (s *Store) Add(text, by string) (Added, error) {
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
	s.log.Info("memory: added", "index", len(next), "entries", len(next), "by", by)
	return Added{Entry: Entry{Index: len(next), Text: text}}, nil
}

// Remove deletes one entry (find): ref is its 1-based index, its text, or text found in
// exactly one entry. An index out of range or a substring in several entries is
// ErrInvalidArgument (the message lists the matches); no match is ErrNotFound. by is
// the thread that asked, for the log.
func (s *Store) Remove(ref, by string) (Entry, error) {
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
	s.log.Info("memory: removed", "index", removed.Index, "entries", len(next), "by", by)
	return removed, nil
}

// Clear forgets every entry and returns how many there were. by is the thread that
// asked, for the log.
func (s *Store) Clear(by string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	texts, err := s.Texts()
	if err != nil {
		return 0, err
	}
	if len(texts) > 0 {
		if err := s.write(""); err != nil {
			return 0, err
		}
	}
	s.log.Info("memory: cleared", "entries", len(texts), "by", by)
	return len(texts), nil
}

// find is the index into texts that ref names: digits are a 1-based index when one is
// in range; otherwise the entry whose text ref is (normalised, any case), else the one
// entry that contains ref (any case). Digits out of range that no text matches either
// are an index error.
func find(texts []string, ref string) (int, error) {
	digits := strings.Trim(ref, "0123456789") == ""
	if n, err := strconv.Atoi(ref); digits && err == nil && n >= 1 && n <= len(texts) {
		return n - 1, nil
	}
	exact := Normalize(ref)
	for i, t := range texts {
		if strings.EqualFold(t, exact) {
			return i, nil
		}
	}
	needle := strings.ToLower(ref)
	var hits []int
	for i, t := range texts {
		if strings.Contains(strings.ToLower(t), needle) {
			hits = append(hits, i)
		}
	}
	switch {
	case len(hits) == 1:
		return hits[0], nil
	case len(hits) == 0 && digits && len(texts) == 0:
		return 0, fmt.Errorf("%w: there is no entry %s: the memory is empty", ErrInvalidArgument, ref)
	case len(hits) == 0 && digits:
		return 0, fmt.Errorf("%w: there is no entry %s: the entries are 1 to %d", ErrInvalidArgument, ref, len(texts))
	case len(hits) == 0:
		return 0, fmt.Errorf("%w: no entry contains %q", ErrNotFound, ref)
	}
	var b strings.Builder
	for _, i := range hits {
		fmt.Fprintf(&b, "\n  %d. %s", i+1, texts[i])
	}
	return 0, fmt.Errorf("%w: %q is in %d entries; give the number of one:%s", ErrInvalidArgument, ref, len(hits), b.String())
}

// Clean checks that text can be an entry and normalises it (Normalize): one line, not
// empty, at most MaxEntryChars characters.
func Clean(text string) (string, error) {
	if strings.ContainsAny(strings.TrimSpace(text), "\n\r") {
		return "", fmt.Errorf("%w: an entry is one line; add each preference on its own", ErrInvalidArgument)
	}
	text = Normalize(text)
	if text == "" {
		return "", fmt.Errorf("%w: an empty entry", ErrInvalidArgument)
	}
	if n := utf8.RuneCountInString(text); n > MaxEntryChars {
		return "", fmt.Errorf("%w: an entry is at most %d characters and this one has %d; say it shorter or split it in two",
			ErrInvalidArgument, MaxEntryChars, n)
	}
	return text, nil
}

// Normalize is an entry as stored: trimmed, each run of white space one space, without
// a leading "- " (a list item's) and without a sentence's full stop (an ellipsis stays,
// so normalising twice changes nothing). "" when nothing is left.
func Normalize(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "-" {
		return ""
	}
	text = strings.TrimPrefix(text, "- ")
	if !strings.HasSuffix(text, "..") {
		text = strings.TrimSuffix(text, ".")
	}
	return strings.TrimSpace(text)
}

// Parse reads the entries of a memory file, edited by hand or not: CRLF line ends,
// blank lines, markdown headings and <!-- --> comments are skipped; every other line is
// an entry, normalised (Normalize). An entry repeated (any case) counts once.
func Parse(file string) []string {
	file = strings.ReplaceAll(file, "\r\n", "\n")
	file = strings.ReplaceAll(file, "\r", "\n")
	file = stripComments(file)
	var out []string
	seen := map[string]bool{}
	for line := range strings.SplitSeq(file, "\n") {
		if heading(line) {
			continue
		}
		t := Normalize(line)
		if k := strings.ToLower(t); t != "" && !seen[k] {
			seen[k] = true
			out = append(out, t)
		}
	}
	return out
}

// stripComments drops every <!-- ... --> from file (one left open runs to the end). A
// comment's line breaks stay, so the lines around it stay apart.
func stripComments(file string) string {
	var b strings.Builder
	for {
		i := strings.Index(file, "<!--")
		if i < 0 {
			b.WriteString(file)
			return b.String()
		}
		b.WriteString(file[:i])
		j := strings.Index(file[i+len("<!--"):], "-->")
		if j < 0 {
			return b.String()
		}
		end := i + len("<!--") + j + len("-->")
		b.WriteString(strings.Repeat("\n", strings.Count(file[i:end], "\n")))
		file = file[end:]
	}
}

// heading reports a markdown heading line: one to six #, then white space or nothing.
func heading(line string) bool {
	line = strings.TrimSpace(line)
	n := len(line) - len(strings.TrimLeft(line, "#"))
	return n >= 1 && n <= 6 && (len(line) == n || line[n] == ' ' || line[n] == '\t')
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
// An empty memory removes the file. When the file is a symbolic link (a user keeping it
// with their dotfiles), the write goes through it to its target, so the link stays, and
// an empty memory empties the target; a link to nothing is refused.
func (s *Store) write(data string) error {
	path, link, err := s.target()
	if err != nil {
		return err
	}
	if data == "" && !link {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fileErr("write", path, err)
		}
		return nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fileErr("write", path, err)
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return fileErr("write", path, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // gone after the rename
	if _, err := tmp.WriteString(data); err != nil {
		_ = tmp.Close()
		return fileErr("write", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fileErr("write", path, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fileErr("write", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fileErr("write", path, err)
	}
	return nil
}

// target is the file write replaces: the memory file, or the file it links to (link).
func (s *Store) target() (path string, link bool, err error) {
	fi, err := os.Lstat(s.path)
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		return s.path, false, nil // missing or a regular file: write finds out the rest
	}
	resolved, err := filepath.EvalSymlinks(s.path)
	if err != nil {
		dest, _ := os.Readlink(s.path)
		if errors.Is(err, fs.ErrNotExist) {
			return "", true, fmt.Errorf("memory: %s is a symbolic link to %s, which does not exist; "+
				"create that file or remove the link", s.path, dest)
		}
		return "", true, fileErr("resolve the symbolic link", s.path, err)
	}
	return resolved, true, nil
}

// fileErr is a file operation's error naming path once (an *fs.PathError or an
// *os.LinkError would name it again).
func fileErr(op, path string, err error) error {
	var pe *fs.PathError
	var le *os.LinkError
	switch {
	case errors.As(err, &pe):
		err = pe.Err
	case errors.As(err, &le):
		err = le.Err
	}
	return fmt.Errorf("memory: %s %s: %w", op, path, err)
}
