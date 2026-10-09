package daemon

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

func TestWorktreePath(t *testing.T) {
	home, _ := os.UserHomeDir()
	tests := []struct {
		dir, repo, branch, want string
	}{
		{"", "cf", "main", ""},
		{"/wt", "cf", "", ""},
		{"/wt", "cf", "alex/fix-x", "/wt/alex-fix-x"},
		{"/wt/{repo}", "cf", "feat", "/wt/cf/feat"},
		{"~/worktrees/{repo}", "cf", "feat", filepath.Join(home, "worktrees/cf/feat")},
		{"relative/{repo}", "cf", "feat", ""},
	}
	for _, tt := range tests {
		if got := worktreePath(tt.dir, tt.repo, tt.branch); got != tt.want {
			t.Errorf("worktreePath(%q, %q, %q) = %q, want %q", tt.dir, tt.repo, tt.branch, got, tt.want)
		}
	}
}

func TestLogLevel(t *testing.T) {
	for in, want := range map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError, "bogus": slog.LevelInfo} {
		if got := logLevel(in); got != want {
			t.Errorf("logLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

func openSettings(t *testing.T) *settings.Store {
	t.Helper()
	st, err := settings.Open(context.Background(), settings.Options{
		Path: filepath.Join(t.TempDir(), settings.FileName), Log: slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// Settings changes reach the registry before they are published, and session.new's
// model/effort defaults and keybinding overrides show up in List.
func TestApplySettings(t *testing.T) {
	st := openSettings(t)
	reg := command.NewRegistry()
	noop := func(context.Context, command.Context, command.Args) (command.Result, error) {
		return command.Result{}, nil
	}
	if err := reg.RegisterAll(
		command.Command{Name: "session.new", Title: "New Session", Category: "Session", Keybindings: []string{"cmd+n"}, Run: noop,
			Args: []command.ArgSpec{
				{Name: "model", Type: command.Enum, Enum: command.SessionModels},
				{Name: "effort", Type: command.Enum, Enum: command.SessionEfforts},
			}},
		command.Command{Name: "terminal.new", Title: "New Terminal", Category: "Terminal", Keybindings: []string{"cmd+t"}, Run: noop},
	); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterPullRequestSessions(reg, command.PullRequestSessionDeps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	argDefault := func(c command.Command, name string) string {
		for _, a := range c.Args {
			if a.Name == name {
				return a.Default
			}
		}
		t.Fatalf("%s has no arg %s", c.Name, name)
		return ""
	}
	level := new(slog.LevelVar)
	applySettings(st, reg, level, false)

	if _, err := st.Update(context.Background(), map[string]string{
		settings.KeyDefaultModel: "opus", settings.KeyDefaultEffort: "high", settings.KeyLogLevel: "warn",
		settings.KeybindingKey("terminal.new"): "none", settings.KeybindingKey("session.new"): "cmd+t",
	}); err != nil {
		t.Fatal(err)
	}
	c, _ := reg.Get("session.new")
	if c.Args[0].Default != "opus" || c.Args[1].Default != "high" || !slices.Equal(c.Keybindings, []string{"cmd+t"}) {
		t.Errorf("session.new = defaults %q/%q keybindings %v", c.Args[0].Default, c.Args[1].Default, c.Keybindings)
	}
	// The pull request session commands start sessions too, with the same defaults.
	for _, name := range []string{"pr.ask", "pr.explain", "pr.fix.findings"} {
		c, _ := reg.Get(name)
		if m, e := argDefault(c, "model"), argDefault(c, "effort"); m != "opus" || e != "high" {
			t.Errorf("%s defaults = %q/%q, want opus/high", name, m, e)
		}
	}
	if c, _ := reg.Get("terminal.new"); len(c.Keybindings) != 0 {
		t.Errorf("terminal.new keybindings = %v, want unbound", c.Keybindings)
	}
	if level.Level() != slog.LevelWarn {
		t.Errorf("log level = %v", level.Level())
	}

	// Back to Claude's defaults.
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyDefaultModel: ""}); err != nil {
		t.Fatal(err)
	}
	if c, _ := reg.Get("session.new"); c.Args[0].Default != "" {
		t.Errorf("model default after reset = %q", c.Args[0].Default)
	}
	if c, _ := reg.Get("pr.fix.findings"); argDefault(c, "model") != "" || argDefault(c, "effort") != "high" {
		t.Errorf("pr.fix.findings defaults after reset = %q/%q", argDefault(c, "model"), argDefault(c, "effort"))
	}
}

func TestSettingsNamer(t *testing.T) {
	st := openSettings(t)
	calls := 0
	namer := settingsNamer(st, func(context.Context, string) (string, error) { calls++; return "a-name", nil })
	if name, err := namer(context.Background(), "hi"); err != nil || name != "a-name" {
		t.Fatalf("namer = %q, %v", name, err)
	}
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyAutoName: "false"}); err != nil {
		t.Fatal(err)
	}
	if _, err := namer(context.Background(), "hi"); !errors.Is(err, errAutoNameOff) || calls != 1 {
		t.Fatalf("namer with auto-naming off: err = %v, calls = %d", err, calls)
	}
}
