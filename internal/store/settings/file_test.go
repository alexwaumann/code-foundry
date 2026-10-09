package settings

import (
	"maps"
	"strings"
	"testing"
)

func TestDecode(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    map[string]string
		wantErr bool
	}{
		{name: "empty", in: "", want: map[string]string{}},
		{name: "typed values", in: "[sessions]\nauto_name = false\nscrollback_lines = 5000\n[appearance]\ntheme = \"dark\"\n",
			want: map[string]string{"sessions.auto_name": "false", "sessions.scrollback_lines": "5000", "appearance.theme": "dark"}},
		{name: "lenient string int", in: "[appearance]\nfont_size = \"15\"\n", want: map[string]string{"appearance.font_size": "15"}},
		{name: "float stays a float", in: "[appearance]\nfont_size = 13.5\n", want: map[string]string{"appearance.font_size": "13.5"}},
		{name: "quoted keybinding keys", in: "[keybindings]\n\"session.new\" = \"cmd+shift+n\"\n",
			want: map[string]string{"keybindings.session.new": "cmd+shift+n"}},
		{name: "unquoted dotted keybinding keys are flattened", in: "[keybindings]\nsession.new = \"cmd+j\"\nrepo.worktree.new = \"cmd+alt+n\"\n",
			want: map[string]string{"keybindings.session.new": "cmd+j", "keybindings.repo.worktree.new": "cmd+alt+n"}},
		{name: "top-level key", in: "theme = \"dark\"\n", want: map[string]string{"theme": "dark"}},
		{name: "syntax error", in: "[sessions\n", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decode([]byte(tt.in))
			if tt.wantErr {
				if err == nil {
					t.Fatal("want an error")
				}
				return
			}
			if err != nil || !maps.Equal(got, tt.want) {
				t.Fatalf("decode = %v, %v; want %v", got, err, tt.want)
			}
		})
	}
}

func TestRenderRoundTrip(t *testing.T) {
	accepted := map[string]string{
		KeyAutoName:                   "false",
		KeyFontSize:                   "15",
		KeyFontFamily:                 `Weird "Font" \ Name`,
		KeyWorktreeDir:                "~/wt/{repo}",
		KeybindingKey("session.new"):  "cmd+shift+n",
		KeybindingKey("terminal.new"): "none",
	}
	out := render(accepted)
	text := string(out)
	for _, want := range []string{
		"[sessions]\n", "auto_name = false\n", "font_size = 15\n", `font_family = "Weird \"Font\" \\ Name"` + "\n",
		"# default_model = \"opus\"\n", "# default_effort = \"high\"\n", "# scrollback_lines = 10000\n", `"session.new" = "cmd+shift+n"` + "\n",
		"Applies after a daemon restart.",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered file lacks %q:\n%s", want, text)
		}
	}
	raw, err := decode(out)
	if err != nil {
		t.Fatalf("rendered file does not parse: %v\n%s", err, text)
	}
	if !maps.Equal(raw, accepted) {
		t.Fatalf("round trip = %v, want %v", raw, accepted)
	}
	r := resolve(raw, testCmds)
	if len(r.issues) != 0 || !maps.Equal(r.accepted, accepted) {
		t.Fatalf("resolve after round trip: issues %v accepted %v", r.issues, r.accepted)
	}
	// The defaults file parses to nothing set.
	if raw, err := decode(render(nil)); err != nil || len(raw) != 0 {
		t.Fatalf("defaults file = %v, %v", raw, err)
	}
}

func TestTomlString(t *testing.T) {
	tests := []struct{ in, want string }{
		{"plain", `"plain"`},
		{`a"b`, `"a\"b"`},
		{`a\b`, `"a\\b"`},
		{"tab\tnl\n", `"tab\tnl\n"`},
		{"bell\x07", `"bell\u0007"`},
		{"ünï", `"ünï"`},
	}
	for _, tt := range tests {
		if got := tomlString(tt.in); got != tt.want {
			t.Errorf("tomlString(%q) = %s, want %s", tt.in, got, tt.want)
		}
	}
}
