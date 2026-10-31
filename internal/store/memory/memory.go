// Package memory is the app memory: the user's standing preferences about Code Foundry
// and how the model inside it behaves ("always open PRs as drafts"). Claude Code's own
// memory is keyed by directory, so it fragments across worktrees and does not cover the
// app; these reach every thread instead: the thread store reads them at every spawn and
// appends them to --append-system-prompt (docs/notes/control-3-app-memory.md).
//
// The memory is a directory (paths.Memory) in the shape Claude Code keeps its own
// memory, so the model already knows it: one markdown file per entry, its provenance in
// frontmatter (created, and the thread that added it), the text after it on one line,
// and an index, MEMORY.md, rewritten after every write and never read
// (docs/notes/memory-dir.md). At most MaxEntries entries and MaxBytes bytes of injected
// text, each entry at most MaxEntryChars characters. The daemon owns it: the memory.*
// commands write it through Store, one temporary file and a rename per entry. Files
// edited or added by hand are read leniently (parseEntry) and capped for the prompt
// (Injected).
//
// Every read and write leaves a Snapshot; one that differs from the last is published
// on the bus as an Event. Watch reads again on every change to the directory, so a hand
// edit is published within a moment (watch.go).
package memory

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The caps: an add that would pass MaxEntries or MaxBytes fails with ErrFull; an entry
// longer than MaxEntryChars (characters, not bytes) is ErrInvalidArgument. Injected
// keeps a directory edited past the first two within them.
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

// Entry is one remembered preference, its 1-based position in the memory and where it
// came from. The JSON is the text and the index only; the memory.* commands add the
// provenance in their own views.
type Entry struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
	// File is the entry's file name in the directory.
	File string `json:"-"`
	// Created is when it was added; zero when unknown (a file without frontmatter).
	Created time.Time `json:"-"`
	// ThreadID and ThreadName are the thread that added it and its name then; empty
	// when the user did (their terminal, the GUI) or it is unknown.
	ThreadID   string `json:"-"`
	ThreadName string `json:"-"`
	// Injected: threads get it. LeftOut says why not when they do not: it is longer
	// than MaxEntryChars, or past MaxEntries or MaxBytes (LeftOut* constants). Only a
	// directory edited by hand holds such an entry.
	Injected bool   `json:"-"`
	LeftOut  string `json:"-"`
}

// Why an entry is not injected (Entry.LeftOut).
const (
	LeftOutTooLong = "too_long" // longer than MaxEntryChars
	LeftOutEntries = "entries"  // past MaxEntries
	LeftOutBytes   = "bytes"    // past MaxBytes
)

// ID is the entry's stable id: its file name without ".md". It names the entry while
// the file exists, whatever its position (RemoveID).
func (e Entry) ID() string { return entryID(e.File) }

func entryID(file string) string {
	if ext := filepath.Ext(file); strings.EqualFold(ext, ".md") {
		return file[:len(file)-len(ext)]
	}
	return file
}

// Origin is who adds an entry: a thread's id and its current name, or zero for the user
// outside a thread.
type Origin struct {
	ThreadID, ThreadName string
}

// Snapshot is the memory as last read. It is immutable once published.
type Snapshot struct {
	// Version grows by one per published snapshot in this daemon's lifetime.
	Version uint64
	// Entries are every entry in order, also past the caps in a directory edited by
	// hand. Never nil.
	Entries []Entry
	// Injected is how many of Entries a thread's prompt carries (those with
	// Entry.Injected), and InjectedBytes their rendered size (Render), which MaxBytes
	// caps.
	Injected, InjectedBytes int
	// Err is why the last read failed; Entries are the last good read's.
	Err string
}

// Event is published on the bus as bus.Publish[memory.Event]. *Snapshot is the only
// one: every change carries the whole memory (40 short lines at most).
type Event interface{ isMemoryEvent() }

func (*Snapshot) isMemoryEvent() {}

// Options configure a Store.
type Options struct {
	// Dir is the memory directory (paths.Memory).
	Dir string
	// Bus receives an Event per changed snapshot; nil publishes nothing.
	Bus *bus.Bus
	// Log nil is slog.Default().
	Log *slog.Logger
	// Now nil is time.Now.
	Now func() time.Time
	// WatchRetry is how often Watch looks for a directory that is not there; 0 is two
	// seconds.
	WatchRetry time.Duration
}

// Store reads and writes the memory directory. Writes are serialised by a mutex; each
// entry lands with a rename, so a reader (a spawn) sees an entry whole or not at all.
type Store struct {
	opts Options
	log  *slog.Logger
	mu   sync.Mutex // writes

	snapMu sync.Mutex // observe
	snap   atomic.Pointer[Snapshot]
}

