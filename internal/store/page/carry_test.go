package page

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/pagestorage"
)

// carryEnv is an env whose store also carries the threads' own storage (ThreadStorageRoot).
func carryEnv(t *testing.T) (*env, string) {
	t.Helper()
	e := newEnv(t)
	threads := filepath.Join(e.home, ".code-foundry", "page-storage")
	e.reopen = func() {
		s, err := New(context.Background(), Options{
			DB: e.db, Home: e.home, PagesRoot: e.pages, StorageRoot: e.storage, ThreadStorageRoot: threads,
			ThreadExists: func(id string) bool { return !e.gone[id] },
			Now:          func() time.Time { e.now = e.now.Add(time.Millisecond); return e.now },
		})
		if err != nil {
			t.Fatal(err)
		}
		e.s = s
	}
	return e, threads
}

// writeStorage writes vals as the storage in dir, last written at.
func writeStorage(t *testing.T, dir string, vals map[string]string, at time.Time) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw := map[string]json.RawMessage{}
	for k, v := range vals {
		raw[k] = json.RawMessage(v)
	}
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, pagestorage.File)
	if err := os.WriteFile(f, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(f, at, at); err != nil {
		t.Fatal(err)
	}
}

// pageStorage writes vals as the stored data of the page at real (as a daemon of before did
// for an allowed page no thread owned), last written at.
func (e *env) pageStorage(real string, vals map[string]string, at time.Time) {
	e.t.Helper()
	dir := e.s.storageDir(real)
	writeStorage(e.t, dir, vals, at)
	if err := pagestorage.WriteAtomic(filepath.Join(dir, pathFile), []byte(real)); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) carryRow(path, thread string, record bool, at int64) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT OR REPLACE INTO page_storage_carry (path, thread_id, record, at) VALUES (?, ?, ?, ?)`, path, thread, record, at); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) stored(real string) map[string]string {
	e.t.Helper()
	dir, _ := e.s.storageOf(real)
	vals, err := pagestorage.Read(dir, e.s.o.Log)
	if err != nil {
		e.t.Fatal(err)
	}
	return pagestorage.Text(vals)
}

// The threads' own page storage is carried into each page it may hold data of, once, at the
// daemon's start: what wins a key both hold is the storage written last, the page's own among
// equals; keys only one holds are all kept; the thread's storage is never rewritten; the page's
// storage before is kept beside it once; a row carried is crossed off, and carrying it again
// (a crash before the rows went) gives the same result.
func TestCarry(t *testing.T) {
	old, mid, late := time.Unix(1_000_000, 0), time.Unix(2_000_000, 0), time.Unix(3_000_000, 0)
	for _, tt := range []struct {
		name string
		// blobs are the threads' own storage, by thread, written at blobAt.
		blobs  map[string]map[string]string
		blobAt map[string]time.Time
		// own is the page's own storage (an allowed page no thread owned), written ownAt.
		own   map[string]string
		ownAt time.Time
		rows  func(e *env, page string)
		want  map[string]string
	}{
		{
			name:  "a thread's storage into the page it owns",
			blobs: map[string]map[string]string{"t-a": {"board:n": "5", "other:n": "7"}}, blobAt: map[string]time.Time{"t-a": mid},
			rows: func(e *env, page string) { e.carryRow(page, "t-a", false, 1) },
			want: map[string]string{"board:n": "5", "other:n": "7"},
		},
		{
			name:  "the thread's storage written last wins a key both hold",
			blobs: map[string]map[string]string{"t-a": {"n": "5", "a": "1"}}, blobAt: map[string]time.Time{"t-a": late},
			own: map[string]string{"n": "3", "cards": `["plan trip"]`}, ownAt: mid,
			rows: func(e *env, page string) { e.carryRow(page, "t-a", false, 1) },
			want: map[string]string{"n": "5", "a": "1", "cards": `["plan trip"]`},
		},
		{
			name:  "the page's own written last wins",
			blobs: map[string]map[string]string{"t-a": {"n": "5"}}, blobAt: map[string]time.Time{"t-a": old},
			own: map[string]string{"n": "3"}, ownAt: mid,
			rows: func(e *env, page string) { e.carryRow(page, "t-a", false, 1) },
			want: map[string]string{"n": "3"},
		},
		{
			name:  "the page's own among equals",
			blobs: map[string]map[string]string{"t-a": {"n": "5"}}, blobAt: map[string]time.Time{"t-a": mid},
			own: map[string]string{"n": "3"}, ownAt: mid,
			rows: func(e *env, page string) { e.carryRow(page, "t-a", false, 1) },
			want: map[string]string{"n": "3"},
		},
		{
			name:   "two threads: the one written last wins",
			blobs:  map[string]map[string]string{"t-a": {"n": "1", "a": "1"}, "t-b": {"n": "2", "b": "2"}},
			blobAt: map[string]time.Time{"t-a": late, "t-b": mid},
			rows: func(e *env, page string) {
				e.carryRow(page, "t-b", false, 1)
				e.carryRow(page, "t-a", false, 1)
			},
			want: map[string]string{"n": "1", "a": "1", "b": "2"},
		},
		{
			name:  "a page the thread showed before owners were kept: it owns it now",
			blobs: map[string]map[string]string{"t-b": {"n": "9"}}, blobAt: map[string]time.Time{"t-b": mid},
			rows: func(e *env, page string) { e.carryRow(page, "t-b", true, 42) },
			want: map[string]string{"n": "9"},
		},
		{
			name: "a thread with no storage carries nothing",
			rows: func(e *env, page string) { e.carryRow(page, "t-a", false, 1) },
			want: map[string]string{},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e, threads := carryEnv(t)
			page := real(t, e.file(e.home, "notes/board.html"))
			for id, vals := range tt.blobs {
				writeStorage(t, filepath.Join(threads, id), vals, tt.blobAt[id])
			}
			blobBytes := map[string][]byte{}
			for id := range tt.blobs {
				b, err := os.ReadFile(filepath.Join(threads, id, pagestorage.File))
				if err != nil {
					t.Fatal(err)
				}
				blobBytes[id] = b
			}
			if tt.own != nil {
				e.pageStorage(page, tt.own, tt.ownAt)
			}
			tt.rows(e, page)
			e.reopen()
			if got := e.stored(page); !maps.Equal(got, tt.want) {
				t.Fatalf("storage %v, want %v", got, tt.want)
			}
			var left int
			if err := e.db.QueryRow(`SELECT count(*) FROM page_storage_carry`).Scan(&left); err != nil || left != 0 {
				t.Fatalf("rows left %d, %v", left, err)
			}
			for id, b := range blobBytes {
				if got, _ := os.ReadFile(filepath.Join(threads, id, pagestorage.File)); string(got) != string(b) {
					t.Errorf("thread %s's own storage was rewritten: %s", id, got)
				}
			}
			dir, _ := e.s.storageOf(page)
			backup, err := os.ReadFile(filepath.Join(dir, BeforeCarryFile))
			switch {
			case tt.own != nil && !maps.Equal(tt.own, tt.want):
				var was map[string]json.RawMessage
				if err != nil || json.Unmarshal(backup, &was) != nil || !maps.Equal(pagestorage.Text(was), tt.own) {
					t.Errorf("the page's storage before: %s, %v; want %v", backup, err, tt.own)
				}
			case !errors.Is(err, os.ErrNotExist):
				t.Errorf("a copy of before when nothing of the page's changed: %s, %v", backup, err)
			}

			// A crash before the rows went: carrying again gives the same, and the copy of before stays the first.
			tt.rows(e, page)
			e.reopen()
			if got := e.stored(page); !maps.Equal(got, tt.want) {
				t.Fatalf("carried again: %v, want %v", got, tt.want)
			}
			if again, _ := os.ReadFile(filepath.Join(dir, BeforeCarryFile)); string(again) != string(backup) {
				t.Errorf("the copy of before changed: %s, was %s", again, backup)
			}
		})
	}
}

// A row with record makes its thread an owner, first shown when its conversation showed the
// page; one of a page that is gone records nothing; a pages directory row carries into every
// page in it, and a page the thread owns that is away now keeps its storage under its key.
func TestCarryOwnersAndPages(t *testing.T) {
	ctx := context.Background()
	e, threads := carryEnv(t)
	if err := e.s.Record(ctx, "t-a", e.file(e.home, "notes/board.html"), Shown); err != nil {
		t.Fatal(err)
	}
	board := real(t, filepath.Join(e.home, "notes/board.html"))
	one := real(t, e.file(e.pages, "t-b/one.html"))
	two := real(t, e.file(e.pages, "t-b/sub/two.htm"))
	e.file(e.pages, "t-b/notes.txt")
	away := filepath.Join(real(t, e.home), "branch/away.html")
	writeStorage(t, filepath.Join(threads, "t-b"), map[string]string{"k": "1"}, time.Unix(2_000_000, 0))
	e.carryRow(board, "t-b", true, 7)
	e.carryRow(filepath.Join(e.home, "notes/missing.html"), "t-b", true, 8)
	e.carryRow("", "t-b", false, 0)
	e.carryRow(away, "t-b", false, 9)
	e.reopen()

	a := e.access(board)
	if !slices.Equal(a.Owners, []Owner{{"t-b", Shown}, {"t-a", Shown}}) {
		t.Errorf("owners %v; want t-b first (it showed the page at 7, before t-a's record)", a.Owners)
	}
	for _, p := range []string{board, one, two, away} {
		if got := e.stored(p); got["k"] != "1" {
			t.Errorf("%s: %v; want t-b's storage", p, got)
		}
	}
	var n int
	if err := e.db.QueryRow(`SELECT count(*) FROM page_owners WHERE path LIKE '%missing.html'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("a missing page recorded: %d, %v", n, err)
	}
	if err := e.db.QueryRow(`SELECT count(*) FROM page_storage_carry`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows left %d, %v", n, err)
	}
}

