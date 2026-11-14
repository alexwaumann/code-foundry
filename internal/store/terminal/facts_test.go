package terminal

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestApplyFacts(t *testing.T) {
	base := Terminal{LiveCwd: "/a"}
	tests := []struct {
		name        string
		cur         Terminal
		s           factSample
		want        Terminal
		wantChanged bool
	}{
		{name: "nothing new", cur: base, s: factSample{cwd: "/a", fgKnown: true}, want: base},
		{name: "cd", cur: base, s: factSample{cwd: "/b", fgKnown: true}, want: Terminal{LiveCwd: "/b"}, wantChanged: true},
		{name: "unreadable cwd keeps the last", cur: base, s: factSample{fgKnown: true}, want: base},
		{name: "a job starts", cur: base, s: factSample{cwd: "/a", fgKnown: true, fg: "sleep 5"},
			want: Terminal{LiveCwd: "/a", Foreground: "sleep 5"}, wantChanged: true},
		{name: "the job ends", cur: Terminal{LiveCwd: "/a", Foreground: "sleep 5"}, s: factSample{cwd: "/a", fgKnown: true},
			want: Terminal{LiveCwd: "/a", LastCommand: "sleep 5"}, wantChanged: true},
		{name: "another job takes its place", cur: Terminal{LiveCwd: "/a", Foreground: "make", LastCommand: "ls"}, s: factSample{cwd: "/a", fgKnown: true, fg: "./run"},
			want: Terminal{LiveCwd: "/a", Foreground: "./run", LastCommand: "make"}, wantChanged: true},
		{name: "the same job keeps running", cur: Terminal{LiveCwd: "/a", Foreground: "vim x", LastCommand: "ls"}, s: factSample{cwd: "/a", fgKnown: true, fg: "vim x"},
			want: Terminal{LiveCwd: "/a", Foreground: "vim x", LastCommand: "ls"}},
		{name: "an unreadable foreground keeps the job", cur: Terminal{LiveCwd: "/a", Foreground: "vim x"}, s: factSample{cwd: "/a"},
			want: Terminal{LiveCwd: "/a", Foreground: "vim x"}},
		{name: "back at the prompt keeps the last command", cur: Terminal{LiveCwd: "/a", LastCommand: "ls"}, s: factSample{cwd: "/c", fgKnown: true},
			want: Terminal{LiveCwd: "/c", LastCommand: "ls"}, wantChanged: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed := applyFacts(tt.cur, tt.s)
			if got.LiveCwd != tt.want.LiveCwd || got.Foreground != tt.want.Foreground || got.LastCommand != tt.want.LastCommand || changed != tt.wantChanged {
				t.Errorf("applyFacts = %+v changed %v; want %+v changed %v", got, changed, tt.want, tt.wantChanged)
			}
		})
	}
	if got := endFacts(Terminal{Foreground: "top", LastCommand: "ls"}); got.Foreground != "" || got.LastCommand != "top" {
		t.Errorf("endFacts with a job = %+v", got)
	}
	if got := endFacts(Terminal{LastCommand: "ls"}); got.Foreground != "" || got.LastCommand != "ls" {
		t.Errorf("endFacts at the prompt = %+v", got)
	}
}

func TestFactsDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	if o.FactsDelay != 200*time.Millisecond || len(o.FactsRecheck) != 2 || o.FactsRecheck[0] != time.Second || o.FactsRecheck[1] != 4*time.Second {
		t.Errorf("defaults: delay %v, recheck %v", o.FactsDelay, o.FactsRecheck)
	}
	if o := (Options{FactsRecheck: []time.Duration{}}).withDefaults(); len(o.FactsRecheck) != 0 {
		t.Errorf("an empty recheck list became %v", o.FactsRecheck)
	}
}