// New returns a Store for opts.Dir. Nothing is read or created until used.
func New(opts Options) *Store {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Store{opts: opts, log: opts.Log}
	s.snap.Store(&Snapshot{Entries: []Entry{}})
	return s
}

// Dir is the memory directory.
func (s *Store) Dir() string { return s.opts.Dir }

// Snapshot is the memory as last read, without reading it.
func (s *Store) Snapshot() *Snapshot { return s.snap.Load() }

// Load reads the memory now and returns the snapshot it leaves (Err set when the read
// failed). It waits for a write in progress, so the snapshot it publishes is never one
// from the middle of a write that a later one already replaced.
func (s *Store) Load() *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.read()
	return s.Snapshot()
}

// Entries are the entries in order, read now: every entry, also past the caps in a
// directory edited by hand.
func (s *Store) Entries() ([]Entry, error) {
	items, err := s.read()
	return entriesOf(items), err
}

// Texts are the entries' texts in order, read now (nil when there are none).
func (s *Store) Texts() ([]string, error) {
	items, err := s.read()
	if err != nil {
		return nil, err
	}
	return textsOf(items), nil
}

// Injected are the entries a thread's prompt carries, read now (Entry.Injected): the
// entries no longer than MaxEntryChars, cut to the first MaxEntries that fit MaxBytes
// rendered. Only a directory edited by hand holds more; what is left out is
// logged. The thread store calls it at every spawn.
func (s *Store) Injected() ([]string, error) {
	items, err := s.read()
	if err != nil {
		return nil, err
	}
	kept := injectedTexts(entriesOf(items))
	if len(kept) < len(items) {
		s.log.Warn("memory: the directory holds more than threads get; the rest is left out",
			"dir", s.opts.Dir, "entries", len(items), "injected", len(kept),
			"max_entries", MaxEntries, "max_bytes", MaxBytes, "max_entry_chars", MaxEntryChars)
	}
	return kept, nil
}

// markInjected sets Injected and LeftOut on entries in place: one longer than
// MaxEntryChars is left out on its own; of the others, the longest prefix within
// MaxEntries and MaxBytes rendered is injected and the rest left out.
func markInjected(entries []Entry) {
	n, bytes, full := 0, 0, ""
	for i := range entries {
		e := &entries[i]
		e.Injected, e.LeftOut = false, ""
		line := len("- ") + len(e.Text) + len("\n") // its line (Render)
		switch {
		case TooLong(e.Text):
			e.LeftOut = LeftOutTooLong
		case full != "":
			e.LeftOut = full
		case n == MaxEntries:
			full, e.LeftOut = LeftOutEntries, LeftOutEntries
		case bytes+line > MaxBytes:
			full, e.LeftOut = LeftOutBytes, LeftOutBytes
		default:
			e.Injected = true
			n++
			bytes += line
		}
	}
}

// injectedTexts are the texts of the entries marked Injected, in order (nil for none).
func injectedTexts(entries []Entry) []string {
	var out []string
	for _, e := range entries {
		if e.Injected {
			out = append(out, e.Text)
		}
	}
	return out
}

// Added is what Add did.
type Added struct {
	Entry Entry
	// Duplicate: the memory had the text already (Entry is that one); nothing changed.
	Duplicate bool
}

