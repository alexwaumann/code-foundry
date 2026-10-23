package command_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// warningOnTint is a failing pair as the GUI reports it.
var warningOnTint = theme.ContrastIssue{
	Slot: "--cf-warning-text", Against: "--cf-warning-surface", Label: "--cf-warning-text on --cf-warning-surface over --cf-surface",
	Ratio: 3.96, Required: 4.5,
}

// fakeGUI reports on every user theme as the GUI does once its file changes: after a
// short delay, keyed by the file's version, with the issues given.
func fakeGUI(t *testing.T, themes *usertheme.Store, reports *theme.Reports, delay time.Duration, issues []theme.ContrastIssue, stale []theme.StalePin) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	t.Cleanup(func() { cancel(); <-done })
	go func() {
		defer close(done)
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			for _, f := range themes.Snapshot().Themes {
				if rep, ok := reports.Get(f.ID); ok && rep.Version == f.Version() {
					continue
				}
				time.Sleep(delay)
				if err := reports.Publish(theme.Report{ID: f.ID, Version: f.Version(), Issues: issues, Stale: stale}); err != nil {
					t.Errorf("publish: %v", err)
				}
			}
		}
	}()
}

func newCheckEnv(t *testing.T, windows int) (themeEnv, *theme.Reports) {
	t.Helper()
	home := t.TempDir()
	store, err := settingstest.New(context.Background(), home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	dir := filepath.Join(home, "themes")
	themes := usertheme.New(usertheme.Options{Dir: dir, Log: slog.New(slog.DiscardHandler)})
	themes.Load()
	themes.OnChange(func(s *usertheme.Snapshot) { store.SetThemes(s.Set()) })
	reports := theme.NewReports()
	reg := command.NewRegistry()
	if err := command.RegisterTheme(reg, command.ThemeDeps{
		Settings: api.NewSettings(store), Themes: themes, Emitter: &commandtest.Emitter{OpenWindows: windows},
		Reports: reports, ReportWait: 300 * time.Millisecond,
	}); err != nil {
		t.Fatal(err)
	}
	return themeEnv{reg: reg, settings: store, themes: themes, dir: dir}, reports
}

func TestThemeSaveContrast(t *testing.T) {
	stale := []theme.StalePin{{Slot: "--cf-sidebar", Pinned: "#0b141c", Basis: "#11111b", Derived: "#181825"}}
	many := make([]theme.ContrastIssue, 8)
	for i := range many {
		many[i] = warningOnTint
	}
	tests := []struct {
		name    string
		windows int
		gui     bool // a fake GUI reports
		delay   time.Duration
		uctx    command.Context
		issues  []theme.ContrastIssue
		stale   []theme.StalePin
		want    []string
		checked bool
	}{
		{name: "no app open: not checked, no wait", want: []string{"contrast: not checked (the app is not open)"}},
		{name: "the app reports: ok", windows: 1, gui: true, checked: true, want: []string{"pinned: 2 slots\ncontrast: ok\nstale pins: 0\nwritten to: "}},
		{name: "the app reports issues and a stale pin", windows: 1, gui: true, issues: []theme.ContrastIssue{warningOnTint}, stale: stale, checked: true,
			want: []string{"contrast: 1 issue — warning-text on warning-surface over surface 3.9:1 (needs 4.5)",
				"stale pins: 1 — sidebar (pinned #0b141c when its rule gave #11111b; it gives #181825 now)"}},
		{name: "many issues: the first few and theme check", windows: 1, gui: true, issues: many, checked: true,
			want: []string{"contrast: 8 issues — warning-text", ", and 2 more (theme check ocean-dusk lists every one)"}},
		{name: "a slow report arrives within the wait", windows: 1, gui: true, delay: 100 * time.Millisecond, checked: true, want: []string{"contrast: ok"}},
		{name: "the app never reports", windows: 1,
			want: []string{"contrast: not checked yet (the app has not reported on this version yet; theme check ocean-dusk in a moment)"}},
		{name: "from the app's editor: no wait", windows: 1, uctx: command.Context{ActiveView: "themes"},
			want: []string{"contrast: shown in the Themes page's editor"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env, reports := newCheckEnv(t, tt.windows)
			if tt.gui {
				fakeGUI(t, env.themes, reports, tt.delay, tt.issues, tt.stale)
			}
			start := time.Now()
			res, err := env.invoke(t, tt.uctx, "theme.save", map[string]string{"data": string(oceanDusk(t))})
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.want {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			if took := time.Since(start); !tt.gui && tt.windows == 0 && took > 200*time.Millisecond {
				t.Errorf("waited %v with no app open", took)
			}
			out := res.JSON.(command.ThemeSaved)
			if out.Contrast.Checked != tt.checked || out.Contrast.ID != "ocean-dusk" || out.Contrast.Version == "" || len(out.Contrast.Issues) != len(tt.issues) {
				t.Errorf("contrast = %+v", out.Contrast)
			}
		})
	}
}

func TestThemeCheck(t *testing.T) {
	env, reports := newCheckEnv(t, 1)
	if _, err := env.invoke(t, command.Context{}, "theme.save", map[string]string{"data": string(oceanDusk(t))}); err != nil {
		t.Fatal(err)
	}
	f, _ := env.themes.Snapshot().Get("ocean-dusk")
	second := warningOnTint
	second.Slot, second.Against, second.Label, second.Ratio, second.Required = "--cf-text", "--cf-surface", "--cf-text on --cf-surface", 6.2, 7
	if err := reports.Publish(theme.Report{ID: "ocean-dusk", Version: f.Version(), Issues: []theme.ContrastIssue{warningOnTint, second}}); err != nil {
		t.Fatal(err)
	}
	res, err := env.invoke(t, command.Context{ActiveThreadID: "s-1"}, "theme.check", map[string]string{"theme": "ocean-dusk"})
	if err != nil {
		t.Fatal(err)
	}
	want := "Ocean Dusk (ocean-dusk), a dark theme\ncontrast: 2 issues\n  warning-text on warning-surface over surface 3.9:1 (needs 4.5)\n  text on surface 6.2:1 (needs 7)\nstale pins: 0"
	if res.Message != want {
		t.Errorf("message:\n%s\nwant:\n%s", res.Message, want)
	}
	if js, _ := json.Marshal(res.JSON); !strings.Contains(string(js), `"checked":true`) || !strings.Contains(string(js), `"against":"--cf-warning-surface"`) {
		t.Errorf("json = %s", js)
	}
	// A report on an older version is not this file's.
	if _, err := env.invoke(t, command.Context{}, "theme.save", map[string]string{"data": strings.Replace(string(oceanDusk(t)), `"#5fb3b3"`, `"#6fc3c3"`, 1)}); err != nil {
		t.Fatal(err)
	}
	res, err = env.invoke(t, command.Context{}, "theme.check", map[string]string{"theme": "ocean-dusk"})
	if err != nil || !strings.Contains(res.Message, "contrast: not checked yet") {
		t.Errorf("after an edit: %q, %v", res.Message, err)
	}
	// Only the user's themes.
	if _, err := env.invoke(t, command.Context{}, "theme.check", map[string]string{"theme": "nord"}); err == nil {
		t.Error("checked a curated theme")
	}
}
