package project

import (
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// fakeStream is the event source of every store test that is not about FSEvents
// itself. It delivers nothing on its own: the test makes a change on disk, then calls
// harness.fsChanged, which diffs the stream's roots against the last scan and sends the
// difference on the store's event channel, the way FSEvents reports it (one event per
// file, flags for what happened to it). So a test of what a git operation leads to does
// not depend on how fast fseventsd delivers; the tests in fsevents_test.go keep a real
// stream.
//
// Like a real stream started since now, a root's files at the moment the stream starts
// are its baseline: a change made before then is never reported.
type fakeStream struct {
	mu     sync.Mutex
	events chan []fsevents.Event // the store's channel, from the first start
	paths  []string              // the running stream's paths; nil when none runs
	gen    int                   // bumped by every start, so a stale stop is a no-op
	starts int
	scan   map[string]scanEntry // every path under paths at the last scan
	fail   bool                 // starts fail (failStarts)
}

// scanEntry is what a scan records about one path.
type scanEntry struct {
	dir   bool
	ino   uint64
	size  int64
	mtime int64
	ctime int64
	mode  fs.FileMode
}

func newFakeStream() *fakeStream { return &fakeStream{scan: map[string]scanEntry{}} }

// source is the store's streamSource.
func (f *fakeStream) source(paths []string, events chan []fsevents.Event) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return nil, errors.New("fake stream: failing starts")
	}
	f.events = events
	f.gen++
	f.starts++
	gen := f.gen
	// Roots that stay keep their scan; new roots are scanned now (their baseline);
	// dropped roots are forgotten.
	for p := range f.scan {
		if !slices.ContainsFunc(paths, func(root string) bool { return fsx.Within(root, p) }) {
			delete(f.scan, p)
		}
	}
	for _, root := range paths {
		if !slices.Contains(f.paths, root) {
			scanInto(f.scan, root)
		}
	}
	f.paths = slices.Clone(paths)
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.gen == gen {
			f.paths = nil
		}
	}, nil
}

// failStarts makes every start fail (as FSEventStreamStart can) until it is called with
// false.
func (f *fakeStream) failStarts(fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = fail
}

// running returns the paths of the stream running now.
func (f *fakeStream) running() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.paths)
}

// changed rescans the running stream's roots and sends what changed since the last
// scan as one batch. It returns the batch (empty: nothing changed, nothing sent).
func (f *fakeStream) changed() []fsevents.Event {
	f.mu.Lock()
	next := map[string]scanEntry{}
	for _, root := range f.paths {
		scanInto(next, root)
	}
	evs := diffScans(f.scan, next)
	f.scan = next
	ch := f.events
	f.mu.Unlock()
	if len(evs) > 0 && ch != nil {
		ch <- evs
	}
	return evs
}

// scanInto records every path under root (root included) in into. A path that goes
// away during the walk is skipped; a missing root records nothing.
func scanInto(into map[string]scanEntry, root string) {
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		st := scanEntry{dir: d.IsDir(), size: info.Size(), mtime: info.ModTime().UnixNano(), mode: info.Mode()}
		if sys, ok := info.Sys().(*syscall.Stat_t); ok {
			st.ino = sys.Ino
			st.ctime = time.Unix(sys.Ctimespec.Unix()).UnixNano()
		}
		into[p] = st
		return nil
	})
}

// diffScans returns the events FSEvents would report for the change from prev to next,
// sorted by path: created, removed, replaced (a new inode at the path: git's lock file
// renamed onto it), written, or only its attributes changed. A directory reports only
// its creation or removal, as FileEvents does.
func diffScans(prev, next map[string]scanEntry) []fsevents.Event {
	var evs []fsevents.Event
	kind := func(s scanEntry) fsevents.EventFlags {
		if s.dir {
			return fsevents.ItemIsDir
		}
		if s.mode&fs.ModeSymlink != 0 {
			return fsevents.ItemIsSymlink
		}
		return fsevents.ItemIsFile
	}
	for p, n := range next {
		o, ok := prev[p]
		var flags fsevents.EventFlags
		switch {
		case !ok:
			flags = fsevents.ItemCreated
		case o.dir != n.dir || o.ino != n.ino:
			flags = fsevents.ItemRenamed
		case n.dir:
		case o.size != n.size || o.mtime != n.mtime:
			flags = fsevents.ItemModified
		case o.ctime != n.ctime || o.mode != n.mode:
			flags = fsevents.ItemInodeMetaMod
		}
		if flags != 0 {
			evs = append(evs, fsevents.Event{Path: p, Flags: flags | kind(n)})
		}
	}
	for p, o := range prev {
		if _, ok := next[p]; !ok {
			evs = append(evs, fsevents.Event{Path: p, Flags: fsevents.ItemRemoved | kind(o)})
		}
	}
	slices.SortFunc(evs, func(a, b fsevents.Event) int {
		switch {
		case a.Path < b.Path:
			return -1
		case a.Path > b.Path:
			return 1
		}
		return 0
	})
	return evs
}