// Add saves text as the last entry, recording by. text is normalised (Clean); empty,
// multi-line or too long text is ErrInvalidArgument. Text the memory has already
// (normalised, compared case-insensitively) is not added again: Added.Duplicate.
// Passing a cap is ErrFull, naming it.
func (s *Store) Add(text string, by Origin) (Added, error) {
	text, err := Clean(text)
	if err != nil {
		return Added{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.read()
	if err != nil {
		return Added{}, err
	}
	for _, it := range items {
		if strings.EqualFold(it.Text, text) {
			return Added{Entry: it.Entry, Duplicate: true}, nil
		}
	}
	if len(items) >= MaxEntries {
		return Added{}, fmt.Errorf("%w: it holds at most %d entries and has %d; remove one first", ErrFull, MaxEntries, len(items))
	}
	if n := len(Render(append(textsOf(items), text))); n > MaxBytes {
		return Added{}, fmt.Errorf("%w: it holds at most %d bytes (4 KiB) and would have %d with this entry; shorten it or remove one first",
			ErrFull, MaxBytes, n)
	}
	created := s.opts.Now().UTC().Truncate(time.Millisecond)
	if last := latest(items); !created.After(last) {
		created = last.Add(time.Millisecond) // after every entry, so it is the last
	}
	taken, err := s.names()
	if err != nil {
		return Added{}, err
	}
	name := fileName(text, taken)
	if err := s.writeFile(name, renderEntry(text, created, by)); err != nil {
		return Added{}, err
	}
	items, err = s.reindex()
	if err != nil {
		return Added{}, err
	}
	e := Entry{Index: len(items), Text: text, File: name, Created: created, ThreadID: by.ThreadID, ThreadName: by.ThreadName}
	for _, it := range items {
		if it.File == name {
			e = it.Entry
		}
	}
	s.log.Info("memory: added", "index", e.Index, "file", name, "entries", len(items), "by", by.ThreadID)
	return Added{Entry: e}, nil
}

// Remove deletes one entry (find): ref is its 1-based index, its text, its id
// (Entry.ID), or text found in exactly one entry. An index out of range or a substring
// in several entries is ErrInvalidArgument (the message lists the matches); no match is
// ErrNotFound. Every file holding that text goes (a copy made by hand too). by is the
// thread that asked, for the log.
func (s *Store) Remove(ref, by string) (Entry, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return Entry{}, fmt.Errorf("%w: give an entry's number or text from it", ErrInvalidArgument)
	}
	return s.remove(by, func(items []item) (int, error) { return find(items, ref) })
}

// RemoveID deletes the entry whose id (Entry.ID, any case) is id, whatever its position
// now: the Settings page names an entry this way, so a list that changed since it was
// shown cannot make it remove another. No such entry (its file is gone, or was renamed
// by hand) is ErrNotFound.
func (s *Store) RemoveID(id, by string) (Entry, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Entry{}, fmt.Errorf("%w: give an entry's id", ErrInvalidArgument)
	}
	return s.remove(by, func(items []item) (int, error) {
		if i := findID(items, id); i >= 0 {
			return i, nil
		}
		return 0, fmt.Errorf("%w: there is no entry %s now; it was removed or its file renamed", ErrNotFound, id)
	})
}

// remove deletes the entry pick chooses from the entries read now.
func (s *Store) remove(by string, pick func([]item) (int, error)) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.read()
	if err != nil {
		return Entry{}, err
	}
	i, err := pick(items)
	if err != nil {
		return Entry{}, err
	}
	removed := items[i]
	for _, f := range removed.files {
		if err := s.removeFile(f); err != nil {
			return Entry{}, err
		}
	}
	items, err = s.reindex()
	if err != nil {
		return Entry{}, err
	}
	s.log.Info("memory: removed", "index", removed.Index, "file", removed.File, "entries", len(items), "by", by)
	return removed.Entry, nil
}

// Clear forgets every entry and returns how many there were: every entry file goes
// (one without text too), the index is emptied. by is the thread that asked, for the
// log.
func (s *Store) Clear(by string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.read()
	if err != nil {
		return 0, err
	}
	if len(items) > 0 {
		files, err := s.entryFiles()
		if err != nil {
			return 0, err
		}
		for _, f := range files {
			if err := s.removeFile(f.Name()); err != nil {
				return 0, err
			}
		}
		if _, err := s.reindex(); err != nil {
			return 0, err
		}
	}
	s.log.Info("memory: cleared", "entries", len(items), "by", by)
	return len(items), nil
}

// findID is the index of the item with a file whose id is id (any case), else -1.
func findID(items []item, id string) int {
	for i, it := range items {
		for _, f := range it.files {
			if strings.EqualFold(entryID(f), id) {
				return i
			}
		}
	}
	return -1
}

