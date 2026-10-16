package theme

import (
	"strings"
	"testing"
)

func TestCatalog(t *testing.T) {
	all := Themes()
	if len(all) < 2 {
		t.Fatalf("catalog has %d themes; catalog.json did not parse?", len(all))
	}
	seen := map[string]bool{}
	for _, th := range all {
		if th.ID == "" || th.Name == "" || (th.Scheme != SchemeDark && th.Scheme != SchemeLight) {
			t.Errorf("bad entry %+v", th)
		}
		if seen[th.ID] {
			t.Errorf("duplicate id %q", th.ID)
		}
		seen[th.ID] = true
		if th.Pair != "" {
			p, ok := ByID(th.Pair)
			if !ok || p.Pair != th.ID || p.Scheme == th.Scheme {
				t.Errorf("%s: pair %q does not point back across schemes", th.ID, th.Pair)
			}
		}
	}
	for _, s := range []string{SchemeDark, SchemeLight} {
		if d := Default(s); !Valid(d, s) {
			t.Errorf("Default(%s) = %q is not a %s theme", s, d, s)
		}
		if len(IDs(s)) != len(Names(s)) || len(IDs(s)) == 0 {
			t.Errorf("IDs/Names(%s) = %d/%d", s, len(IDs(s)), len(Names(s)))
		}
	}
	if Default(SchemeDark) != "catppuccin-mocha" || Default(SchemeLight) != "catppuccin-latte" {
		t.Errorf("defaults = %q, %q", Default(SchemeDark), Default(SchemeLight))
	}
	if Default("sepia") != "" {
		t.Error("Default of an unknown scheme is not empty")
	}
}

func TestCheck(t *testing.T) {
	tests := []struct {
		id, scheme string
		want       string // substring of the error; "" = valid
	}{
		{"catppuccin-mocha", SchemeDark, ""},
		{"dracula", SchemeDark, ""},
		{"rose-pine-dawn", SchemeLight, ""},
		{"catppuccin-latte", SchemeDark, `Catppuccin Latte ("catppuccin-latte") is a light theme; the dark theme must be one of "catppuccin-mocha"`},
		{"dracula", SchemeLight, `Dracula ("dracula") is a dark theme; the light theme must be one of "catppuccin-latte"`},
		{"nope", SchemeDark, `unknown theme "nope"; dark themes are "catppuccin-mocha"`},
		{"", SchemeLight, `unknown theme ""`},
		{"dracula", "sepia", `unknown scheme "sepia"`},
	}
	for _, tt := range tests {
		t.Run(tt.id+"/"+tt.scheme, func(t *testing.T) {
			err := Check(tt.id, tt.scheme)
			if tt.want == "" {
				if err != nil || !Valid(tt.id, tt.scheme) {
					t.Fatalf("Check = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) || Valid(tt.id, tt.scheme) {
				t.Fatalf("Check = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestThemesIsACopy(t *testing.T) {
	a := Themes()
	a[0].ID = "changed"
	if Themes()[0].ID == "changed" {
		t.Fatal("Themes shares the catalog's slice")
	}
}