// fsChanged sends the store what changed on disk under the stream's roots since the
// last call (or the stream's start), as FSEvents would. A test calls it after each
// change it wants the store to see through the stream.
func (h *harness) fsChanged() {
	h.t.Helper()
	if h.fake == nil {
		h.t.Fatal("fsChanged: this harness runs a real FSEvents stream")
	}
	h.fake.changed()
}

// waitStreamRunning waits until the store's stream runs over paths satisfying pred: the
// store has started it, not only computed its paths. Changes made after it returns are
// reported for the new roots.
func (h *harness) waitStreamRunning(what string, pred func([]string) bool) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !pred(h.fake.running()) {
		if time.Now().After(deadline) {
			h.t.Fatalf("stream runs over %v: timed out waiting for %s", h.fake.running(), what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// manualClock arms debouncer timers that fire only when the test calls fire.
type manualClock struct {
	mu      sync.Mutex
	pending []*manualTimer
}

type manualTimer struct {
	f       func()
	stopped bool
}

func (t *manualTimer) Stop() bool {
	was := !t.stopped
	t.stopped = true
	return was
}

func (c *manualClock) after(_ time.Duration, f func()) stopper {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &manualTimer{f: f}
	c.pending = append(c.pending, t)
	return t
}

// fire runs every armed timer (the window passed) and returns how many fired.
func (c *manualClock) fire() int {
	c.mu.Lock()
	ts := c.pending
	c.pending = nil
	c.mu.Unlock()
	n := 0
	for _, t := range ts {
		if !t.stopped {
			t.stopped = true
			t.f()
			n++
		}
	}
	return n
}

func TestDiffScans(t *testing.T) {
	file := scanEntry{ino: 1, size: 2, mtime: 3, ctime: 3, mode: 0o644}
	dir := scanEntry{dir: true, ino: 9, mtime: 3, mode: fs.ModeDir | 0o755}
	with := func(s scanEntry, edit func(*scanEntry)) scanEntry { edit(&s); return s }
	tests := []struct {
		name       string
		prev, next map[string]scanEntry
		want       []fsevents.Event
	}{
		{"nothing changed", map[string]scanEntry{"/r/a": file}, map[string]scanEntry{"/r/a": file}, nil},
		{"created", nil, map[string]scanEntry{"/r/d": dir, "/r/d/a": file}, []fsevents.Event{
			{Path: "/r/d", Flags: fsevents.ItemCreated | fsevents.ItemIsDir},
			{Path: "/r/d/a", Flags: fsevents.ItemCreated | fsevents.ItemIsFile},
		}},
		{"removed", map[string]scanEntry{"/r/a": file}, nil, []fsevents.Event{
			{Path: "/r/a", Flags: fsevents.ItemRemoved | fsevents.ItemIsFile},
		}},
		{"written", map[string]scanEntry{"/r/a": file}, map[string]scanEntry{"/r/a": with(file, func(s *scanEntry) { s.size++ })}, []fsevents.Event{
			{Path: "/r/a", Flags: fsevents.ItemModified | fsevents.ItemIsFile},
		}},
		{"replaced by a rename", map[string]scanEntry{"/r/index": file}, map[string]scanEntry{"/r/index": with(file, func(s *scanEntry) { s.ino = 2 })}, []fsevents.Event{
			{Path: "/r/index", Flags: fsevents.ItemRenamed | fsevents.ItemIsFile},
		}},
		{"chmod", map[string]scanEntry{"/r/a": file}, map[string]scanEntry{"/r/a": with(file, func(s *scanEntry) { s.mode = 0o755 })}, []fsevents.Event{
			{Path: "/r/a", Flags: fsevents.ItemInodeMetaMod | fsevents.ItemIsFile},
		}},
		{"a directory's entries changed: only the entry", map[string]scanEntry{"/r/d": dir}, map[string]scanEntry{"/r/d": with(dir, func(s *scanEntry) { s.mtime = 4 }), "/r/d/a": file}, []fsevents.Event{
			{Path: "/r/d/a", Flags: fsevents.ItemCreated | fsevents.ItemIsFile},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := diffScans(tt.prev, tt.next); !slices.Equal(got, tt.want) {
				t.Errorf("diffScans = %v, want %v", got, tt.want)
			}
		})
	}
}