// find is the index into items that ref names: digits are a 1-based index when one is
// in range; otherwise the entry whose text ref is (normalised, any case), else the
// entry whose id it is (Entry.ID), else the one entry that contains ref (any case).
// Digits out of range that no text matches either are an index error.
func find(items []item, ref string) (int, error) {
	texts := textsOf(items)
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
	if i := findID(items, ref); i >= 0 {
		return i, nil
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

// item is an entry and every file holding its text (the first is Entry.File).
type item struct {
	Entry
	files []string
}

func entriesOf(items []item) []Entry {
	out := make([]Entry, len(items))
	for i, it := range items {
		out[i] = it.Entry
	}
	return out
}

func textsOf(items []item) []string {
	if len(items) == 0 {
		return nil
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Text
	}
	return out
}

// latest is the latest Created of items (zero for none).
func latest(items []item) time.Time {
	var t time.Time
	for _, it := range items {
		if it.Created.After(t) {
			t = it.Created
		}
	}
	return t
}

// read reads the directory now and records the snapshot it gives (observe). A missing
// directory is an empty memory. Entries are ordered by created (a file without one by
// its modification time), then file name; a text in several files (any case) counts
// once, in its first. A file that cannot be read, or holds no text, is skipped
// (logged).
func (s *Store) read() ([]item, error) {
	items, err := s.readDir()
	s.observe(items, err)
	return items, err
}

func (s *Store) readDir() ([]item, error) {
	files, err := s.entryFiles()
	if err != nil {
		return nil, err
	}
	type found struct {
		item
		key time.Time
	}
	var all []found
	for _, de := range files {
		path := filepath.Join(s.opts.Dir, de.Name())
		fi, err := os.Stat(path) // through a link
		if err != nil || !fi.Mode().IsRegular() {
			if err != nil {
				s.log.Warn("memory: entry file skipped", "file", path, "err", err)
			}
			continue
		}
		b, err := os.ReadFile(path)
		if err != nil {
			s.log.Warn("memory: entry file skipped", "file", path, "err", err)
			continue
		}
		p := parseEntry(string(b))
		if !WellFormed(p.text) {
			s.log.Warn("memory: entry file holds no text; skipped", "file", path, "why", NoLetter)
			continue
		}
		e := Entry{Text: p.text, File: de.Name(), Created: p.created, ThreadID: p.threadID, ThreadName: p.threadNm}
		all = append(all, found{item: item{Entry: e}, key: cmp.Or(p.created, fi.ModTime().UTC())})
	}
	slices.SortFunc(all, func(a, b found) int {
		return cmp.Or(a.key.Compare(b.key), strings.Compare(a.File, b.File))
	})
	var out []item
	at := map[string]int{}
	for _, f := range all {
		k := strings.ToLower(f.Text)
		if i, ok := at[k]; ok {
			out[i].files = append(out[i].files, f.File)
			continue
		}
		at[k] = len(out)
		f.Index = len(out) + 1
		f.files = []string{f.File}
		out = append(out, f.item)
	}
	entries := entriesOf(out)
	markInjected(entries)
	for i := range out {
		out[i].Entry = entries[i]
	}
	return out, nil
}

// entryFiles are the directory's entry files: every *.md but the index, dot files (a
// write's temporary file) and directories. A missing directory has none.
func (s *Store) entryFiles() ([]fs.DirEntry, error) {
	des, err := os.ReadDir(s.opts.Dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fileErr("read", s.opts.Dir, err)
	}
	return slices.DeleteFunc(des, func(de fs.DirEntry) bool {
		n := de.Name()
		return de.IsDir() || strings.HasPrefix(n, ".") || !strings.HasSuffix(strings.ToLower(n), ".md") || strings.EqualFold(n, IndexFile)
	}), nil
}

// names are the directory's file names, lowercased (a new entry's must be none of them).
func (s *Store) names() (map[string]bool, error) {
	des, err := os.ReadDir(s.opts.Dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fileErr("read", s.opts.Dir, err)
	}
	out := make(map[string]bool, len(des))
	for _, de := range des {
		out[strings.ToLower(de.Name())] = true
	}
	return out, nil
}

// observe records the snapshot of a read and publishes it when it differs from the
// last one. A failed read keeps the last entries and sets Err.
func (s *Store) observe(items []item, err error) {
	s.snapMu.Lock()
	defer s.snapMu.Unlock()
	prev := s.snap.Load()
	next := &Snapshot{Version: prev.Version + 1, Entries: prev.Entries}
	if err != nil {
		next.Err = err.Error()
	} else {
		next.Entries = entriesOf(items)
	}
	kept := injectedTexts(next.Entries)
	next.Injected, next.InjectedBytes = len(kept), len(Render(kept))
	if next.Err == prev.Err && slices.Equal(next.Entries, prev.Entries) {
		return
	}
	s.snap.Store(next)
	if s.opts.Bus != nil {
		bus.Publish[Event](s.opts.Bus, next)
	}
}

// reindex reads the directory after a write and rewrites the index from it.
func (s *Store) reindex() ([]item, error) {
	items, err := s.read()
	if err != nil {
		return nil, err
	}
	return items, s.writeFile(IndexFile, renderIndex(entriesOf(items)))
}

// writeFile replaces the directory's file name with data: a temporary file beside it
// (0600), then a rename. The directory is made (0700) when missing; a directory that is
// a symbolic link is written through.
func (s *Store) writeFile(name, data string) error {
	dir := s.opts.Dir
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fileErr("write", path, err)
	}
	tmp, err := os.CreateTemp(dir, "."+name+".*")
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

// removeFile deletes the directory's file name; one already gone is fine.
func (s *Store) removeFile(name string) error {
	path := filepath.Join(s.opts.Dir, name)
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fileErr("remove", path, err)
	}
	return nil
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
