package thread

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestHTMLPage(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	cwd := filepath.Join(home, "proj")
	outside := filepath.Join(root, "elsewhere")
	for _, d := range []string{filepath.Join(cwd, "docs", "dir.html"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p string) string {
		if err := os.WriteFile(p, []byte("<h1>hi</h1>"), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	inCwd := write(filepath.Join(cwd, "docs", "page.html"))
	upper := write(filepath.Join(cwd, "Page.HTM"))
	inHome := write(filepath.Join(home, "loose.html"))
	txt := write(filepath.Join(cwd, "notes.txt"))
	far := write(filepath.Join(outside, "far.html"))
	link := filepath.Join(home, "link.html")
	if err := os.Symlink(far, link); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		path     string
		want     string
		wantErr  error
		wantBase string
	}{
		{"inside the cwd is relative", inCwd, "docs/page.html", nil, cwd},
		{"an .HTM extension in any case", upper, "Page.HTM", nil, cwd},
		{"outside the cwd stays absolute", inHome, inHome, nil, cwd},
		{"a relative path", "docs/page.html", "", ErrInvalidArgument, ""},
		{"not html", txt, "", ErrInvalidArgument, ""},
		{"outside home", far, "", ErrInvalidArgument, ""},
		{"a symlink out of home", link, "", ErrInvalidArgument, ""},
		{"a directory", filepath.Join(cwd, "docs", "dir.html"), "", ErrInvalidArgument, ""},
		{"missing", filepath.Join(cwd, "gone.html"), "", ErrNotFound, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := htmlPage(home, cwd, tt.path, " Hello ")
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Path != tt.want || got.BaseDir != tt.wantBase || got.Title != "Hello" {
				t.Errorf("got %+v, want path %q base %q title Hello", got, tt.want, tt.wantBase)
			}
		})
	}
}

// ShowHTML puts the item in a running thread's log through its runner and in a stopped
// one's directly; both persist and come back after a restart.
func TestShowHTMLLiveStoppedAndRestart(t *testing.T) {
	e := newEnv(t)
	if err := os.MkdirAll(e.home, 0o755); err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(e.home, "hello.html")
	if err := os.WriteFile(page, []byte("<p>hello</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := e.connected(CreateOptions{NoProject: true})
	live, err := e.m.ShowHTML(e.ctx(), s.ID, page, "Hello")
	if err != nil {
		t.Fatal(err)
	}
	if live.Kind != KindHTML || live.HTML == nil || live.HTML.Path != "hello.html" || live.HTML.BaseDir != e.home || live.HTML.Title != "Hello" {
		t.Fatalf("live item = %+v (html %+v)", live, live.HTML)
	}
	if _, err := e.m.ShowHTML(e.ctx(), s.ID, filepath.Join(e.home, "nope.html"), ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing file: err = %v, want ErrNotFound", err)
	}
	e.restart()
	stopped, err := e.m.ShowHTML(e.ctx(), s.ID, page, "")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.Ordinal <= live.Ordinal {
		t.Errorf("stopped item ordinal %d not after the live one's %d", stopped.Ordinal, live.Ordinal)
	}
	e.restart()
	snap, err := e.m.Items(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []Item
	for _, it := range snap.Items {
		if it.Kind == KindHTML {
			got = append(got, it)
		}
	}
	if len(got) != 2 || got[0].ID != live.ID || got[1].ID != stopped.ID || got[0].HTML.Title != "Hello" || got[1].HTML.Path != "hello.html" {
		t.Fatalf("reloaded html items = %+v", got)
	}
	if _, err := e.m.ShowHTML(e.ctx(), "s-000000000000", page, ""); err == nil {
		t.Fatal("unknown thread: no error")
	}
}
