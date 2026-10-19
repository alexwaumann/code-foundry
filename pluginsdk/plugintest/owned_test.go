package plugintest_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// actSurface records the context of the last act.
type actSurface struct{ got chan pluginsdk.UiContext }

func (s actSurface) Act(_ context.Context, a pluginsdk.SurfaceAct) error {
	s.got <- a.Context
	return nil
}
func (actSurface) Visibility(bool)             {}
func (actSurface) Close(pluginsdk.CloseReason) {}

// The fake host keeps the plugin's threads and terminals, refuses ids that are not the
// plugin's and calls without the permission, and an act carries the panel's context.
func TestOwnedThreadsTerminalsAndActContext(t *testing.T) {
	ctx := context.Background()
	var host *pluginsdk.Host
	got := make(chan pluginsdk.UiContext, 1)
	p := pluginsdk.Plugin{
		Init: func(_ context.Context, h *pluginsdk.Host) error { host = h; return nil },
		Surfaces: map[string]pluginsdk.SurfaceFactory{
			"s": func(context.Context, *pluginsdk.Host, pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				return actSurface{got: got}, nil
			},
		},
	}
	h := plugintest.Start(t, p, plugintest.Options{Granted: pluginsdk.Permissions{Threads: true, Terminals: true}})

	id, err := host.CreateThread(ctx, pluginsdk.ThreadCreateParams{Title: "Assistant", Env: map[string]string{"A": "1"}})
	if err != nil || id == "" {
		t.Fatalf("CreateThread = %q, %v", id, err)
	}
	if err := host.SendThread(ctx, id, "hello"); err != nil {
		t.Fatalf("SendThread: %v", err)
	}
	var perr *pluginsdk.Error
	if err := host.SendThread(ctx, "s-users", "x"); !errors.As(err, &perr) || perr.Code != pluginsdk.CodeNotFound {
		t.Fatalf("SendThread to another thread: %v", err)
	}
	if err := host.ArchiveThread(ctx, id); err != nil {
		t.Fatalf("ArchiveThread: %v", err)
	}
	list, err := host.Threads(ctx)
	if err != nil || len(list) != 1 || !list[0].Archived || list[0].Cwd != h.DataDir() {
		t.Fatalf("Threads = %+v, %v", list, err)
	}
	if s := h.ThreadSends(); len(s) != 1 || s[0].Text != "hello" {
		t.Fatalf("ThreadSends = %+v", s)
	}

	term, err := host.CreateTerminal(ctx, pluginsdk.TerminalCreateParams{Argv: []string{"sh", "-c", "date"}})
	if err != nil {
		t.Fatalf("CreateTerminal: %v", err)
	}
	h.ExitTerminal(term, 3)
	terms, _ := host.Terminals(ctx)
	if len(terms) != 1 || terms[0].State != "exited" || terms[0].ExitCode != 3 || terms[0].Title != "sh" {
		t.Fatalf("Terminals = %+v", terms)
	}
	if err := host.CloseTerminal(ctx, term); err != nil {
		t.Fatalf("CloseTerminal: %v", err)
	}
	if err := host.CloseTerminal(ctx, term); !errors.As(err, &perr) || perr.Code != pluginsdk.CodeNotFound {
		t.Fatalf("CloseTerminal twice: %v", err)
	}

	if err := h.OpenSurface(ctx, "i-1", "s", pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: "i-1", Kind: pluginsdk.ActClick, Action: "go", Context: pluginsdk.UiContext{ThreadID: "s-9"}}); err != nil {
		t.Fatal(err)
	}
	if c := <-got; c.ThreadID != "s-9" {
		t.Fatalf("act context = %+v", c)
	}
}

