package fsx_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/fsx/fsxtest"
)

func TestOnDiskPath(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fsxtest.NeedInsensitive(t, base)
	for _, f := range []string{"Case/Report.html", fsxtest.ResumeNFD + "/Board.html", "plain/page.html"} {
		p := filepath.Join(base, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct{ name, in, want string }{
		{"on-disk spelling kept", "Case/Report.html", "Case/Report.html"},
		{"lower case", "case/report.html", "Case/Report.html"},
		{"upper case", "CASE/REPORT.HTML", "Case/Report.html"},
		{"NFC of an NFD folder", fsxtest.ResumeNFC + "/Board.html", fsxtest.ResumeNFD + "/Board.html"},
		{"NFC and case", "r\u00e9sum\u00c9/board.html", fsxtest.ResumeNFD + "/Board.html"},
		{"plain", "plain/page.html", "plain/page.html"},
		{"missing file keeps its name", "case/gone.html", "Case/gone.html"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, want := fsx.OnDiskPath(filepath.Join(base, tc.in)), filepath.Join(base, tc.want); got != want {
				t.Errorf("OnDiskPath = %q, want %q", got, want)
			}
		})
	}
	if got := fsx.OnDiskPath("relative/x.html"); got != "relative/x.html" {
		t.Errorf("a relative path = %q, want it as given", got)
	}
}

func TestOtherSpelling(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fsxtest.NeedInsensitive(t, base)
	real := filepath.Join(base, "Plan.html")
	if err := os.WriteFile(real, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(base, "Other.html")
	if err := os.WriteFile(other, []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	hard := filepath.Join(base, "hard.html")
	if err := os.Link(real, hard); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, p string
		want    bool
	}{
		{"itself", real, false},
		{"another case", filepath.Join(base, "plan.HTML"), true},
		{"another file", other, false},
		{"a hard link's other name", hard, false},
		{"a name that folds the same but is no file", filepath.Join(base, "plan.htm"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := fsx.OtherSpelling(tc.p, real); got != tc.want {
				t.Errorf("OtherSpelling(%q) = %v, want %v", tc.p, got, tc.want)
			}
		})
	}
}

func TestLikeSpellings(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"/Users/me/a_b%c.html", `/Users/me/a\_b\%c.html`},
		{"/Users/me/" + fsxtest.ResumeNFD + "/b.html", "/Users/me/R%"},
		{"/Users/me/" + fsxtest.ResumeNFC + "/b.html", "/Users/me/%"},
		{"\u00e9", "%"},
	} {
		if got := fsx.LikeSpellings(tc.in); got != tc.want {
			t.Errorf("LikeSpellings(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
