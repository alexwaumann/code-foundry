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
	"github.com/alexwaumann/code-foundry/internal/store/repo"
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

// repos.worktree_dir applies live to the worktrees new threads create.
func TestSettingsWorktreePath(t *testing.T) {
	st := openSettings(t)
	pick := settingsWorktreePath(st)
	r := repo.Repo{ID: "r1", Name: "cf"}
	if got := pick(r, "cf/fix-x"); got != "" {
		t.Errorf("unset setting = %q, want the repo store's default", got)
	}
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyWorktreeDir: "/wt/{repo}"}); err != nil {
		t.Fatal(err)
	}
	if got := pick(r, "cf/fix-x"); got != "/wt/cf/cf-fix-x" {
		t.Errorf("with setting = %q", got)
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
	if c, _ := reg.Get("terminal.new"); len(c.Keybindings) != 0 {
		t.Errorf("terminal.new keybindings = %v, want unbound", c.Keybindings)
	}
	if level.Level() != slog.LevelWarn {
		t.Errorf("log level = %v", level.Level())
	}

	// Reset: back to the settings defaults (opus, high).
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyDefaultModel: "", settings.KeyDefaultEffort: ""}); err != nil {
		t.Fatal(err)
	}
	if c, _ := reg.Get("session.new"); c.Args[0].Default != "opus" || c.Args[1].Default != "high" {
		t.Errorf("defaults after reset = %q/%q", c.Args[0].Default, c.Args[1].Default)
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
