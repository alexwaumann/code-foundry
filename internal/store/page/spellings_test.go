package page

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/fsx/fsxtest"
	"github.com/alexwaumann/code-foundry/internal/pagestorage"
)

// One file is one page however its path is spelled: letter case and NFC or NFD names on a
// volume that ignores both (docs/notes/page-path-identity.md).
func TestSpellingsAreOnePage(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	fsxtest.NeedInsensitive(t, e.home)
	report := real(t, e.file(e.home, "Case/Report.html"))
	board := real(t, e.file(e.home, fsxtest.ResumeNFD+"/Board.html"))
	nfc := filepath.Join(e.home, fsxtest.ResumeNFC, "board.html")

	// An owner recorded under one spelling is the file's under the on-disk one.
	if err := e.s.Record(ctx, "t-a", filepath.Join(e.home, "case/report.html"), Written); err != nil {
		t.Fatal(err)
	}
	if a := e.access(report); a.Owner != "t-a" || a.Path != report {
		t.Errorf("owner under the on-disk spelling: %+v; want t-a's, keyed %s", a, report)
	}
	if a := e.access(filepath.Join(e.home, "CASE/REPORT.HTML")); a.Owner != "t-a" || a.Path != report {
		t.Errorf("owner under upper case: %+v", a)
	}

	// An answer and storage given under NFC are the NFD folder's.
	if _, err := e.s.SetConsent(ctx, nfc, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.SetStorage(ctx, board, "k", strp("1")); err != nil {
		t.Fatal(err)
	}
	if got, err := e.s.Storage(ctx, nfc); err != nil || got["k"] != "1" {
		t.Errorf("storage under NFC: %v, %v; want k=1", got, err)
	}
	if _, err := e.s.SetConsent(ctx, board, false); err != nil {
		t.Fatal(err)
	}
	if a := e.access(nfc); a.Consent != Refused {
		t.Errorf("refused under NFD, under NFC: %v; want refused", a.Consent)
	}

	// A thread's pages directory spelled in upper case is still the thread's.
	own := e.file(e.pages, "t-b/p.html")
	upper := filepath.Join(filepath.Dir(e.pages), "PAGES", "t-b", "p.html")
	if a := e.access(upper); a.PagesThread != "t-b" || a.Path != real(t, own) {
		t.Errorf("upper-case pages root: %+v; want t-b's", a)
	}
}

// A file renamed only in case keeps its answer and storage: the old key is another
// spelling of the same file.
func TestCaseOnlyRename(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	fsxtest.NeedInsensitive(t, e.home)
	old := e.file(e.home, "cr/Plan.html")
	if _, err := e.s.SetConsent(ctx, old, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.SetStorage(ctx, old, "k", strp("1")); err != nil {
		t.Fatal(err)
	}
	renamed := filepath.Join(e.home, "cr", "plan.html")
	if err := os.Rename(old, renamed); err != nil {
		t.Fatal(err)
	}
	if a := e.access(renamed); a.Consent != Allowed || a.Path != real(t, filepath.Dir(renamed))+"/plan.html" {
		t.Errorf("after a case-only rename: %+v; want allowed under plan.html", a)
	}
	if got, err := e.s.Storage(ctx, renamed); err != nil || got["k"] != "1" {
		t.Errorf("storage after a case-only rename: %v, %v", got, err)
	}
	if _, err := e.s.SetConsent(ctx, renamed, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Storage(ctx, old); !errors.Is(err, ErrRefused) {
		t.Errorf("refused under the new name, under the old: %v; want ErrRefused", err)
	}
}

// Rows and storage an older daemon kept under the spelling it was given are found at
// read time, and an answer given now is written to them too, so a revoke always sticks.
func TestRowsUnderOlderSpellings(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	fsxtest.NeedInsensitive(t, e.home)
	board := real(t, e.file(e.home, fsxtest.ResumeNFD+"/Board.html"))
	nfc := filepath.Join(real(t, e.home), fsxtest.ResumeNFC, "board.html")
	lower := filepath.Join(real(t, e.home), fsxtest.ResumeNFD, "board.html")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO page_owners (path, thread_id, how, first_at, updated_at) VALUES (?, 't-b', 'shown', 5, 5)`, []any{lower}},
		{`INSERT INTO page_consent (path, allowed, updated_at) VALUES (?, 1, 5)`, []any{nfc}},
		{`INSERT INTO page_consent (path, allowed, updated_at) VALUES (?, 0, 3)`, []any{lower}},
	} {
		if _, err := e.db.Exec(q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	dir := e.s.storageDir(nfc)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := pagestorage.WriteAtomic(filepath.Join(dir, pathFile), []byte(nfc)); err != nil {
		t.Fatal(err)
	}
	if _, err := pagestorage.Set(dir, "k", strp("1"), "page", e.s.o.Log); err != nil {
		t.Fatal(err)
	}

	a := e.access(board)
	if a.Path != board || !a.Owns("t-b") || a.Consent != Allowed {
		t.Fatalf("older rows: %+v; want t-b's, allowed (the newest answer), keyed %s", a, board)
	}
	e.gone["t-b"] = true
	if got, err := e.s.Storage(ctx, board); err != nil || got["k"] != "1" {
		t.Fatalf("older storage: %v, %v", got, err)
	}
	if _, err := e.s.SetStorage(ctx, board, "n", strp("2")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.s.storageDir(board)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a second storage directory under the on-disk key: %v", err)
	}
	e.open() // Sweep keeps the older spelling's directory: its file is there.
	if got, err := e.s.Storage(ctx, nfc); err != nil || got["n"] != "2" {
		t.Errorf("after a restart: %v, %v", got, err)
	}

	// Stop allowing under the on-disk spelling: every row says so.
	if _, err := e.s.SetConsent(ctx, board, false); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{board, nfc, lower} {
		var allowed bool
		if err := e.db.QueryRow(`SELECT allowed FROM page_consent WHERE path = ?`, p).Scan(&allowed); err != nil || allowed {
			t.Errorf("row %q after the revoke: allowed %v, %v; want refused", p, allowed, err)
		}
		if a := e.access(p); a.Consent != Refused {
			t.Errorf("access under %q after the revoke: %v", p, a.Consent)
		}
	}
	// A row of another file that only looks alike is not this page's.
	other := real(t, e.file(e.home, "Other.html"))
	if _, err := e.db.Exec(`INSERT INTO page_consent (path, allowed, updated_at) VALUES (?, 1, 99999)`, filepath.Join(real(t, e.home), "other.htm")); err != nil {
		t.Fatal(err)
	}
	if a := e.access(other); a.Consent != NotAsked {
		t.Errorf("a look-alike row of no file answered for %s: %v", other, a.Consent)
	}
}
