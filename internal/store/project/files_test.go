package project

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"
)

func TestTreeFile(t *testing.T) {
	tests := []struct {
		path string
		want string // "" = left out
	}{
		{"/w/a.go", "a.go"},
		{"/w/src/deep/x_test.go", "src/deep/x_test.go"},
		{"/w/Cargo.lock", "Cargo.lock"},
		{"/w", ""},
		{"/other/a.go", ""},
		{"/w/.git", ""},                    // a linked worktree's .git file
		{"/w/vendor/dep/.git/index", ""},   // a nested repository's git dir
		{"/w/sub/.git/modules/x/HEAD", ""}, // anything below a .git
		{"/w/.github/workflows/ci.yml", ".github/workflows/ci.yml"},
		{"/w/x.git", "x.git"},
	}
	for _, tt := range tests {
		got, ok := treeFile("/w", tt.path)
		if ok != (tt.want != "") || got != tt.want {
			t.Errorf("treeFile(%q) = %q, %v; want %q", tt.path, got, ok, tt.want)
		}
	}
}

func TestFileOpFor(t *testing.T) {
	tests := []struct {
		name                string
		o                   op
		exists, seen, fresh bool
		want                FileOp
	}{
		{"new file", opCreate, true, false, true, FileCreated},
		{"created then written", opCreate | opWrite, true, false, true, FileCreated},
		{"created then removed", opCreate | opRemove, false, false, true, FileRemoved},
		{"written then removed", opWrite | opRemove, false, true, false, FileRemoved},
		{"removed then recreated", opRemove | opCreate, true, false, true, FileCreated},
		{"edit", opWrite, true, false, false, FileModified},
		{"edit of a reported file, stale create flag", opCreate | opWrite, true, true, false, FileModified},
		{"edit of an unreported older file, stale create flag", opCreate | opWrite, true, false, false, FileModified},
		{"renamed in", opRename, true, false, false, FileRenamed},
		{"renamed in, stale create flag", opCreate | opRename, true, false, false, FileRenamed},
		{"renamed away", opRename, false, true, false, FileRemoved},
		{"renamed onto a reported file", opRename | opCreate, true, true, true, FileModified},
		{"created then renamed in (atomic save)", opCreate | opRename, true, false, true, FileCreated},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := fileOpFor(tt.o, tt.exists, tt.seen, tt.fresh); got != tt.want {
				t.Errorf("fileOpFor(%v, exists=%v, seen=%v, fresh=%v) = %v, want %v", tt.o, tt.exists, tt.seen, tt.fresh, got, tt.want)
			}
		})
	}
}

func TestResolveFiles(t *testing.T) {
	var c fileCollector
	k := filesJob("p", "/w")
	now := time.Unix(1000, 0)
	add := func(rel string, flags fsevents.EventFlags) { c.add(k, rel, flags, now) }
	add("b.go", fsevents.ItemCreated|fsevents.ItemIsFile)
	add("b.go", fsevents.ItemModified|fsevents.ItemIsFile) // one path, merged
	add("a.go", fsevents.ItemModified|fsevents.ItemIsFile)
	add("gone.txt", fsevents.ItemCreated|fsevents.ItemIsFile)
	add("gone.txt", fsevents.ItemRemoved|fsevents.ItemIsFile)
	add("newdir", fsevents.ItemCreated|fsevents.ItemIsDir)          // left out: its files have events
	add("olddir", fsevents.ItemRenamed|fsevents.ItemIsDir)          // renamed away
	add("moved", fsevents.ItemRenamed|fsevents.ItemIsDir)           // renamed in
	add("seen.txt", fsevents.ItemCreated|fsevents.ItemModified)     // reported before
	add("stale.txt", fsevents.ItemCreated|fsevents.ItemModified)    // born a minute ago
	add("untarred.txt", fsevents.ItemCreated|fsevents.ItemModified) // mtime set into the past
	p := c.take(k)
	if c.take(k) != nil {
		t.Fatal("take left the window behind")
	}
	old := now.Add(-time.Minute)
	disk := map[string]fileStat{
		"a.go":         {exists: true, birth: old, mtime: now},
		"b.go":         {exists: true, birth: now.Add(-10 * time.Millisecond), mtime: now},
		"newdir":       {exists: true, dir: true, birth: now, mtime: now},
		"moved":        {exists: true, dir: true, birth: old, mtime: old},
		"seen.txt":     {exists: true, birth: now, mtime: now},
		"stale.txt":    {exists: true, birth: old, mtime: now},
		"untarred.txt": {exists: true, birth: time.Unix(1, 0), mtime: time.Unix(1, 0)},
	}
	seen := map[string]time.Time{"seen.txt": old, "gone.txt": old}
	got := resolveFiles(p, seen, now, func(rel string) fileStat { return disk[rel] })
	want := []ChangedFile{
		{"a.go", FileModified}, {"b.go", FileCreated}, {"gone.txt", FileRemoved},
		{"moved/", FileRenamed}, {"olddir/", FileRemoved}, {"seen.txt", FileModified},
		{"stale.txt", FileModified}, {"untarred.txt", FileCreated},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("resolveFiles =\n%v\nwant\n%v", got, want)
	}
	if _, ok := seen["gone.txt"]; ok {
		t.Error("a removed path stays remembered")
	}
	for _, p := range []string{"a.go", "b.go", "seen.txt", "untarred.txt"} {
		if seen[p] != now {
			t.Errorf("seen[%s] = %v, want now", p, seen[p])
		}
	}
}

