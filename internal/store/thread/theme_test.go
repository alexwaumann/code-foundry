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
// given (a later save of the same id is another card), a refinement takes the first
// card's Undo target, and the cards come back after a restart.
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
	second, err := e.m.ShowTheme(e.ctx(), s.ID, ThemeCard{File: warmer, Applied: true, Previous: "ocean-dusk"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Theme.Previous != "catppuccin-mocha" {
		t.Errorf("refinement's previous = %q, want the first card's catppuccin-mocha", second.Theme.Previous)
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
		got[0].Theme.File.Overrides["--cf-sidebar-row-selected"] != "#1e2e3c" || got[1].Theme.Previous != "catppuccin-mocha" {
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

func TestInheritPrevious(t *testing.T) {
	card := func(id, scheme, prev string, applied bool) Item {
		f := theme.File{ID: id, Scheme: scheme}
		return Item{Kind: KindTheme, Theme: &ThemeCard{File: f, Applied: applied, Previous: prev}}
	}
	tests := []struct {
		name string
		log  []Item
		card Item
		want string
	}{
		{"a first apply keeps its own", nil, card("a", "dark", "mocha", true), "mocha"},
		{"a refinement takes the latest earlier one", []Item{card("a", "dark", "nord", true), card("a", "dark", "mocha", true)}, card("a", "dark", "a", true), "mocha"},
		{"skips cards with no target", []Item{card("a", "dark", "nord", true), card("a", "dark", "", true)}, card("a", "dark", "a", true), "nord"},
		{"another theme's card does not count", []Item{card("b", "dark", "nord", true)}, card("a", "dark", "a", true), ""},
		{"nothing earlier: no target", nil, card("a", "dark", "a", true), ""},
		{"not applied: untouched", []Item{card("a", "dark", "nord", true)}, card("a", "dark", "", false), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := &threadLog{items: tt.log}
			c := *tt.card.Theme
			inheritPrevious(log, &c)
			if c.Previous != tt.want {
				t.Errorf("previous = %q, want %q", c.Previous, tt.want)
			}
		})
	}
}
