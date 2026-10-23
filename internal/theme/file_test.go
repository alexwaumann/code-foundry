package theme

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// validJSON is a user theme copied from GitHub Dark with one pinned slot.
func validJSON(t *testing.T, edit func(m map[string]any)) []byte {
	t.Helper()
	f, ok := Curated("github-dark")
	if !ok {
		t.Fatal("no github-dark in the catalog")
	}
	f.ID, f.Name, f.Pair, f.From = "ocean-dusk", "Ocean Dusk", "", "github-dark"
	f.Overrides = map[string]string{"--cf-accent": "#5FB3B3"}
	var m map[string]any
	if err := json.Unmarshal(f.Marshal(), &m); err != nil {
		t.Fatal(err)
	}
	if edit != nil {
		edit(m)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func base(m map[string]any) map[string]any     { return m["base"].(map[string]any) }
func terminal(m map[string]any) map[string]any { return base(m)["terminal"].(map[string]any) }

func TestParseFile(t *testing.T) {
	tests := []struct {
		name string
		edit func(m map[string]any)
		raw  string // used instead of validJSON when set
		want string // substring of the error; "" = valid
	}{
		{name: "valid"},
		{name: "upper-case hex is normalised", edit: func(m map[string]any) { base(m)["accent"] = " #ABCDEF " }},
		{name: "a created_by", edit: func(m map[string]any) { m["created_by"] = "s-5f963f4547cc" }},
		{name: "no source", edit: func(m map[string]any) { delete(m, "source") }},
		{name: "not JSON", raw: "{", want: "not JSON"},
		{name: "an array", raw: "[]", want: "want a JSON object"},
		{name: "empty", raw: "", want: "empty file"},
		{name: "two values", raw: string(validJSON(t, nil)) + "{}", want: "more than one JSON value"},
		{name: "unknown field", edit: func(m map[string]any) { m["description"] = "x" }, want: `unknown field "description"`},
		{name: "unknown base field", edit: func(m map[string]any) { base(m)["acent"] = "#000000" }, want: `unknown field "acent"`},
		{name: "no id", edit: func(m map[string]any) { delete(m, "id") }, want: "no id"},
		{name: "bad id", edit: func(m map[string]any) { m["id"] = "Ocean_Dusk" }, want: `id "Ocean_Dusk": use lowercase`},
		{name: "no name", edit: func(m map[string]any) { m["name"] = "  " }, want: "no name"},
		{name: "long name", edit: func(m map[string]any) { m["name"] = strings.Repeat("a", 81) }, want: "at most 80"},
		{name: "bad scheme", edit: func(m map[string]any) { m["scheme"] = "sepia" }, want: `scheme "sepia": must be dark or light`},
		{name: "bad from", edit: func(m map[string]any) { m["from"] = "Github Dark" }, want: "from \"Github Dark\" is not a theme id"},
		{name: "from itself", edit: func(m map[string]any) { m["from"] = "ocean-dusk" }, want: "cannot be copied from itself"},
		{name: "bad created_by", edit: func(m map[string]any) { m["created_by"] = "a b" }, want: "not a thread id"},
		{name: "missing base colour", edit: func(m map[string]any) { delete(base(m), "warning") }, want: "base.warning: missing"},
		{name: "short base colour", edit: func(m map[string]any) { base(m)["accent"] = "#12" }, want: `base.accent: "#12" is not #rrggbb`},
		{name: "alpha in base", edit: func(m map[string]any) { base(m)["surface"] = "#11223344" }, want: "base.surface"},
		{name: "bad optional colour", edit: func(m map[string]any) { terminal(m)["cursor"] = "red" }, want: "base.terminal.cursor"},
		{name: "15 ansi", edit: func(m map[string]any) { a := terminal(m)["ansi"].([]any); terminal(m)["ansi"] = a[:15] }, want: "want 16 colours, got 15"},
		{name: "bad ansi", edit: func(m map[string]any) { terminal(m)["ansi"].([]any)[3] = "#zzzzzz" }, want: "ansi[3]"},
		{name: "ansi of numbers", edit: func(m map[string]any) { terminal(m)["ansi"] = []int{1} }, want: "base.terminal.ansi: want a string"},
		{name: "override not a slot name", edit: func(m map[string]any) { m["overrides"] = map[string]any{"--card": "#000000"} }, want: `"--card" is not a slot name`},
		{name: "override bad value", edit: func(m map[string]any) { m["overrides"] = map[string]any{"--cf-accent": "blue"} }, want: `"blue" is not #rrggbb or #rrggbbaa`},
		{name: "override with alpha", edit: func(m map[string]any) { m["overrides"] = map[string]any{"--cf-selection": "#11223344"} }},
		{name: "override of an unknown slot", edit: func(m map[string]any) { m["overrides"] = map[string]any{"--cf-not-a-slot-yet": "#112233"} }, want: `"--cf-not-a-slot-yet" is not a slot`},
		{name: "override of a retired slot", edit: func(m map[string]any) { m["overrides"] = map[string]any{"--cf-icon": "#112233"} }, want: `"--cf-icon" was removed from the app; icons take`},
		{name: "override of a status text slot", edit: func(m map[string]any) {
			m["overrides"] = map[string]any{"--cf-warning-text": "#d29922", "--cf-update-text": "#58a6ff"}
		}},
		{name: "override of a terminal slot", edit: func(m map[string]any) {
			m["overrides"] = map[string]any{"--terminal-ansi-15": "#ffffff", "--sh-flag": "#79c0ff"}
		}},
		{name: "dark scheme on a light surface", edit: func(m map[string]any) { base(m)["surface"] = "#f5ecd9" },
			want: `scheme is "dark" but base.surface #f5ecd9 has OKLab lightness 0.95, a light surface (dark needs at most 0.45): set "scheme": "light", or give a dark surface`},
		{name: "dark scheme on a mid grey", edit: func(m map[string]any) { base(m)["surface"] = "#808080" }, want: "too light for a dark scheme (at most 0.45) and too dark for a light one (at least 0.7)"},
		{name: "light scheme on a dark surface", edit: func(m map[string]any) { m["scheme"] = "light" }, want: `scheme is "light" but base.surface #0d1117`},
		{name: "too big", raw: `{"id":"x","pad":"` + strings.Repeat("x", MaxFileBytes) + `"}`, want: "more than 64 KiB"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := []byte(tt.raw)
			if tt.raw == "" && tt.want != "empty file" {
				data = validJSON(t, tt.edit)
			}
			f, err := ParseFile(data)
			if tt.want != "" {
				if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), tt.want) {
					t.Fatalf("err = %v, want %q", err, tt.want)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if f.Base.Accent != strings.ToLower(strings.TrimSpace(f.Base.Accent)) || f.Overrides != nil && f.Overrides["--cf-accent"] == "#5FB3B3" {
				t.Errorf("not normalised: %+v", f)
			}
			// What Marshal writes reads back the same.
			again, err := ParseFile(f.Marshal())
			if err != nil || string(again.Marshal()) != string(f.Marshal()) {
				t.Errorf("round trip: %v\n%s\n%s", err, f.Marshal(), again.Marshal())
			}
		})
	}
}

func TestCuratedFilesValidate(t *testing.T) {
	for _, th := range Themes() {
		f, ok := Curated(th.ID)
		if !ok {
			t.Fatalf("%s: no file", th.ID)
		}
		if err := f.Validate(); err != nil {
			t.Errorf("%s: %v", th.ID, err)
		}
		if f.Name != th.Name || f.Scheme != th.Scheme || f.Pair != th.Pair || f.From != "" || f.Source == "" {
			t.Errorf("%s: file %+v does not match its entry %+v", th.ID, f.Theme(), th)
		}
		if !IsCurated(th.ID) {
			t.Errorf("IsCurated(%s) = false", th.ID)
		}
	}
	// A copy is a copy.
	a, _ := Curated("catppuccin-latte")
	a.Base.Terminal.ANSI[0] = "#000000"
	a.Overrides["--syn-kw"] = "#000000"
	if b, _ := Curated("catppuccin-latte"); b.Base.Terminal.ANSI[0] == "#000000" || b.Overrides["--syn-kw"] == "#000000" {
		t.Error("Curated shares its slices or maps")
	}
	if _, ok := Curated("sepia"); ok || IsCurated("sepia") {
		t.Error("sepia is curated?")
	}
}

func TestReadHeader(t *testing.T) {
	tests := []struct {
		data string
		want Header
		ok   bool
	}{
		{`{"id":"a","scheme":"dark","from":"nord","base":7}`, Header{ID: "a", Scheme: "dark", From: "nord"}, true},
		{`{"id":3,"from":"nord"}`, Header{From: "nord"}, true},
		{`{"id":"a",`, Header{}, false},
		{`[]`, Header{}, false},
	}
	for _, tt := range tests {
		got, ok := ReadHeader([]byte(tt.data))
		if got != tt.want || ok != tt.ok {
			t.Errorf("ReadHeader(%s) = %+v, %v; want %+v, %v", tt.data, got, ok, tt.want, tt.ok)
		}
	}
}
