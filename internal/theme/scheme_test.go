package theme

import (
	"math"
	"testing"
)

// TestSchemeProblem holds the port to the GUI: the lightness and both messages are what
// src/themes/slots.ts schemeProblem and color.ts lightness give for the same surfaces
// (printed with tsx and pasted).
func TestSchemeProblem(t *testing.T) {
	tests := []struct {
		surface     string
		l           float64
		dark, light string
	}{
		{"#0d1117", 0.17628498039731322, "", `scheme is "light" but base.surface #0d1117 has OKLab lightness 0.18, a dark surface (light needs at least 0.7): set "scheme": "dark", or give a light surface`},
		{"#ffffff", 0.9999999934735462, `scheme is "dark" but base.surface #ffffff has OKLab lightness 1.00, a light surface (dark needs at most 0.45): set "scheme": "light", or give a dark surface`, ""},
		{"#f5ecd9", 0.9450873378296781, `scheme is "dark" but base.surface #f5ecd9 has OKLab lightness 0.95, a light surface (dark needs at most 0.45): set "scheme": "light", or give a dark surface`, ""},
		{"#808080", 0.5998708017071177,
			`base.surface #808080 has OKLab lightness 0.60, too light for a dark scheme (at most 0.45) and too dark for a light one (at least 0.7): darken it for "dark" or lighten it for "light"`,
			`base.surface #808080 has OKLab lightness 0.60, too dark for a light scheme (at least 0.7) and too light for a dark one (at most 0.45): lighten it for "light" or darken it for "dark"`},
		{"#16232f", 0.25007972525778543, "", `scheme is "light" but base.surface #16232f has OKLab lightness 0.25, a dark surface (light needs at least 0.7): set "scheme": "dark", or give a light surface`},
		{"#a0a0a0", 0.7057570076359392, `scheme is "dark" but base.surface #a0a0a0 has OKLab lightness 0.71, a light surface (dark needs at most 0.45): set "scheme": "light", or give a dark surface`, ""},
		{"#000000", 0, "", `scheme is "light" but base.surface #000000 has OKLab lightness 0.00, a dark surface (light needs at least 0.7): set "scheme": "dark", or give a light surface`},
	}
	for _, tt := range tests {
		l, ok := oklabLightness(tt.surface)
		if !ok || math.Abs(l-tt.l) > 1e-9 {
			t.Errorf("lightness(%s) = %v, %v; want %v", tt.surface, l, ok, tt.l)
		}
		if got := SchemeProblem(SchemeDark, tt.surface); got != tt.dark {
			t.Errorf("dark on %s:\n got %q\nwant %q", tt.surface, got, tt.dark)
		}
		if got := SchemeProblem(SchemeLight, tt.surface); got != tt.light {
			t.Errorf("light on %s:\n got %q\nwant %q", tt.surface, got, tt.light)
		}
	}
	if _, ok := oklabLightness("#fff"); ok {
		t.Error("#fff is not #rrggbb")
	}
}

func TestIsSlot(t *testing.T) {
	for name, want := range map[string]bool{"--cf-text": true, "--cf-warning-text": true, "--terminal-ansi-15": true, "--sh-str": true, "--cf-icon": false, "--cf-sidebar-row-active": false, "--card": false} {
		if IsSlot(name) != want {
			t.Errorf("IsSlot(%s) = %v", name, !want)
		}
	}
}

func TestParseStoredDropsRetiredSlots(t *testing.T) {
	data := validJSON(t, func(m map[string]any) {
		m["overrides"] = map[string]any{"--cf-icon": "#112233", "--cf-sidebar-row-active": "#223344", "--cf-accent": "#5fb3b3"}
	})
	if _, err := ParseFile(data); err == nil {
		t.Fatal("ParseFile took a retired slot")
	}
	f, dropped, err := ParseStored(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(dropped) != 2 || dropped[0] != "--cf-icon" || dropped[1] != "--cf-sidebar-row-active" {
		t.Errorf("dropped = %v", dropped)
	}
	if len(f.Overrides) != 1 || f.Overrides["--cf-accent"] != "#5fb3b3" {
		t.Errorf("overrides = %v", f.Overrides)
	}
	// Only retired ones: no overrides left at all.
	f, _, err = ParseStored(validJSON(t, func(m map[string]any) { m["overrides"] = map[string]any{"--cf-icon": "#112233"} }))
	if err != nil || f.Overrides != nil {
		t.Errorf("overrides = %v, err %v", f.Overrides, err)
	}
	// An unknown (not retired) slot is refused either way.
	if _, _, err := ParseStored(validJSON(t, func(m map[string]any) { m["overrides"] = map[string]any{"--cf-txet": "#112233"} })); err == nil {
		t.Error("ParseStored took an unknown slot")
	}
}
