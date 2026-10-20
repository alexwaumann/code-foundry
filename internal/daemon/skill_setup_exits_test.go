package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

type recordSetups struct {
	mu  sync.Mutex
	got []string
}

func (r *recordSetups) SetupExited(_ context.Context, name string, code int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, fmt.Sprintf("%s=%d", name, code))
	return nil
}

func (r *recordSetups) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.got...)
}

// A setup terminal's exit is told once, with its skill; a shell's or an action's is not.
func TestSkillSetupExits(t *testing.T) {
	ctx := context.Background()
	terms := terminaltest.New(bus.New())
	rec := &recordSetups{}
	stop := startSkillSetupExits(ctx, slog.New(slog.DiscardHandler), terms, rec)
	defer stop()
	setup, err := terms.Create(ctx, terminal.Spec{Argv: []string{"/bin/sh", "install.sh"}, Labels: termlabel.SetupTerminal("s1", "p1", "/wt", "pr-review")})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := terms.Create(ctx, terminal.Spec{Argv: []string{"/bin/sh", "setup.sh"}, Labels: termlabel.SetupTerminal("", "p1", "/wt", "sql-helper")})
	if err != nil {
		t.Fatal(err)
	}
	shell, err := terms.Create(ctx, terminal.Spec{Argv: []string{"zsh"}, Labels: termlabel.Shell("s1", "p1", "/wt")})
	if err != nil {
		t.Fatal(err)
	}
	for id, code := range map[string]int{shell.ID: 0, setup.ID: 0, failed.ID: 2} {
		if err := terms.Exit(id, code); err != nil {
			t.Fatal(err)
		}
	}
	_ = terms.Resize(ctx, setup.ID, 100, 30) // another update after the exit: not told again
	deadline := time.Now().Add(5 * time.Second)
	for len(rec.list()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	got := rec.list()
	if len(got) != 2 || !(got[0] == "pr-review=0" && got[1] == "sql-helper=2" || got[1] == "pr-review=0" && got[0] == "sql-helper=2") {
		t.Errorf("told %q", got)
	}
}

func TestSetupTerminalLabels(t *testing.T) {
	l := termlabel.SetupTerminal("s1", "p1", "/wt", "pr-review")
	if !termlabel.IsSetup(l) || !termlabel.IsPanel(l) || termlabel.IsShell(l) || l[termlabel.Title] != "Setup pr-review" ||
		l[termlabel.Skill] != "pr-review" || l[termlabel.Thread] != "s1" || l[termlabel.Worktree] != "/wt" {
		t.Errorf("labels = %v", l)
	}
}