func TestCollectorOverflow(t *testing.T) {
	var c fileCollector
	k := filesJob("p", "/w")
	for i := range maxPendingFiles + 10 {
		c.add(k, fmt.Sprintf("f%05d", i), fsevents.ItemCreated, time.Time{})
	}
	c.add(k, "f00000", fsevents.ItemModified, time.Time{}) // a known path still merges
	p := c.take(k)
	if len(p.paths) != maxPendingFiles || !p.overflow {
		t.Fatalf("%d paths, overflow %v", len(p.paths), p.overflow)
	}
	if p.paths["f00000"].ops != opCreate|opWrite {
		t.Errorf("f00000 ops = %v", p.paths["f00000"].ops)
	}
}

func TestCapFiles(t *testing.T) {
	many := make([]ChangedFile, MaxChangedFiles+1)
	tests := []struct {
		name      string
		n         int
		overflow  bool
		wantN     int
		truncated bool
	}{
		{"few", 3, false, 3, false},
		{"exactly the cap", MaxChangedFiles, false, MaxChangedFiles, false},
		{"over the cap", MaxChangedFiles + 1, false, MaxChangedFiles, true},
		{"collector overflowed", 3, true, 3, true},
		{"overflowed, all ignored", 0, true, 0, true},
	}
	for _, tt := range tests {
		got, tr := capFiles(many[:tt.n], tt.overflow)
		if len(got) != tt.wantN || tr != tt.truncated {
			t.Errorf("%s: %d files, truncated %v; want %d, %v", tt.name, len(got), tr, tt.wantN, tt.truncated)
		}
	}
}

func TestSeenOfPrunes(t *testing.T) {
	var c fileCollector
	k := filesJob("p", "/w")
	now := time.Unix(10_000, 0)
	s := c.seenOf(k, now)
	s["old"], s["new"] = now.Add(-seenTTL-time.Second), now
	if s = c.seenOf(k, now); len(s) != 1 || s["new"] != now {
		t.Fatalf("seen = %v", s)
	}
	c.forget(k)
	if s = c.seenOf(k, now); len(s) != 0 {
		t.Fatalf("seen after forget = %v", s)
	}
}