// waitTerminal polls Get until cond holds. No deadline of its own: the test context's.
func waitTerminal(t *testing.T, ctx context.Context, m *Manager, id, what string, cond func(Terminal) bool) Terminal {
	t.Helper()
	for {
		got, err := m.Get(ctx, id)
		if err == nil && cond(got) {
			return got
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for %s: %v (last %+v)", what, ctx.Err(), got)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// A real shell: cd moves LiveCwd, a running job is Foreground, and once it ends it is
// LastCommand. Published on the bus too, not only in Get.
func TestFactsFollowAShell(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Rechecks every 100ms while quiet, so a slow fork under load is still seen; the
	// defaults are pinned by TestFactsDefaults.
	recheck := make([]time.Duration, 600)
	for i := range recheck {
		recheck[i] = 100 * time.Millisecond
	}
	m := newTestManager(t, Options{FactsDelay: 50 * time.Millisecond, FactsRecheck: recheck})
	start, _ := filepath.EvalSymlinks(t.TempDir())
	dest, _ := filepath.EvalSymlinks(t.TempDir())
	events, err := m.Watch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/zsh", "-f", "-i"}, Cwd: start, Env: []string{"PS1=%% "}})
	if err != nil {
		t.Fatal(err)
	}
	if term.LiveCwd != start {
		t.Errorf("LiveCwd at create = %q, want the start directory %q", term.LiveCwd, start)
	}
	if err := m.Write(ctx, term.ID, []byte("cd "+dest+"\n")); err != nil {
		t.Fatal(err)
	}
	waitTerminal(t, ctx, m, term.ID, "LiveCwd after cd", func(t Terminal) bool { return t.LiveCwd == dest })

	if err := m.Write(ctx, term.ID, []byte("sleep 600\n")); err != nil {
		t.Fatal(err)
	}
	waitTerminal(t, ctx, m, term.ID, "sleep in the foreground", func(t Terminal) bool { return t.Foreground == "sleep 600" })
	if err := m.Write(ctx, term.ID, []byte{3}); err != nil { // ^C
		t.Fatal(err)
	}
	got := waitTerminal(t, ctx, m, term.ID, "sleep ended", func(t Terminal) bool { return t.Foreground == "" && t.LastCommand == "sleep 600" })
	if got.LiveCwd != dest || got.Cwd != start {
		t.Errorf("after the job: LiveCwd %q Cwd %q; want %q %q", got.LiveCwd, got.Cwd, dest, start)
	}

	// The bus carried each step.
	var sawCwd, sawFg, sawLast bool
	for !(sawCwd && sawFg && sawLast) {
		select {
		case ev := <-events:
			if u := ev.Updated; u != nil && u.ID == term.ID {
				sawCwd = sawCwd || u.LiveCwd == dest
				sawFg = sawFg || u.Foreground == "sleep 600"
				sawLast = sawLast || u.LastCommand == "sleep 600"
			}
		case <-ctx.Done():
			t.Fatalf("events: cwd %v foreground %v last %v", sawCwd, sawFg, sawLast)
		}
	}

	// A job running when the shell goes is the last command once it has exited.
	if err := m.Write(ctx, term.ID, []byte("cat\n")); err != nil {
		t.Fatal(err)
	}
	waitTerminal(t, ctx, m, term.ID, "cat in the foreground", func(t Terminal) bool { return t.Foreground == "cat" })
	if err := m.Kill(ctx, term.ID); err != nil {
		t.Fatal(err)
	}
	got = waitTerminal(t, ctx, m, term.ID, "exit", func(t Terminal) bool { return t.State == StateExited })
	if got.Foreground != "" || got.LastCommand != "cat" {
		t.Errorf("after exit: Foreground %q LastCommand %q; want \"\" and cat", got.Foreground, got.LastCommand)
	}
}

// A program that never hands the terminal to a job (no job control) has no Foreground.
func TestFactsWithoutJobControl(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m := newTestManager(t, Options{FactsDelay: 20 * time.Millisecond, FactsRecheck: []time.Duration{}})
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// The script changes its own directory, says so, and waits on a child in its group.
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", "cd sub && echo moved && exec /bin/sleep 600"}, Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	got := waitTerminal(t, ctx, m, term.ID, "the cwd change", func(t Terminal) bool { return t.LiveCwd == sub })
	if got.Foreground != "" {
		t.Errorf("Foreground = %q, want none (the main process is the foreground group)", got.Foreground)
	}
}