func TestOwnedNeedsPermissions(t *testing.T) {
	var host *pluginsdk.Host
	plugintest.Start(t, pluginsdk.Plugin{Init: func(_ context.Context, h *pluginsdk.Host) error { host = h; return nil }}, plugintest.Options{})
	var perr *pluginsdk.Error
	if _, err := host.CreateThread(context.Background(), pluginsdk.ThreadCreateParams{Title: "x"}); !errors.As(err, &perr) || perr.Code != pluginsdk.CodePermissionDenied {
		t.Fatalf("CreateThread without threads: %v", err)
	}
	if _, err := host.Terminals(context.Background()); !errors.As(err, &perr) || perr.Code != pluginsdk.CodePermissionDenied {
		t.Fatalf("Terminals without terminals: %v", err)
	}
}

// A terminal's exit reaches OnTerminalExit, and ReadTerminal answers its screen.
func TestTerminalExitAndRead(t *testing.T) {
	ctx := context.Background()
	var host *pluginsdk.Host
	exits := make(chan pluginsdk.TerminalExited, 1)
	p := pluginsdk.Plugin{
		Init:           func(_ context.Context, h *pluginsdk.Host) error { host = h; return nil },
		OnTerminalExit: func(_ context.Context, _ *pluginsdk.Host, ex pluginsdk.TerminalExited) { exits <- ex },
	}
	h := plugintest.Start(t, p, plugintest.Options{Granted: pluginsdk.Permissions{Terminals: true}})
	term, err := host.CreateTerminal(ctx, pluginsdk.TerminalCreateParams{Argv: []string{"go", "test", "./..."}})
	if err != nil {
		t.Fatal(err)
	}
	h.SetTerminalText(term, "ok  example.com/calc\nFAIL example.com/x")
	h.ExitTerminal(term, 1)
	select {
	case ex := <-exits:
		if ex != (pluginsdk.TerminalExited{TerminalID: term, ExitCode: 1}) {
			t.Errorf("exit %+v", ex)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no terminal/exited")
	}
	if r, err := host.ReadTerminal(ctx, term, 0); err != nil || r.Text != "ok  example.com/calc\nFAIL example.com/x" || r.Truncated {
		t.Errorf("read = %+v, %v", r, err)
	}
	if r, err := host.ReadTerminal(ctx, term, 18); err != nil || r.Text != "FAIL example.com/x" || !r.Truncated {
		t.Errorf("read 18 bytes = %+v, %v", r, err)
	}
	var perr *pluginsdk.Error
	if _, err := host.ReadTerminal(ctx, "t-other", 0); !errors.As(err, &perr) || perr.Code != pluginsdk.CodeNotFound {
		t.Errorf("another terminal: %v", err)
	}

	// With scrollback: SetTerminalScrollback's text, its lines counted; the reads recorded.
	h.SetTerminalScrollback(term, "=== RUN TestAdd\nok  example.com/calc\nFAIL example.com/x")
	if r, err := host.ReadTerminalWith(ctx, term, pluginsdk.ReadTerminalOptions{Scrollback: true}); err != nil || r.Text != "=== RUN TestAdd\nok  example.com/calc\nFAIL example.com/x" || r.Lines != 3 || r.Truncated {
		t.Errorf("read scrollback = %+v, %v", r, err)
	}
	if r, err := host.ReadTerminalWith(ctx, term, pluginsdk.ReadTerminalOptions{}); err != nil || r.Text != "ok  example.com/calc\nFAIL example.com/x" || r.Lines != 2 {
		t.Errorf("read screen with options = %+v, %v", r, err)
	}
	// A screen with blank rows below its text: no trailing newline, as the host.
	h.SetTerminalText(term, "ok  example.com/calc\n")
	if r, err := host.ReadTerminal(ctx, term, 0); err != nil || r.Text != "ok  example.com/calc" || r.Lines != 1 {
		t.Errorf("read part-filled screen = %+v, %v", r, err)
	}
	reads := h.TerminalReads()
	if len(reads) != 6 || !reads[3].Scrollback || reads[4].Scrollback || reads[1].MaxBytes != 18 {
		t.Errorf("reads = %+v", reads)
	}
}