func TestDropIgnored(t *testing.T) {
	isolateGit(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q", "-b", "main")
	writeFile(t, filepath.Join(dir, ".gitignore"), "*.log\nbuild/\nnode_modules\n")
	writeFile(t, filepath.Join(dir, "kept.log"), "tracked despite the pattern\n")
	git(t, dir, "add", ".gitignore")
	git(t, dir, "add", "-f", "kept.log")
	git(t, dir, "commit", "-q", "-m", "init")
	// A submodule: check-ignore refuses its paths.
	sub := filepath.Join(t.TempDir(), "sub")
	git(t, filepath.Dir(sub), "init", "-q", "-b", "main", sub)
	writeFile(t, filepath.Join(sub, "a.txt"), "a\n")
	git(t, sub, "add", ".")
	git(t, sub, "commit", "-q", "-m", "sub")
	git(t, dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mods/sub")

	g := &Git{runner: ExecRunner{}}
	cf := func(paths ...string) []ChangedFile {
		out := make([]ChangedFile, len(paths))
		for i, p := range paths {
			out[i] = ChangedFile{Path: p, Op: FileModified}
		}
		return out
	}
	paths := func(fs []ChangedFile) []string {
		out := make([]string, len(fs))
		for i, f := range fs {
			out[i] = f.Path
		}
		return out
	}
	tests := []struct {
		name string
		in   []ChangedFile
		want []string
	}{
		{"nothing ignored", cf("a.go", "src/b.go"), []string{"a.go", "src/b.go"}},
		{"ignored pattern, tracked file kept", cf("debug.log", "kept.log", "x.go"), []string{"kept.log", "x.go"}},
		{"under ignored dirs, existing or not", cf("build/a/x.o", "gone/build/y", "node_modules/a/b.js", "build/"), nil},
		{"everything ignored", cf("a.log", "b.log"), nil},
		{"submodule paths dropped", cf("a.go", "mods/sub/a.txt", "mods/sub/b.log", "z.go"), []string{"a.go", "z.go"}},
		{"empty", nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := g.dropIgnored(context.Background(), dir, tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if p := paths(got); !slices.Equal(p, tt.want) && (len(p) != 0 || len(tt.want) != 0) {
				t.Fatalf("dropIgnored = %q, want %q", p, tt.want)
			}
		})
	}
}

// filesChanged returns a predicate for the files event of the worktree at path.
func filesChanged(path string, pred func(WorktreeFilesChanged) bool) func(Event) bool {
	return func(ev Event) bool {
		e, ok := ev.(WorktreeFilesChanged)
		return ok && e.Path == path && pred(e)
	}
}

// noFilesEvent fails if a files event for path arrives within d.
func (h *harness) noFilesEvent(path string, d time.Duration) {
	h.t.Helper()
	deadline := time.After(d)
	for {
		select {
		case ev := <-h.sub.C():
			if e, ok := ev.(WorktreeFilesChanged); ok && e.Path == path {
				h.t.Fatalf("unexpected files event %+v", e)
			}
		case <-deadline:
			return
		}
	}
}

// The files job runs only for live worktrees, drops ignored paths, publishes nothing
// when all were ignored, and caps the list. Events are fed to onEvents directly (the
// stream may add its own for the same writes, which merge).
func TestFilesEventLiveOnly(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), f.project)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.project, ".gitignore"), "*.log\n")
	git(t, f.project, "add", ".gitignore")
	git(t, f.project, "commit", "-q", "-m", "ignore")
	ev := func(rel string, flags fsevents.EventFlags) fsevents.Event {
		return fsevents.Event{Path: filepath.Join(f.project, rel), Flags: flags | fsevents.ItemIsFile}
	}
	writeFile(t, filepath.Join(f.project, "a.go"), "package a\n")

	// Idle: nothing.
	h.store.onEvents([]fsevents.Event{ev("a.go", fsevents.ItemCreated)})
	h.noFilesEvent(f.project, 400*time.Millisecond)

	h.store.SetLiveWorktrees([]string{f.project})
	writeFile(t, filepath.Join(f.project, "x.log"), "ignored\n")
	h.store.onEvents([]fsevents.Event{ev("a.go", fsevents.ItemModified), ev("x.log", fsevents.ItemCreated), ev("gone.go", fsevents.ItemRemoved)})
	got := h.waitFor("files event", filesChanged(f.project, func(WorktreeFilesChanged) bool { return true })).(WorktreeFilesChanged)
	want := WorktreeFilesChanged{ProjectID: r.ID, Path: f.project, Files: []ChangedFile{{"a.go", FileModified}, {"gone.go", FileRemoved}}}
	if got.ProjectID != want.ProjectID || !slices.Equal(got.Files, want.Files) || got.Truncated {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// Only ignored paths: nothing.
	h.store.onEvents([]fsevents.Event{ev("x.log", fsevents.ItemModified)})
	h.noFilesEvent(f.project, 400*time.Millisecond)

	// More than the cap: the first 500 by path, truncated.
	var evs []fsevents.Event
	for i := range MaxChangedFiles + 50 {
		evs = append(evs, ev(fmt.Sprintf("gen/f%04d.go", i), fsevents.ItemRemoved))
	}
	h.store.onEvents(evs)
	got = h.waitFor("truncated files event", filesChanged(f.project, func(WorktreeFilesChanged) bool { return true })).(WorktreeFilesChanged)
	if len(got.Files) != MaxChangedFiles || !got.Truncated || got.Files[0].Path != "gen/f0000.go" || got.Files[MaxChangedFiles-1].Path != "gen/f0499.go" {
		t.Fatalf("got %d files (truncated %v), first %v", len(got.Files), got.Truncated, got.Files[0])
	}

	// Not live any more: nothing.
	h.store.SetLiveWorktrees(nil)
	h.store.onEvents([]fsevents.Event{ev("a.go", fsevents.ItemModified)})
	h.noFilesEvent(f.project, 400*time.Millisecond)
}

