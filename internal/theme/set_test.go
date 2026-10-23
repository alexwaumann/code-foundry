package theme

import (
	"slices"
	"strings"
	"testing"
)

func TestSet(t *testing.T) {
	s := NewSet([]Theme{
		{ID: "ocean-dusk", Name: "Ocean Dusk", Scheme: SchemeDark, From: "catppuccin-mocha", CreatedBy: "s-1"},
		{ID: "amber-noon", Name: "amber noon", Scheme: SchemeLight},
		{ID: "beta", Name: "Beta", Scheme: SchemeDark, From: "ocean-dusk"},
		{ID: "dracula", Name: "Not Dracula", Scheme: SchemeLight}, // a curated id: dropped
	}, map[string]string{
		"gone-copy":   "catppuccin-mocha",
		"gone-chain":  "gone-copy",
		"gone-orphan": "",
		"gone-light":  "catppuccin-latte",
		"gone-loop-a": "gone-loop-b",
		"gone-loop-b": "gone-loop-a",
		"beta":        "nord", // back again: not gone
	})
	if got := s.IDs(SchemeDark)[:3]; !slices.Equal(got, []string{"beta", "ocean-dusk", "github-dark"}) {
		t.Errorf("dark ids start %v, want the user's by name, then the catalog", got)
	}
	if got := s.Names(SchemeLight)[:2]; !slices.Equal(got, []string{"amber noon", "GitHub Light"}) {
		t.Errorf("light names start %v", got)
	}
	if n := len(s.Themes()); n != len(Themes())+3 {
		t.Errorf("Themes() = %d, want the catalog + 3", n)
	}
	if th, ok := s.ByID("ocean-dusk"); !ok || !th.User || th.From != "catppuccin-mocha" || th.CreatedBy != "s-1" {
		t.Errorf("ByID(ocean-dusk) = %+v, %v", th, ok)
	}
	if th, ok := s.ByID("dracula"); !ok || th.User || th.Scheme != SchemeDark {
		t.Errorf("a user theme shadowed the curated dracula: %+v", th)
	}
	if _, gone := s.Gone()["beta"]; gone {
		t.Error("beta is a user theme and gone")
	}

	checks := []struct {
		id, scheme string
		want       string // substring of the error; "" = valid
	}{
		{"ocean-dusk", SchemeDark, ""},
		{"github-dark", SchemeDark, ""},
		{"amber-noon", SchemeLight, ""},
		{"ocean-dusk", SchemeLight, `Ocean Dusk ("ocean-dusk") is a dark theme; the light theme must be one of "amber-noon", "github-light"`},
		{"gone-copy", SchemeDark, `theme "gone-copy" is gone: its file in the themes directory was deleted or no longer reads`},
		{"sepia", SchemeDark, `unknown theme "sepia"; dark themes are "beta", "ocean-dusk", "github-dark"`},
		{"ocean-dusk", "sepia", `unknown scheme "sepia"`},
	}
	for _, c := range checks {
		err := s.Check(c.id, c.scheme)
		if c.want == "" {
			if err != nil || !s.Valid(c.id, c.scheme) {
				t.Errorf("Check(%s, %s) = %v", c.id, c.scheme, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("Check(%s, %s) = %v, want %q", c.id, c.scheme, err, c.want)
		}
	}

	fallbacks := []struct{ id, scheme, want string }{
		{"gone-copy", SchemeDark, "catppuccin-mocha"},
		{"gone-chain", SchemeDark, "catppuccin-mocha"}, // its from is gone too: that one's from
		{"gone-orphan", SchemeDark, ""},
		{"gone-light", SchemeDark, ""}, // the theme it came from is of the other scheme
		{"gone-light", SchemeLight, "catppuccin-latte"},
		{"gone-loop-a", SchemeDark, ""},
		{"sepia", SchemeDark, ""},      // never a user theme
		{"ocean-dusk", SchemeDark, ""}, // not gone
		// A user theme of the other scheme (its scheme changed under the slot) falls back
		// along its from too: Ocean Dusk came from Mocha, so a light slot on it shows none
		// (Mocha is dark), and the dark slot on Beta is fine.
		{"ocean-dusk", SchemeLight, ""},
		{"amber-noon", SchemeDark, ""}, // no from
		{"nord", SchemeLight, ""},      // curated: not a user theme
	}
	flipped := NewSet([]Theme{{ID: "paper", Name: "Paper", Scheme: SchemeLight, From: "catppuccin-mocha"}}, nil)
	if got := flipped.Fallback("paper", SchemeDark); got != "catppuccin-mocha" {
		t.Errorf("Fallback of a theme now light, on the dark slot = %q, want its from", got)
	}
	for _, f := range fallbacks {
		if got := s.Fallback(f.id, f.scheme); got != f.want {
			t.Errorf("Fallback(%s, %s) = %q, want %q", f.id, f.scheme, got, f.want)
		}
	}

	// Without: what a delete leaves.
	w := s.Without("ocean-dusk")
	if w.Valid("ocean-dusk", SchemeDark) || w.Fallback("ocean-dusk", SchemeDark) != "catppuccin-mocha" || !s.Valid("ocean-dusk", SchemeDark) {
		t.Errorf("Without: gone %v", w.Gone())
	}
	if w := s.Without("nord"); !w.Valid("nord", SchemeDark) {
		t.Error("Without removed a curated theme")
	}

	// The zero Set is the catalog.
	var zero Set
	if !slices.Equal(zero.IDs(SchemeDark), IDs(SchemeDark)) || zero.Check("ocean-dusk", SchemeDark) == nil {
		t.Error("the zero Set is not the catalog")
	}
}
