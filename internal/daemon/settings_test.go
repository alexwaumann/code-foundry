package daemon

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
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

// worktreeBase is the cleanup's managed root from repos.worktree_dir.
func TestWorktreeBase(t *testing.T) {
	home, _ := os.UserHomeDir()
	tests := []struct{ dir, repo, want string }{
		{"", "cf", ""},
		{"/wt", "cf", "/wt"},
		{"/wt/{repo}", "cf", "/wt/cf"},
		{"~/worktrees/{repo}", "cf", filepath.Join(home, "worktrees/cf")},
		{"relative/{repo}", "cf", ""},
	}
	for _, tt := range tests {
		if got := worktreeBase(tt.dir, tt.repo); got != tt.want {
			t.Errorf("worktreeBase(%q, %q) = %q, want %q", tt.dir, tt.repo, got, tt.want)
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
		settings.KeyDefaultModel: "claude-opus-4-8[1m]", settings.KeyDefaultEffort: "high", settings.KeyLogLevel: "warn",
		settings.KeybindingKey("terminal.new"): "none", settings.KeybindingKey("session.new"): "cmd+t",
	}); err != nil {
		t.Fatal(err)
	}
	c, _ := reg.Get("session.new")
	if c.Args[0].Default != "claude-opus-4-8[1m]" || c.Args[1].Default != "high" || !slices.Equal(c.Keybindings, []string{"cmd+t"}) {
		t.Errorf("session.new = defaults %q/%q keybindings %v", c.Args[0].Default, c.Args[1].Default, c.Keybindings)
	}
	// The pull request session commands start sessions too, with the same defaults.
	for _, name := range []string{"pr.ask", "pr.explain", "pr.fix.findings"} {
		c, _ := reg.Get(name)
		if m, e := argDefault(c, "model"), argDefault(c, "effort"); m != "claude-opus-4-8[1m]" || e != "high" {
			t.Errorf("%s defaults = %q/%q, want opus/high", name, m, e)
		}
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
	if c, _ := reg.Get("session.new"); c.Args[0].Default != "claude-opus-4-8[1m]" || c.Args[1].Default != "high" {
		t.Errorf("defaults after reset = %q/%q", c.Args[0].Default, c.Args[1].Default)
	}
	if c, _ := reg.Get("pr.fix.findings"); argDefault(c, "model") != "claude-opus-4-8[1m]" || argDefault(c, "effort") != "high" {
		t.Errorf("pr.fix.findings defaults after reset = %q/%q", argDefault(c, "model"), argDefault(c, "effort"))
	}
}

func TestSettingsNamer(t *testing.T) {
	st := openSettings(t)
	calls := 0
	var models []string
	namer := settingsNamer(st, func(ctx context.Context, _ string) (string, error) {
		calls++
		models = append(models, session.NamingModel(ctx))
		return "a-name", nil
	})
	if name, err := namer(context.Background(), "hi"); err != nil || name != "a-name" {
		t.Fatalf("namer = %q, %v", name, err)
	}
	// The naming model is read per call: no restart, no new namer.
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyNamingModel: "claude-4.5-haiku[1m]"}); err != nil {
		t.Fatal(err)
	}
	if _, err := namer(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if want := []string{"claude-sonnet-5[1m]", "claude-4.5-haiku[1m]"}; !slices.Equal(models, want) {
		t.Errorf("naming models = %q, want %q", models, want)
	}
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyAutoName: "false"}); err != nil {
		t.Fatal(err)
	}
	if _, err := namer(context.Background(), "hi"); !errors.Is(err, errAutoNameOff) || calls != 2 {
		t.Fatalf("namer with auto-naming off: err = %v, calls = %d", err, calls)
	}
}

type ttlRecorder struct{ got []time.Duration }

func (r *ttlRecorder) SetCacheTTL(d time.Duration) { r.got = append(r.got, d) }

func TestApplyCacheTTL(t *testing.T) {
	tests := []struct {
		name   string
		update string
		want   []time.Duration
	}{
		{name: "the default at once", want: []time.Duration{time.Hour}},
		{name: "a change applies live", update: "60", want: []time.Duration{time.Hour, time.Minute}},
		{name: "5 minutes", update: "300", want: []time.Duration{time.Hour, 5 * time.Minute}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := openSettings(t)
			rec := &ttlRecorder{}
			applyCacheTTL(st, rec)
			if tt.update != "" {
				if _, err := st.Update(context.Background(), map[string]string{settings.KeyCacheTTL: tt.update}); err != nil {
					t.Fatal(err)
				}
			}
			if !slices.Equal(rec.got, tt.want) {
				t.Errorf("SetCacheTTL calls = %v, want %v", rec.got, tt.want)
			}
		})
	}
}

type channelRecorder struct{ got []update.Channel }

func (r *channelRecorder) SetChannel(ch update.Channel) { r.got = append(r.got, ch) }

func TestApplyUpdateChannel(t *testing.T) {
	tests := []struct {
		name   string
		update string
		want   []update.Channel
	}{
		{name: "stable at once by default", want: []update.Channel{update.ChannelStable}},
		{name: "switching to tip applies live", update: "tip", want: []update.Channel{update.ChannelStable, update.ChannelTip}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := openSettings(t)
			rec := &channelRecorder{}
			applyUpdateChannel(st, rec)
			if tt.update != "" {
				if _, err := st.Update(context.Background(), map[string]string{settings.KeyUpdateChannel: tt.update}); err != nil {
					t.Fatal(err)
				}
			}
			if !slices.Equal(rec.got, tt.want) {
				t.Errorf("SetChannel calls = %v, want %v", rec.got, tt.want)
			}
		})
	}
}
