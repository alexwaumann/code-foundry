package daemon

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

type recordExits struct {
	mu  sync.Mutex
	got []string
}

func (r *recordExits) TerminalExited(id string, code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, id+"="+string(rune('0'+code)))
}

func (r *recordExits) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.got...)
}

// A plugin terminal's exit is told once; a shell's is not.
func TestPluginTerminalExits(t *testing.T) {
	ctx := context.Background()
	terms := terminaltest.New(bus.New())
	rec := &recordExits{}
	stop := startPluginTerminalExits(ctx, slog.New(slog.DiscardHandler), terms, rec)
	defer stop()
	plug, err := terms.Create(ctx, terminal.Spec{Argv: []string{"go", "test"}, Labels: termlabel.PluginTerminal("tw", "Tests")})
	if err != nil {
		t.Fatal(err)
	}
	shell, err := terms.Create(ctx, terminal.Spec{Argv: []string{"zsh"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := terms.Exit(shell.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := terms.Exit(plug.ID, 1); err != nil {
		t.Fatal(err)
	}
	_ = terms.Resize(ctx, plug.ID, 100, 30) // another update after the exit: not told again
	deadline := time.Now().Add(5 * time.Second)
	for len(rec.list()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if got := rec.list(); len(got) != 1 || got[0] != plug.ID+"=1" {
		t.Errorf("told %q", got)
	}
}
