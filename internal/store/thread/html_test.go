package thread

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	if _, err := e.m.ShowHTML(e.ctx(), s.ID, filepath.Join(e.home, "nope.html"), ""); !errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "thread") || !strings.HasPrefix(err.Error(), "no file at ") {
		t.Fatalf("missing file: err = %v, want ErrNotFound saying no file at the path", err)
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

// TestPageOutsideATurnEndsNoTurn: a page shown in a connected thread at its prompt (from
// a terminal or a child, view.inline --thread) is no turn of its own: however the
// process ends afterwards, no "Interrupted" turn end follows it, and the log ends with
// the page (inline-html-2-fixes.md).
func TestPageOutsideATurnEndsNoTurn(t *testing.T) {
	type end func(e *env, s Thread)
	exit := func(e *env, s Thread) { e.exit(s.ID, 0) }
	closeIt := func(e *env, s Thread) {
		if err := e.m.Close(context.Background(), s.ID); err != nil {
			e.t.Fatal(err)
		}
	}
	archive := func(e *env, s Thread) {
		if _, err := e.m.Archive(context.Background(), s.ID, true); err != nil {
			e.t.Fatal(err)
		}
	}
	restart := func(e *env, _ Thread) { e.restart() }
	tests := []struct {
		name  string
		setup statusSetup
		end   end
		turns int // turn ends from results
	}{
		{"idle, then exit", idleSetup, exit, 0},
		{"idle, then close", idleSetup, closeIt, 0},
		{"idle, then archive", idleSetup, archive, 0},
		{"idle, then daemon restart", idleSetup, restart, 0},
		{"after a turn, then exit", finishedSetup, exit, 1},
		{"after a turn, then daemon restart", finishedSetup, restart, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, s := tt.setup.start(t)
			if err := os.MkdirAll(e.home, 0o755); err != nil {
				t.Fatal(err)
			}
			page := filepath.Join(e.home, "page.html")
			if err := os.WriteFile(page, []byte("<p>hi</p>"), 0o644); err != nil {
				t.Fatal(err)
			}
			it, err := e.m.ShowHTML(e.ctx(), s.ID, page, "")
			if err != nil {
				t.Fatal(err)
			}
			tt.end(e, s)
			e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
			items, err := loadItems(context.Background(), e.m.opts.DB, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			results := 0
			for _, x := range items {
				if x.Kind == KindTurnEnd && isSynthTurn(x.Turn) {
					t.Fatalf("a turn end of the daemon's after the page:\n%s", describeItems(items))
				}
				if x.Kind == KindTurnEnd {
					results++
				}
			}
			if results != tt.turns || len(items) == 0 || items[len(items)-1].ID != it.ID {
				t.Errorf("want %d result turn ends and the page last:\n%s", tt.turns, describeItems(items))
			}
		})
	}
}
