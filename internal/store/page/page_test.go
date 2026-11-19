package page

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/pagestorage"
)

type env struct {
	t       *testing.T
	db      *sql.DB
	home    string
	pages   string
	storage string
	outside string
	gone    map[string]bool // threads ThreadExists says are removed
	now     time.Time
	s       *Store
	// reopen makes the store anew with other options (carryEnv).
	reopen func()
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, db: dbtest.Open(t), home: t.TempDir(), outside: t.TempDir(), gone: map[string]bool{}, now: time.UnixMilli(1000)}
	e.pages = filepath.Join(e.home, ".code-foundry", "pages")
	e.storage = filepath.Join(e.home, ".code-foundry", "page-file-storage")
	for _, q := range []string{
		`INSERT INTO projects (id, path, name, registered_at) VALUES ('web', '/web', 'web', 0)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('t-a', 'web', '/web', 1, 4)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('t-b', 'web', '/web', 1, 4)`,
	} {
		if _, err := e.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	e.open()
	return e
}

// open makes the store anew over the same database and directories (a daemon restart).
func (e *env) open() {
	e.t.Helper()
	s, err := New(context.Background(), Options{
		DB: e.db, Home: e.home, PagesRoot: e.pages, StorageRoot: e.storage,
		Guarded:      func(p string) bool { return strings.Contains(p, "/secret/") },
		ThreadExists: func(id string) bool { return !e.gone[id] },
		Now:          func() time.Time { e.now = e.now.Add(time.Millisecond); return e.now },
	})
	if err != nil {
		e.t.Fatal(err)
	}
	e.s = s
}

// file writes a file under root at rel and returns its path.
func (e *env) file(root, rel string) string {
	e.t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("<p>hi</p>"), 0o600); err != nil {
		e.t.Fatal(err)
	}
	return p
}

