package daemon

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/db"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// noticeRecorder is a defaultNoticeStore that records the posts, failing while fail is set.
type noticeRecorder struct {
	posts []notification.Post
	fail  bool
}

func (r *noticeRecorder) Post(_ context.Context, p notification.Post) (notification.PostResult, error) {
	if r.fail {
		return notification.PostResult{}, errors.New("store closed")
	}
	r.posts = append(r.posts, p)
	return notification.PostResult{Outcome: notification.OutcomePosted}, nil
}

// One daemon start as openStores runs the step: the settings store opened, the step run
// before the database is, then the database (and so the home exists from now on), then the
// notices once the notification store is up.
func startHome(t *testing.T, home string, notes *noticeRecorder, settingsFile *string) *settings.Store {
	t.Helper()
	path := filepath.Join(home, settings.FileName)
	if settingsFile != nil {
		if err := os.WriteFile(path, []byte(*settingsFile), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	log := slog.New(slog.DiscardHandler)
	st, err := settings.Open(context.Background(), settings.Options{Path: path, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	dbPath := filepath.Join(home, "db.sqlite")
	keepOldDefaults(context.Background(), log, st, dbPath)
	conn, err := db.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	postDefaultNotices(context.Background(), log, st, notes)
	return st
}

// The step at the daemon's start: a new home takes Panes and is told nothing; a home from
// before (it has a database) whose settings do not set the key keeps Tabs and is told once,
// ever; a home whose settings set it is left alone.
func TestDefaultChangeAtStart(t *testing.T) {
	str := func(s string) *string { return &s }
	type start struct {
		file      *string // write the settings file before the start; nil leaves it
		failPost  bool
		want      string
		wantPosts int // posts so far
	}
	tests := []struct {
		name     string
		existing bool // the home has a database from an older daemon
		starts   []start
	}{
		{name: "a new home", starts: []start{
			{want: settings.ThreadsOpenAsPanes},
			{want: settings.ThreadsOpenAsPanes},
		}},
		{name: "an existing home, key unset", existing: true, starts: []start{
			{file: str("[appearance]\nfont_size = 15\n"), want: settings.ThreadsOpenAsTabs, wantPosts: 1},
			{want: settings.ThreadsOpenAsTabs, wantPosts: 1},
		}},
		{name: "an existing home, key set to tabs", existing: true, starts: []start{
			{file: str("[layout]\nthreads_open_as = \"tabs\"\n"), want: settings.ThreadsOpenAsTabs},
		}},
		{name: "an existing home, key set to panes", existing: true, starts: []start{
			{file: str("[layout]\nthreads_open_as = \"panes\"\n"), want: settings.ThreadsOpenAsPanes},
		}},
		{name: "an existing home, key set to single", existing: true, starts: []start{
			{file: str("[layout]\nthreads_open_as = \"single\"\n"), want: settings.ThreadsOpenAsSingle},
		}},
		{name: "the post fails: owed again at the next start", existing: true, starts: []start{
			{file: str(""), failPost: true, want: settings.ThreadsOpenAsTabs},
			{want: settings.ThreadsOpenAsTabs, wantPosts: 1},
			{want: settings.ThreadsOpenAsTabs, wantPosts: 1},
		}},
		{name: "the user switches to panes before the notice is posted: none", existing: true, starts: []start{
			{file: str(""), failPost: true, want: settings.ThreadsOpenAsTabs},
			{file: str("[layout]\nthreads_open_as = \"panes\"\n"), want: settings.ThreadsOpenAsPanes},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			if tt.existing {
				conn, err := db.Open(context.Background(), filepath.Join(home, "db.sqlite"))
				if err != nil {
					t.Fatal(err)
				}
				_ = conn.Close()
			}
			notes := &noticeRecorder{}
			for i, s := range tt.starts {
				notes.fail = s.failPost
				st := startHome(t, home, notes, s.file)
				if got := st.Settings().Layout.ThreadsOpenAs; got != s.want {
					t.Errorf("start %d: threads_open_as = %q, want %q", i, got, s.want)
				}
				if len(notes.posts) != s.wantPosts {
					t.Errorf("start %d: %d posts, want %d", i, len(notes.posts), s.wantPosts)
				}
				_ = st.Close()
			}
		})
	}
}

// The notice: the app's own source, a fixed key, info and not time-sensitive (so no Dock
// bounce), the agreed words, and Open settings running view.settings --setting without
// closing it. The store takes it as it is.
func TestThreadsOpenAsNotice(t *testing.T) {
	p := defaultNotices[settings.ThreadsOpenAsPanesDefault]
	if p.Source != notification.SourceApp || p.Key != "threads-open-as-panes" || p.Level != notification.LevelInfo || p.TimeSensitive {
		t.Errorf("source %q key %q level %q time-sensitive %v", p.Source, p.Key, p.Level, p.TimeSensitive)
	}
	if p.Title != "Threads can now open as panes" {
		t.Errorf("title %q", p.Title)
	}
	const body = "A thread pane shows one thread with its diff, files and terminals beside it. Clicking another thread swaps them, " +
		"so there are no thread tabs to manage. You are still on tabs: switch in Settings › Layout › Threads open as."
	if p.Body != body {
		t.Errorf("body %q", p.Body)
	}
	if len(p.Actions) != 1 {
		t.Fatalf("%d actions", len(p.Actions))
	}
	a := p.Actions[0]
	if a.Label != "Open settings" || a.Kind != notification.KindCommand || a.Command != "view.settings" ||
		!maps.Equal(a.Args, map[string]string{"setting": settings.KeyThreadsOpenAs}) || a.Resolves == nil || *a.Resolves {
		t.Errorf("action %+v resolves %v", a.Action, a.Resolves)
	}

	conn, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	notes, err := notification.New(context.Background(), notification.Options{DB: conn, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(notes.Close)
	res, err := notes.Post(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != notification.OutcomePosted {
		t.Errorf("outcome %q", res.Outcome)
	}
}

// On a home from before, the layout stored under Tabs loads as it was: the step runs before
// the layout store, so nothing converts it to Panes.
func TestDefaultChangeLeavesTheLayout(t *testing.T) {
	home := t.TempDir()
	ctx := context.Background()
	log := slog.New(slog.DiscardHandler)
	dbPath := filepath.Join(home, "db.sqlite")
	openLayout := func(st *settings.Store) (*layoutstore.Manager, func()) {
		conn, err := db.Open(ctx, dbPath)
		if err != nil {
			t.Fatal(err)
		}
		l, err := layoutstore.New(ctx, layoutstore.Options{DB: conn, Log: log,
			ThreadsOpenAs: func() string { return st.Settings().Layout.ThreadsOpenAs }})
		if err != nil {
			t.Fatal(err)
		}
		return l, func() { _ = l.Close(ctx); _ = conn.Close() }
	}
	// An older daemon: Tabs (written by hand here, as its default was), two thread tabs in one pane.
	path := filepath.Join(home, settings.FileName)
	if err := os.WriteFile(path, []byte("[layout]\nthreads_open_as = \"tabs\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	old, err := settings.Open(ctx, settings.Options{Path: path, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	l, done := openLayout(old)
	for _, th := range []string{"a", "b"} {
		if _, err := l.Apply(ctx, &core.OpenThread{Thread: th, Focus: true}, layoutstore.ApplyOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	done()
	_ = old.Close()
	// Its settings never set the key: that is what an older daemon's file looks like.
	if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 15\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	st := startHome(t, home, &noticeRecorder{}, nil)
	l, done = openLayout(st)
	defer done()
	p := core.Panes(l.Snapshot().State.Spaces[0].Root)
	if len(p) != 1 || len(p[0].Tabs) != 2 {
		t.Errorf("after the start: %d panes, first with %d tabs; want one pane with both threads", len(p), len(p[0].Tabs))
	}
}
