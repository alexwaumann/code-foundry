package thread

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
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
	res, err := e.m.ShowHTML(e.ctx(), s.ID, page, "Hello", ShowHTMLOptions{})
	live := res.Item
	if err != nil {
		t.Fatal(err)
	}
	if live.Kind != KindHTML || live.HTML == nil || live.HTML.Path != "hello.html" || live.HTML.BaseDir != e.home || live.HTML.Title != "Hello" {
		t.Fatalf("live item = %+v (html %+v)", live, live.HTML)
	}
	if _, err := e.m.ShowHTML(e.ctx(), s.ID, filepath.Join(e.home, "nope.html"), "", ShowHTMLOptions{}); !errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "thread") || !strings.HasPrefix(err.Error(), "no file at ") {
		t.Fatalf("missing file: err = %v, want ErrNotFound saying no file at the path", err)
	}
	e.restart()
	// again: a second card on purpose (the first is still live: no user message since).
	res, err = e.m.ShowHTML(e.ctx(), s.ID, page, "", ShowHTMLOptions{Again: true})
	stopped := res.Item
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
	if _, err := e.m.ShowHTML(e.ctx(), "s-000000000000", page, "", ShowHTMLOptions{}); err == nil {
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
			res, err := e.m.ShowHTML(e.ctx(), s.ID, page, "", ShowHTMLOptions{})
			it := res.Item
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

// shownHTML: the card of a page shown since the last message the user sent (a queued
// one does not count), matched by the path it shows whether stored relative or not.
func TestLiveHTML(t *testing.T) {
	page := func(id, path, base string) Item {
		return Item{ID: id, Kind: KindHTML, HTML: &HTMLPage{Path: path, BaseDir: base}}
	}
	user := func(id string, queued bool) Item { return Item{ID: id, Kind: KindUserMessage, Queued: queued} }
	text := Item{ID: "a-1", Kind: KindAssistantText}
	tests := []struct {
		name     string
		items    []Item
		anywhere bool
		want     string // the item id, "" for none
	}{
		{"same turn, relative path", []Item{user("u-1", false), page("html-1", "pages/p.html", "/h/w"), text}, false, "html-1"},
		{"same turn, absolute path", []Item{user("u-1", false), page("html-1", "/h/w/pages/p.html", "/elsewhere")}, false, "html-1"},
		{"the newest of two", []Item{page("html-1", "pages/p.html", "/h/w"), page("html-2", "pages/p.html", "/h/w")}, false, "html-2"},
		{"no user message at all", []Item{page("html-1", "pages/p.html", "/h/w")}, false, "html-1"},
		{"a user message since", []Item{page("html-1", "pages/p.html", "/h/w"), user("u-2", false), text}, false, ""},
		{"a queued message since does not count", []Item{page("html-1", "pages/p.html", "/h/w"), user("u-2", true)}, false, "html-1"},
		{"another page", []Item{user("u-1", false), page("html-1", "pages/q.html", "/h/w")}, false, ""},
		{"same name, other folder", []Item{page("html-1", "p.html", "/h/w")}, false, ""},
		{"anywhere: a user message since", []Item{page("html-1", "pages/p.html", "/h/w"), user("u-2", false), text}, true, "html-1"},
		{"anywhere: never shown", []Item{user("u-1", false), page("html-1", "pages/q.html", "/h/w")}, true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := newThreadLog("s", bus.New(), time.Now, tt.items)
			got, ok := log.shownHTML("/h/w/pages/p.html", tt.anywhere)
			if ok != (tt.want != "") || got.ID != tt.want {
				t.Errorf("shownHTML = %q, %t; want %q", got.ID, ok, tt.want)
			}
		})
	}
}

// ShowHTML of a page still live adds no card: it returns that card, renamed when a new
// title is given; again adds one anyway.
func TestShowHTMLReusesTheLiveCard(t *testing.T) {
	e := newEnv(t)
	if err := os.MkdirAll(e.home, 0o755); err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(e.home, "p.html")
	if err := os.WriteFile(page, []byte("<p>hi</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, live := range []bool{true, false} {
		t.Run(fmt.Sprintf("live %t", live), func(t *testing.T) {
			var s Thread
			if live {
				s = e.connected(CreateOptions{NoProject: true})
			} else {
				s = e.create(CreateOptions{NoProject: true})
			}
			first, err := e.m.ShowHTML(e.ctx(), s.ID, page, "Tracker", ShowHTMLOptions{})
			if err != nil || first.Reused || first.Earlier != "" {
				t.Fatalf("first: %+v, err %v", first, err)
			}
			again, err := e.m.ShowHTML(e.ctx(), s.ID, page, "", ShowHTMLOptions{})
			if err != nil || !again.Reused || again.Item.ID != first.Item.ID || again.Item.HTML.Title != "Tracker" {
				t.Fatalf("second: %+v err %v; want the first card, title kept", again, err)
			}
			renamed, err := e.m.ShowHTML(e.ctx(), s.ID, page, "PR tracker", ShowHTMLOptions{})
			if err != nil || !renamed.Reused || renamed.Item.ID != first.Item.ID || renamed.Item.HTML.Title != "PR tracker" || renamed.Item.HTML.Path != "p.html" {
				t.Fatalf("renamed: %+v err %v", renamed, err)
			}
			extra, err := e.m.ShowHTML(e.ctx(), s.ID, page, "", ShowHTMLOptions{Again: true})
			if err != nil || extra.Reused || extra.Item.ID == first.Item.ID || extra.Earlier != first.Item.ID {
				t.Fatalf("again: %+v err %v; want a new card naming the first", extra, err)
			}
			snap, err := e.m.Items(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			n := 0
			for _, it := range snap.Items {
				if it.Kind == KindHTML {
					n++
				}
			}
			if n != 2 {
				t.Errorf("%d html items, want 2", n)
			}
		})
	}
}