// Real FSEvents: edits in a live worktree arrive as one files event per window, with
// gitignored and .git paths left out.
func TestStreamFilesEvent(t *testing.T) {
	requireFSEvents(t)
	f := newFixture(t)
	const window = 300 * time.Millisecond
	h := startHarness(t, "", Options{TreeDebounce: window})
	if _, err := h.store.Register(context.Background(), f.project); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.project, ".gitignore"), "bin/\n")
	git(t, f.project, "add", ".gitignore")
	git(t, f.project, "commit", "-q", "-m", "ignore")
	h.store.SetLiveWorktrees([]string{f.project})
	// Let the commit's own events flush, and README.md (written by the fixture) get
	// older than bornSlack: its edit below still carries a stale ItemCreated.
	time.Sleep(bornSlack + 2*window)

	// Collect every files event until the wanted set has been seen.
	want := map[string]FileOp{"README.md": FileModified, "sub/deeper/new.txt": FileCreated, "old.txt": FileCreated}
	if err := os.MkdirAll(filepath.Join(f.project, "bin", "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(f.project, "sub", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.project, "README.md"), "changed\n")
	writeFile(t, filepath.Join(f.project, "sub", "deeper", "new.txt"), "n\n")
	writeFile(t, filepath.Join(f.project, "bin", "x", "out.o"), "ignored\n")
	// An extracted file: its mtime from the archive, which pulls its birth time back.
	writeFile(t, filepath.Join(f.project, "old.txt"), "from an archive\n")
	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(f.project, "old.txt"), past, past); err != nil {
		t.Fatal(err)
	}
	got := map[string]FileOp{}
	deadline := time.After(20 * time.Second)
	for len(got) < len(want) || !mapsSubset(want, got) {
		select {
		case ev := <-h.sub.C():
			e, ok := ev.(WorktreeFilesChanged)
			if !ok || e.Path != f.project {
				continue
			}
			for _, c := range e.Files {
				if strings.HasPrefix(c.Path, "bin/") || strings.Contains(c.Path, ".git/") {
					t.Fatalf("event lists %q: %+v", c.Path, e)
				}
				got[c.Path] = c.Op
			}
		case <-deadline:
			t.Fatalf("files seen %v, want %v", got, want)
		}
	}
	for p, op := range want {
		if got[p] != op {
			t.Errorf("%s: %v, want %v", p, got[p], op)
		}
	}
}

func mapsSubset(want, got map[string]FileOp) bool {
	for k := range want {
		if _, ok := got[k]; !ok {
			return false
		}
	}
	return true
}
