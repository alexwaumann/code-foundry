package daemon

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

func TestLogLevel(t *testing.T) {
	for in, want := range map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError, "bogus": slog.LevelInfo} {
		if got := logLevel(in); got != want {
			t.Errorf("logLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

// Every command that starts a thread with a model and effort takes the settings' as its
// defaults; thread.new-like was missing (fuzz D follow-up).
func TestRegistryOverridesThreadStarters(t *testing.T) {
	var s settings.Settings
	s.Threads.DefaultModel, s.Threads.DefaultEffort = "claude-haiku-5-5[1m]", "low"
	defs := registryOverrides(s).ArgDefaults
	for _, name := range []string{"thread.new", "thread.new-like", "pr.ask", "pr.explain", "pr.fix.findings", "theme.ask"} {
		if got := defs[name]; got["model"] != "claude-haiku-5-5[1m]" || got["effort"] != "low" {
			t.Errorf("%s defaults = %v", name, got)
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

// Settings changes reach the registry before they are published, and thread.new's
// model/effort defaults and keybinding overrides show up in List.
func TestApplySettings(t *testing.T) {
	st := openSettings(t)
	reg := command.NewRegistry()
	noop := func(context.Context, command.Context, command.Args) (command.Result, error) {
		return command.Result{}, nil
	}
	if err := reg.RegisterAll(
		command.Command{Name: "thread.new", Title: "New Thread", Category: "Thread", Keybindings: []string{"cmd+n"}, Run: noop,
			Args: []command.ArgSpec{
				{Name: "model", Type: command.Enum, Enum: command.ThreadModels},
				{Name: "effort", Type: command.Enum, Enum: command.ThreadEfforts},
			}},
		command.Command{Name: "terminal.new", Title: "New Terminal", Category: "Terminal", Keybindings: []string{"cmd+t"}, Run: noop},
	); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterPullRequestThreads(reg, command.PullRequestThreadDeps{Emitter: &commandtest.Emitter{}}); err != nil {
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
		settings.KeybindingKey("terminal.new"): "none", settings.KeybindingKey("thread.new"): "cmd+t",
	}); err != nil {
		t.Fatal(err)
	}
	c, _ := reg.Get("thread.new")
	if c.Args[0].Default != "claude-opus-4-8[1m]" || c.Args[1].Default != "high" || !slices.Equal(c.Keybindings, []string{"cmd+t"}) {
		t.Errorf("thread.new = defaults %q/%q keybindings %v", c.Args[0].Default, c.Args[1].Default, c.Keybindings)
	}
	// The pull request thread commands start threads too, with the same defaults.
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

	// Reset: back to the settings defaults (Sonnet 5, medium).
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyDefaultModel: "", settings.KeyDefaultEffort: ""}); err != nil {
		t.Fatal(err)
	}
	if c, _ := reg.Get("thread.new"); c.Args[0].Default != "claude-sonnet-5[1m]" || c.Args[1].Default != "medium" {
		t.Errorf("defaults after reset = %q/%q", c.Args[0].Default, c.Args[1].Default)
	}
	if c, _ := reg.Get("pr.fix.findings"); argDefault(c, "model") != "claude-sonnet-5[1m]" || argDefault(c, "effort") != "medium" {
		t.Errorf("pr.fix.findings defaults after reset = %q/%q", argDefault(c, "model"), argDefault(c, "effort"))
	}
}

func TestSettingsNamer(t *testing.T) {
	st := openSettings(t)
	calls := 0
	var models []string
	namer := settingsNamer(st, func(ctx context.Context, _ thread.NamingRequest) (thread.Naming, error) {
		calls++
		models = append(models, thread.NamingModel(ctx))
		return thread.Naming{Title: "a-name"}, nil
	})
	hi := thread.NamingRequest{Message: "hi"}
	if n, err := namer(context.Background(), hi); err != nil || n.Title != "a-name" {
		t.Fatalf("namer = %+v, %v", n, err)
	}
	// The naming model is read per call: no restart, no new namer.
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyNamingModel: "claude-4.5-haiku[1m]"}); err != nil {
		t.Fatal(err)
	}
	if _, err := namer(context.Background(), hi); err != nil {
		t.Fatal(err)
	}
	if want := []string{"claude-sonnet-4-6[1m]", "claude-4.5-haiku[1m]"}; !slices.Equal(models, want) {
		t.Errorf("naming models = %q, want %q", models, want)
	}
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyAutoName: "false"}); err != nil {
		t.Fatal(err)
	}
	if _, err := namer(context.Background(), hi); !errors.Is(err, thread.ErrNamingOff) || calls != 2 {
		t.Fatalf("namer with auto-naming off: err = %v, calls = %d", err, calls)
	}
	// Regenerate Name is the user's own ask: auto-naming off does not stop it, the model still applies.
	if n, err := namer(thread.WithExplicitNaming(context.Background()), thread.NamingRequest{Conversation: "User: hi"}); err != nil || n.Title != "a-name" || calls != 3 {
		t.Fatalf("explicit namer with auto-naming off = %+v, %v, calls = %d", n, err, calls)
	}
	if got := models[len(models)-1]; got != "claude-4.5-haiku[1m]" {
		t.Errorf("explicit naming model = %q", got)
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

// TestBranchNaming checks the projects.branch_* settings reach the thread store per
// call: no restart.
func TestBranchNaming(t *testing.T) {
	st := openSettings(t)
	get := branchNaming(st)
	if got, want := get(), (thread.BranchNaming{Mode: thread.BranchModeSemantic, Prefix: "cf"}); got != want {
		t.Errorf("defaults = %+v, want %+v", got, want)
	}
	if _, err := st.Update(context.Background(), map[string]string{
		settings.KeyBranchNaming: "custom", settings.KeyBranchPrefix: settings.BranchPrefixNone, settings.KeyBranchInstructions: "ab/<slug>",
	}); err != nil {
		t.Fatal(err)
	}
	if got, want := get(), (thread.BranchNaming{Mode: thread.BranchModeCustom, Instructions: "ab/<slug>"}); got != want {
		t.Errorf("after update = %+v, want %+v", got, want)
	}
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyBranchNaming: "nope"}); err == nil {
		t.Error("an unknown mode was accepted")
	}
}

// TestBaseFromOrigin checks projects.base_from_origin reaches every CreateWorktree
// caller per call: no restart.
func TestBaseFromOrigin(t *testing.T) {
	st := openSettings(t)
	get := baseFromOrigin(st)
	if !get() {
		t.Error("default is off, want on")
	}
	if _, err := st.Update(context.Background(), map[string]string{settings.KeyBaseFromOrigin: "false"}); err != nil {
		t.Fatal(err)
	}
	if get() {
		t.Error("still on after turning it off")
	}
}