func real(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func (e *env) access(p string) Access {
	e.t.Helper()
	a, err := e.s.Access(context.Background(), p)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

func TestResolve(t *testing.T) {
	e := newEnv(t)
	page := e.file(e.home, "proj/index.html")
	upper := e.file(e.home, "proj/README.HTM")
	e.file(e.home, "proj/notes.txt")
	e.file(e.home, "secret/x.html")
	out := e.file(e.outside, "out.html")
	if err := os.MkdirAll(filepath.Join(e.home, "dir.html"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(page, filepath.Join(e.home, "link.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(e.home, "escape.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(e.home, "secret/x.html"), filepath.Join(e.home, "proj/guarded.html")); err != nil {
		t.Fatal(err)
	}
	inPages := e.file(e.pages, "t-a/report.html")
	for _, tt := range []struct {
		name, path, want string
		err              error
	}{
		{"a page under home", page, real(t, page), nil},
		{"upper-case extension", upper, real(t, upper), nil},
		{"a link to a page under home is the page", filepath.Join(e.home, "link.html"), real(t, page), nil},
		{"a thread's pages directory", inPages, real(t, inPages), nil},
		{"relative", "proj/index.html", "", ErrInvalidArgument},
		{"empty", "", "", ErrInvalidArgument},
		{"not html", filepath.Join(e.home, "proj/notes.txt"), "", ErrInvalidArgument},
		{"missing", filepath.Join(e.home, "proj/nope.html"), "", ErrNotFound},
		{"outside home", out, "", ErrInvalidArgument},
		{"a link out of home", filepath.Join(e.home, "escape.html"), "", ErrInvalidArgument},
		{"guarded", filepath.Join(e.home, "secret/x.html"), "", ErrGuarded},
		{"a link into a guarded folder", filepath.Join(e.home, "proj/guarded.html"), "", ErrGuarded},
		{"a directory", filepath.Join(e.home, "dir.html"), "", ErrInvalidArgument},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := e.s.Resolve(tt.path)
			if !errors.Is(err, tt.err) || got != tt.want {
				t.Fatalf("Resolve(%q) = %q, %v; want %q, %v", tt.path, got, err, tt.want, tt.err)
			}
		})
	}
}

// Every thread that shows or writes a page owns it, whichever spelling it used, in the
// order each first did; the first stays the page's default however often others show or
// write it, and a thread showing it again keeps its place with its latest how. A refused path
// and an unknown thread record nothing. (ownership fuzz #1 and #2: one row per page, latest
// wins, lost the earlier owners.)
func TestRecordKeepsEveryOwner(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	p := e.file(e.home, "proj/index.html")
	link := filepath.Join(e.home, "link.html")
	if err := os.Symlink(p, link); err != nil {
		t.Fatal(err)
	}
	if a := e.access(p); a.Owner != "" || a.Allowed() {
		t.Fatalf("before any record: %+v", a)
	}
	steps := []struct {
		id, path, how string
		want          []Owner
	}{
		{"t-a", p, Shown, []Owner{{"t-a", Shown}}},
		{"t-b", link, Written, []Owner{{"t-a", Shown}, {"t-b", Written}}},
		{"t-a", link, Written, []Owner{{"t-a", Written}, {"t-b", Written}}},
		{"t-b", p, Shown, []Owner{{"t-a", Written}, {"t-b", Shown}}},
	}
	for i, st := range steps {
		if err := e.s.Record(ctx, st.id, st.path, st.how); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		a := e.access(link)
		if !slices.Equal(a.Owners, st.want) || a.Owner != "t-a" || a.How() != st.want[0].How || a.Path != real(t, p) || !a.Allowed() {
			t.Fatalf("step %d: %+v, want owners %v", i, a, st.want)
		}
		if !a.Owns(st.id) || a.Owns("t-nope") || a.Owns("") {
			t.Fatalf("step %d: Owns", i)
		}
	}
	if err := e.s.Record(ctx, "t-nope", p, Shown); err == nil {
		t.Fatal("an unknown thread was recorded")
	}
	if err := e.s.Record(ctx, "t-a", filepath.Join(e.home, "proj/missing.html"), Shown); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a missing file: %v", err)
	}
	if a := e.access(p); len(a.Owners) != 2 {
		t.Fatalf("after refused records: %+v", a)
	}
	var n int
	if err := e.db.QueryRow(`SELECT count(*) FROM page_owners`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("rows %d, %v; want one per owner of the page", n, err)
	}
}

// A removed thread's claims go with its row: the page keeps its other owners, the next
// becoming its default, and only a page with none left is no one's and falls back to the
// user's answer. One whose row is still there but which the thread store says is removed
// reads as gone too. (ownership fuzz #2, thread-pages #2.)
func TestRemovedThreadLeavesOtherOwners(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	p := e.file(e.home, "proj/index.html")
	q := e.file(e.home, "proj/other.html")
	for _, r := range []struct{ id, path string }{{"t-a", p}, {"t-b", p}, {"t-b", q}} {
		if err := e.s.Record(ctx, r.id, r.path, Shown); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.s.SetConsent(ctx, p, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`DELETE FROM threads WHERE id = 't-a'`); err != nil {
		t.Fatal(err)
	}
	if a := e.access(p); a.Owner != "t-b" || !slices.Equal(a.Owners, []Owner{{"t-b", Shown}}) {
		t.Fatalf("after its first owner's removal: %+v; want t-b", a)
	}
	e.gone["t-b"] = true
	for _, path := range []string{p, q} {
		a := e.access(path)
		if a.Owner != "" || len(a.Owners) != 0 {
			t.Fatalf("%s with no owner left: %+v", path, a)
		}
	}
	if a := e.access(p); a.Consent != Allowed || !a.Allowed() {
		t.Fatalf("p falls back to the user's answer: %+v", a)
	}
	if a := e.access(q); a.Allowed() {
		t.Fatalf("q was never allowed: %+v", a)
	}
}

func TestPagesDirectory(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	own := e.file(e.pages, "t-a/report.html")
	welcome := e.file(e.pages, "welcome.html")
	gone := e.file(e.pages, "t-gone/old.html")
	e.gone["t-gone"] = true
	for _, tt := range []struct {
		name, path, owner, pagesThread string
	}{
		{"its own", own, "t-a", "t-a"},
		{"the welcome page is no thread's", welcome, "", ""},
		{"a removed thread's", gone, "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if a := e.access(tt.path); a.Owner != tt.owner || a.PagesThread != tt.pagesThread || (tt.owner != "" && a.How() != PagesDirectory) {
				t.Fatalf("%+v; want owner %q", a, tt.owner)
			}
		})
	}
	// Another thread that shows it owns it too; the directory's thread stays first, and
	// its own show keeps it first with how it did.
	if err := e.s.Record(ctx, "t-b", own, Shown); err != nil {
		t.Fatal(err)
	}
	if a := e.access(own); a.Owner != "t-a" || !slices.Equal(a.Owners, []Owner{{"t-a", PagesDirectory}, {"t-b", Shown}}) {
		t.Fatalf("after t-b showed it: %+v", a)
	}
	if err := e.s.Record(ctx, "t-a", own, Written); err != nil {
		t.Fatal(err)
	}
	if a := e.access(own); !slices.Equal(a.Owners, []Owner{{"t-a", Written}, {"t-b", Shown}}) {
		t.Fatalf("after t-a wrote it: %+v", a)
	}
}

// The user's answer is kept per file (resolved), changes both ways, survives a restart and an
// edit of the file, and counts only while no thread owns the page.
func TestConsent(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	p := e.file(e.home, "proj/index.html")
	link := filepath.Join(e.home, "link.html")
	if err := os.Symlink(p, link); err != nil {
		t.Fatal(err)
	}
	for i, st := range []struct {
		path    string
		allowed bool
		want    Consent
	}{
		{p, false, Refused},
		{link, true, Allowed},
		{p, false, Refused},
		{p, true, Allowed},
	} {
		a, err := e.s.SetConsent(ctx, st.path, st.allowed)
		if err != nil || a.Consent != st.want || a.Allowed() != st.allowed {
			t.Fatalf("step %d: %+v, %v; want %v", i, a, err, st.want)
		}
	}
	if err := os.WriteFile(p, []byte("<p>changed</p>"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.open()
	if a := e.access(link); a.Consent != Allowed {
		t.Fatalf("after an edit and a restart: %+v", a)
	}
	for _, bad := range []string{filepath.Join(e.home, "secret/x.html"), filepath.Join(e.home, "proj/missing.html")} {
		if bad == filepath.Join(e.home, "secret/x.html") {
			e.file(e.home, "secret/x.html")
		}
		if _, err := e.s.SetConsent(ctx, bad, true); err == nil {
			t.Fatalf("%s: answered", bad)
		}
	}
	var n int
	if err := e.db.QueryRow(`SELECT count(*) FROM page_consent`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows %d, %v; want only the page's", n, err)
	}
}

func TestAllow(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	owned := e.file(e.home, "a/owned.html")
	if err := e.s.Record(ctx, "t-a", owned, Written); err != nil {
		t.Fatal(err)
	}
	refusedOwned := e.file(e.home, "a/refused-owned.html")
	if err := e.s.Record(ctx, "t-a", refusedOwned, Shown); err != nil {
		t.Fatal(err)
	}
	allowed, refused, asked := e.file(e.home, "a/allowed.html"), e.file(e.home, "a/refused.html"), e.file(e.home, "a/new.html")
	for p, ok := range map[string]bool{allowed: true, refused: false, refusedOwned: false} {
		if _, err := e.s.SetConsent(ctx, p, ok); err != nil {
			t.Fatal(err)
		}
	}
	for _, tt := range []struct {
		name, path string
		err        error
	}{
		{"owned", owned, nil},
		{"owned, though refused once", refusedOwned, nil},
		{"allowed", allowed, nil},
		{"refused", refused, ErrRefused},
		{"not asked", asked, ErrNotAsked},
		{"outside home", e.file(e.outside, "x.html"), ErrInvalidArgument},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := e.s.Allow(ctx, tt.path); !errors.Is(err, tt.err) {
				t.Fatalf("Allow: %v; want %v", err, tt.err)
			}
		})
	}
}

func strp(s string) *string { return &s }

func TestStorage(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	p := e.file(e.home, "proj/index.html")
	if _, err := e.s.SetStorage(ctx, p, "k", strp("1")); !errors.Is(err, ErrNotAsked) {
		t.Fatalf("not asked: %v", err)
	}
	if _, err := e.s.Storage(ctx, p); !errors.Is(err, ErrNotAsked) {
		t.Fatalf("not asked: %v", err)
	}
	if _, err := e.s.SetConsent(ctx, p, true); err != nil {
		t.Fatal(err)
	}
	big := `"` + strings.Repeat("x", pagestorage.Max) + `"`
	for _, tt := range []struct {
		name, key string
		value     *string
		want      map[string]string
		err       error
	}{
		{"set", "k", strp(`{"a":1}`), map[string]string{"k": `{"a":1}`}, nil},
		{"another", "n", strp("2"), map[string]string{"k": `{"a":1}`, "n": "2"}, nil},
		{"remove", "n", nil, map[string]string{"k": `{"a":1}`}, nil},
		{"remove a missing key", "z", nil, map[string]string{"k": `{"a":1}`}, nil},
		{"no key", "", strp("1"), nil, ErrInvalidArgument},
		{"a too long key", strings.Repeat("k", pagestorage.KeyMax+1), strp("1"), nil, ErrInvalidArgument},
		{"not JSON", "k", strp("{"), nil, ErrInvalidArgument},
		{"too big", "big", &big, nil, ErrInvalidArgument},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := e.s.SetStorage(ctx, p, tt.key, tt.value)
			if !errors.Is(err, tt.err) {
				t.Fatalf("SetStorage: %v; want %v", err, tt.err)
			}
			if err == nil && !equal(got, tt.want) {
				t.Fatalf("SetStorage = %v; want %v", got, tt.want)
			}
		})
	}
	// Through a link, after a restart: the same page's storage.
	link := filepath.Join(e.home, "link.html")
	if err := os.Symlink(p, link); err != nil {
		t.Fatal(err)
	}
	e.open()
	if got, err := e.s.Storage(ctx, link); err != nil || !equal(got, map[string]string{"k": `{"a":1}`}) {
		t.Fatalf("after a restart: %v, %v", got, err)
	}
	// Refused later: the daemon refuses it, and keeps what was stored.
	if _, err := e.s.SetConsent(ctx, p, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Storage(ctx, p); !errors.Is(err, ErrRefused) {
		t.Fatalf("refused: %v", err)
	}
	if _, err := e.s.SetStorage(ctx, p, "k", strp("3")); !errors.Is(err, ErrRefused) {
		t.Fatalf("refused: %v", err)
	}
	if _, err := e.s.SetConsent(ctx, p, true); err != nil {
		t.Fatal(err)
	}
	if got, err := e.s.Storage(ctx, p); err != nil || got["k"] != `{"a":1}` {
		t.Fatalf("allowed again: %v, %v", got, err)
	}
}

