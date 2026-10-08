package terminal

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// observed records Observer events. The Observer appends under a mutex and never
// blocks, as the contract requires.
type observed struct {
	mu     sync.Mutex
	output bytes.Buffer
	titles []string
	alts   []bool
	exit   *Exit
	order  []string // event kinds in delivery order
	ids    map[string]bool
}

func (o *observed) observer(id string, ev ObserveEvent) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.ids == nil {
		o.ids = map[string]bool{}
	}
	o.ids[id] = true
	switch {
	case ev.Output != nil:
		o.output.Write(ev.Output)
		o.order = append(o.order, "output")
	case ev.Title != nil:
		o.titles = append(o.titles, *ev.Title)
		o.order = append(o.order, "title")
	case ev.AltScreen != nil:
		o.alts = append(o.alts, *ev.AltScreen)
		o.order = append(o.order, "alt")
	case ev.Exited != nil:
		o.exit = ev.Exited
		o.order = append(o.order, "exited")
	}
}

func (o *observed) exited() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.exit != nil
}

func TestObserverSeesOutputTitleAltScreenAndExit(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	var obs observed
	script := `printf 'hello\n'; printf '\033]2;first\007'; printf '\033]2;second\007'; ` +
		`printf '\033[?1049hALT'; printf '\033[?1049l'; printf 'bye\n'; exit 3`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Observer: obs.observer})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !obs.exited() {
		if time.Now().After(deadline) {
			t.Fatal("observer never saw exit")
		}
		time.Sleep(10 * time.Millisecond)
	}
	obs.mu.Lock()
	defer obs.mu.Unlock()
	if !obs.ids[term.ID] || len(obs.ids) != 1 {
		t.Errorf("observer ids = %v, want only %s", obs.ids, term.ID)
	}
	out := obs.output.String()
	for _, want := range []string{"hello", "ALT", "bye"} {
		if !strings.Contains(out, want) {
			t.Errorf("observed output %q missing %q", out, want)
		}
	}
	// Titles and alt-screen changes are not throttled for the observer, but output
	// may be coalesced into one chunk, so only the final title is guaranteed.
	if len(obs.titles) == 0 || obs.titles[len(obs.titles)-1] != "second" {
		t.Errorf("titles = %v, want ending in second", obs.titles)
	}
	if obs.exit.Code != 3 {
		t.Errorf("exit code = %d, want 3", obs.exit.Code)
	}
	if last := obs.order[len(obs.order)-1]; last != "exited" {
		t.Errorf("last event = %s, want exited (order %v)", last, obs.order)
	}
	if obs.order[0] != "output" {
		t.Errorf("first event = %s, want output", obs.order[0])
	}
}

func TestObserverSeesAltScreenTransitions(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	var obs observed
	// Separate the transitions in time so they land in separate chunks.
	script := `printf '\033[?1049hALT'; sleep 0.2; printf '\033[?1049l'; sleep 0.2`
	if _, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Observer: obs.observer}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !obs.exited() {
		if time.Now().After(deadline) {
			t.Fatal("observer never saw exit")
		}
		time.Sleep(10 * time.Millisecond)
	}
	obs.mu.Lock()
	defer obs.mu.Unlock()
	if len(obs.alts) != 2 || !obs.alts[0] || obs.alts[1] {
		t.Errorf("alt transitions = %v, want [true false]", obs.alts)
	}
}

func TestScreenTextIsActiveAreaOnly(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	// 40 numbered lines on a 30x10 terminal: only the last rows are on screen.
	script := `i=1; while [ $i -le 40 ]; do echo "line $i"; i=$((i+1)); done; printf 'prompt> '; sleep 5`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 30, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.Kill(ctx, term.ID) }()
	var text string
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(text, "prompt>") {
		if time.Now().After(deadline) {
			t.Fatalf("screen never showed the prompt: %q", text)
		}
		time.Sleep(20 * time.Millisecond)
		if text, err = m.ScreenText(ctx, term.ID); err != nil {
			t.Fatal(err)
		}
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) != 10 {
		t.Fatalf("got %d lines, want 10: %q", len(lines), text)
	}
	if lines[0] != "line 32" || lines[8] != "line 40" || lines[9] != "prompt>" {
		t.Errorf("screen = %q", lines)
	}
	if strings.Contains(text, "\x1b") {
		t.Errorf("plain text contains escapes: %q", text)
	}
	if _, err := m.ScreenText(ctx, "nope"); err == nil {
		t.Error("ScreenText of unknown id succeeded")
	}
}