// A merge over the limit leaves out the keys only the oldest storages hold, newest kept.
func TestCarryOverTheLimit(t *testing.T) {
	big := `"` + strings.Repeat("x", 100<<10) + `"`
	srcs := []*carrySource{
		{vals: map[string]json.RawMessage{"old1": json.RawMessage(big), "shared": json.RawMessage("1")}, at: time.Unix(1, 0)},
		{vals: map[string]json.RawMessage{"mid": json.RawMessage(big), "shared": json.RawMessage("2")}, at: time.Unix(2, 0)},
		{vals: map[string]json.RawMessage{"own": json.RawMessage(big)}, at: time.Unix(3, 0), own: true},
	}
	got := mergeCarry(srcs)
	keys := slices.Sorted(maps.Keys(got))
	if !slices.Equal(keys, []string{"mid", "own", "shared"}) || string(got["shared"]) != "2" {
		t.Fatalf("kept %v (shared %s); want the newest two storages' keys", keys, got["shared"])
	}
	if n := storageSize(got); n > pagestorage.Max {
		t.Fatalf("size %d over the limit", n)
	}
}

// A removed thread's pages-directory pages lose their storage with the directory; a page
// elsewhere keeps its storage for its other owners.
func TestThreadRemovedStorage(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	own := e.file(e.pages, "t-a/report.html")
	other := e.file(e.home, "notes/board.html")
	theirs := e.file(e.pages, "t-b/x.html")
	for _, p := range []string{own, other, theirs} {
		if err := e.s.Record(ctx, "t-a", p, Shown); err != nil {
			t.Fatal(err)
		}
		if _, err := e.s.SetStorage(ctx, p, "k", strp("1")); err != nil {
			t.Fatal(err)
		}
	}
	e.s.ThreadRemoved("t-a")
	for _, tt := range []struct {
		path string
		kept bool
	}{{own, false}, {other, true}, {theirs, true}} {
		dir, _ := e.s.storageOf(real(t, tt.path))
		_, err := os.Stat(dir)
		if kept := err == nil; kept != tt.kept {
			t.Errorf("%s: storage kept %v, want %v", tt.path, kept, tt.kept)
		}
	}
}