// A page's storage goes at a start once its file has been gone and unwritten for
// SweepAfter; before that it stays (the file may only be away); another page's stays.
func TestSweep(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	keep, gone := e.file(e.home, "keep.html"), e.file(e.home, "gone.html")
	for _, p := range []string{keep, gone} {
		if _, err := e.s.SetConsent(ctx, p, true); err != nil {
			t.Fatal(err)
		}
		if _, err := e.s.SetStorage(ctx, p, "k", strp("1")); err != nil {
			t.Fatal(err)
		}
	}
	stray := filepath.Join(e.storage, "stray")
	if err := os.MkdirAll(stray, 0o700); err != nil {
		t.Fatal(err)
	}
	goneDir := e.s.storageDir(real(t, gone))
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	e.now = time.Now()
	e.open()
	for dir, want := range map[string]bool{e.s.storageDir(real(t, keep)): true, goneDir: true, stray: false} {
		if _, err := os.Stat(dir); (err == nil) != want {
			t.Errorf("gone a moment, %s: exists %v, want %v", dir, err == nil, want)
		}
	}
	e.now = time.Now().Add(SweepAfter + time.Hour)
	e.open()
	for dir, want := range map[string]bool{e.s.storageDir(real(t, keep)): true, goneDir: false, stray: false} {
		if _, err := os.Stat(dir); (err == nil) != want {
			t.Errorf("%s: exists %v, want %v", dir, err == nil, want)
		}
	}
	// The file back at its path: the same page, its answer kept, its storage empty.
	e.file(e.home, "gone.html")
	if got, err := e.s.Storage(ctx, gone); err != nil || len(got) != 0 {
		t.Fatalf("back: %v, %v", got, err)
	}
}

func equal(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
