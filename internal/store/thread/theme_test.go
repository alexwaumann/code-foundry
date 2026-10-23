package thread

import (
	"errors"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// oceanDusk is a user theme file copied from Catppuccin Mocha.
func oceanDusk(t *testing.T) theme.File {
	t.Helper()
	f, ok := theme.Curated("catppuccin-mocha")
	if !ok {
		t.Fatal("no catppuccin-mocha in the catalog")
	}
	f.ID, f.Name, f.From, f.Source = "ocean-dusk", "Ocean Dusk", "catppuccin-mocha", ""
	f.Base.Accent = "#5fb3b3"
	f.Overrides = map[string]string{"--cf-sidebar-row-selected": "#1e2e3c"}
	return f
}

// ShowTheme puts a card in a live thread and a stopped one; each keeps the file it was
// given (a later save of the same id is another card), a refinement's Undo is the version
// it replaced, and the cards come back after a restart.
func TestShowTheme(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{NoProject: true})
	f := oceanDusk(t)
	first, err := e.m.ShowTheme(e.ctx(), s.ID, ThemeCard{File: f, Applied: true, Previous: "catppuccin-mocha"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Kind != KindTheme || first.Theme == nil || first.Theme.File.Base.Accent != "#5fb3b3" || first.Theme.Previous != "catppuccin-mocha" {
		t.Fatalf("first card = %+v (theme %+v)", first, first.Theme)
	}
	// A refinement: the slot already had the theme, so Previous is the theme itself.
	warmer := f.Clone()
	warmer.Base.Accent = "#6fc3a3"
	second, err := e.m.ShowTheme(e.ctx(), s.ID, ThemeCard{File: warmer, Applied: true, Previous: "ocean-dusk", PreviousVersion: f.Version()})
	if err != nil {
		t.Fatal(err)
	}
	if second.Theme.Previous != "ocean-dusk" || second.Theme.PreviousVersion != f.Version() {
		t.Errorf("refinement's previous = %q %q, want the version it replaced", second.Theme.Previous, second.Theme.PreviousVersion)
	}
	e.restart()
	// Stopped: straight onto the log. Not applied: no Undo target, whatever was sent.
	third, err := e.m.ShowTheme(e.ctx(), s.ID, ThemeCard{File: warmer, Previous: "github-dark"})
	if err != nil {
		t.Fatal(err)
	}
	if third.Theme.Applied || third.Theme.Previous != "" || third.Ordinal <= second.Ordinal {
		t.Errorf("stopped card = %+v (ordinal %d after %d)", third.Theme, third.Ordinal, second.Ordinal)
	}
	e.restart()
	snap, err := e.m.Items(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []Item
	for _, it := range snap.Items {
		if it.Kind == KindTheme {
			got = append(got, it)
		}
	}
	if len(got) != 3 || got[0].Theme.File.Base.Accent != "#5fb3b3" || got[1].Theme.File.Base.Accent != "#6fc3a3" ||
		got[0].Theme.File.Overrides["--cf-sidebar-row-selected"] != "#1e2e3c" || got[1].Theme.PreviousVersion != f.Version() {
		t.Fatalf("reloaded theme items = %+v", got)
	}
}

func TestShowThemeRefusesABadFile(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{NoProject: true})
	bad := oceanDusk(t)
	bad.Base.Canvas = "teal"
	if _, err := e.m.ShowTheme(e.ctx(), s.ID, ThemeCard{File: bad}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("err = %v, want ErrInvalidArgument", err)
	}
	if _, err := e.m.ShowTheme(e.ctx(), "s-000000000000", ThemeCard{File: oceanDusk(t)}); err == nil {
		t.Fatal("unknown thread: no error")
	}
}

// ShowTheme keeps only an Undo that can mean something (theme-fuzz-daemon, model 4-6):
// another theme, or this theme's replaced version; nothing for a card not applied.
func TestShowThemeUndoTarget(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{NoProject: true})
	f := oceanDusk(t)
	tests := []struct {
		name              string
		in                ThemeCard
		wantPrev, wantVer string
		wantGone          bool
	}{
		{name: "another theme", in: ThemeCard{Applied: true, Previous: "nord", PreviousVersion: "ignored", PreviousGone: true}, wantPrev: "nord", wantGone: true},
		{name: "its own replaced version", in: ThemeCard{Applied: true, Previous: "ocean-dusk", PreviousVersion: "0123"}, wantPrev: "ocean-dusk", wantVer: "0123"},
		{name: "its own id with no version", in: ThemeCard{Applied: true, Previous: "ocean-dusk"}},
		{name: "its own version, not kept", in: ThemeCard{Applied: true, Previous: "ocean-dusk", PreviousGone: true}, wantPrev: "ocean-dusk", wantGone: true},
		{name: "not applied", in: ThemeCard{Previous: "nord", PreviousVersion: "x", PreviousGone: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.in.File = f
			it, err := e.m.ShowTheme(e.ctx(), s.ID, tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if c := it.Theme; c.Previous != tt.wantPrev || c.PreviousVersion != tt.wantVer || c.PreviousGone != tt.wantGone {
				t.Errorf("card = %q %q %v", c.Previous, c.PreviousVersion, c.PreviousGone)
			}
		})
	}
}
