package settings

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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
		{name: "typed values", in: "[threads]\nauto_name = false\nclose_grace_seconds = 5\n[appearance]\ntheme = \"dark\"\n",
			want: map[string]string{"threads.auto_name": "false", "threads.close_grace_seconds": "5", "appearance.theme": "dark"}},
		{name: "lenient string int", in: "[appearance]\nfont_size = \"15\"\n", want: map[string]string{"appearance.font_size": "15"}},
		{name: "float stays a float", in: "[appearance]\nfont_size = 13.5\n", want: map[string]string{"appearance.font_size": "13.5"}},
		{name: "quoted keybinding keys", in: "[keybindings]\n\"thread.new\" = \"cmd+shift+n\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+shift+n"}},
		{name: "unquoted dotted keybinding keys are flattened", in: "[keybindings]\nthread.new = \"cmd+j\"\nproject.worktree.new = \"cmd+alt+n\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+j", "keybindings.project.worktree.new": "cmd+alt+n"}},
		{name: "top-level key", in: "theme = \"dark\"\n", want: map[string]string{"theme": "dark"}},
		{name: "a list reads comma-separated", in: "[plugins]\nregistries = [\"o/a\", \"https://x.example/index.json\"]\n",
			want: map[string]string{"plugins.registries": "o/a, https://x.example/index.json"}},
		{name: "syntax error", in: "[threads\n", wantErr: true},
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

// Retired settings read silently: no "unknown setting" issue, and the next save (render
// of the accepted values) leaves them out of the file.
func TestDecodeRetiredKeys(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    map[string]string
		retired string // the key that must be neither reported nor rendered
	}{
		{name: "projects.worktree_dir is dropped", in: "[projects]\nfetch_interval_seconds = 60\nworktree_dir = \"~/tmp/x\"\n",
			want: map[string]string{"projects.fetch_interval_seconds": "60"}, retired: "projects.worktree_dir"},
		{name: "worktree_dir in another table is not retired", in: "[gitops]\nworktree_dir = \"~/c\"\n",
			want: map[string]string{"gitops.worktree_dir": "~/c"}, retired: "projects.worktree_dir"},
		{name: "threads.show_created_threads is dropped", in: "[threads]\nauto_name = false\nshow_created_threads = true\n",
			want: map[string]string{"threads.auto_name": "false"}, retired: "threads.show_created_threads"},
		{name: "appearance.panel_keep_open is dropped", in: "[appearance]\nfont_size = 14\npanel_keep_open = true\n",
			want: map[string]string{"appearance.font_size": "14"}, retired: "appearance.panel_keep_open"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := decode([]byte(tt.in))
			if err != nil || !maps.Equal(raw, tt.want) {
				t.Fatalf("decode = %v, %v; want %v", raw, err, tt.want)
			}
			r := resolve(raw, testCmds)
			for _, is := range r.issues {
				if is.Key == tt.retired {
					t.Errorf("retired key reported: %+v", is)
				}
			}
			_, field, _ := strings.Cut(tt.retired, ".")
			if out := string(render(r.accepted, nil)); strings.Contains(out, field) {
				t.Errorf("rendered file still has %s:\n%s", tt.retired, out)
			}
		})
	}
}

// A moved setting's old key reads as the new one, and the next save writes only the
// new key.
func TestDecodeMovedKeys(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want map[string]string
	}{
		{name: "threads.naming_model becomes models.utility", in: "[threads]\nauto_name = false\nnaming_model = \"claude-4.5-haiku[1m]\"\n",
			want: map[string]string{"threads.auto_name": "false", KeyUtilityModel: "claude-4.5-haiku[1m]"}},
		{name: "the new key wins over the old", in: "[threads]\nnaming_model = \"claude-4.5-haiku[1m]\"\n[models]\nutility = \"claude-haiku-5-5[1m]\"\n",
			want: map[string]string{KeyUtilityModel: "claude-haiku-5-5[1m]"}},
		{name: "an empty new key: the old value moves", in: "[threads]\nnaming_model = \"claude-haiku-5-5[1m]\"\n[models]\nutility = \"\"\n",
			want: map[string]string{KeyUtilityModel: "claude-haiku-5-5[1m]"}},
		{name: "the new key alone", in: "[models]\nutility = \"claude-haiku-5-5[1m]\"\n",
			want: map[string]string{KeyUtilityModel: "claude-haiku-5-5[1m]"}},
		{name: "an invalid old value moves and is reported under the new key", in: "[threads]\nnaming_model = \"gpt-5\"\n",
			want: map[string]string{KeyUtilityModel: "gpt-5"}},
		{name: "naming_model in another table does not move", in: "[gitops]\nnaming_model = \"x\"\n",
			want: map[string]string{"gitops.naming_model": "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := decode([]byte(tt.in))
			if err != nil || !maps.Equal(raw, tt.want) {
				t.Fatalf("decode = %v, %v; want %v", raw, err, tt.want)
			}
			r := resolve(raw, testCmds)
			for _, is := range r.issues {
				if is.Key == "threads.naming_model" {
					t.Errorf("old key reported: %+v", is)
				}
			}
			if _, gone := tt.want["gitops.naming_model"]; gone {
				return
			}
			keep, _ := r.fileValues(raw)
			out := string(render(keep, r.issues))
			if strings.Contains(out, "naming_model") {
				t.Errorf("rendered file still has the old key:\n%s", out)
			}
			if v := tt.want[KeyUtilityModel]; !strings.Contains(out, "[models]") || !strings.Contains(out, "\nutility = \""+v+"\"\n") {
				t.Errorf("rendered file lacks utility = %q under [models]:\n%s", v, out)
			}
		})
	}
}

// threads.scrollback_lines moved to appearance.scrollback_lines (the bottom panel's
// shells, beside the terminal font): a file that sets the old key keeps its value, and the
// next save writes it under [appearance] only.
func TestDecodeMovedScrollback(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "the old key moves", in: "[threads]\nscrollback_lines = 5000\n", want: "5000"},
		{name: "the new key wins over the old", in: "[threads]\nscrollback_lines = 5000\n[appearance]\nscrollback_lines = 20000\n", want: "20000"},
		{name: "the new key alone", in: "[appearance]\nscrollback_lines = 20000\n", want: "20000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := decode([]byte(tt.in))
			if err != nil || !maps.Equal(raw, map[string]string{"appearance.scrollback_lines": tt.want}) {
				t.Fatalf("decode = %v, %v; want appearance.scrollback_lines %s", raw, err, tt.want)
			}
			r := resolve(raw, testCmds)
			if got := r.settings.Appearance.ScrollbackLines; strconv.Itoa(got) != tt.want {
				t.Errorf("Appearance.ScrollbackLines = %d, want %s", got, tt.want)
			}
			keep, _ := r.fileValues(raw)
			out := string(render(keep, r.issues))
			if strings.Contains(out, "[threads]\nscrollback_lines") || !strings.Contains(out, "\nscrollback_lines = "+tt.want+"\n") {
				t.Errorf("rendered file does not have scrollback_lines = %s under [appearance] alone:\n%s", tt.want, out)
			}
			if i, j := strings.Index(out, "[appearance]"), strings.Index(out, "\nscrollback_lines = "+tt.want); i < 0 || j < i {
				t.Errorf("scrollback_lines is not under [appearance]:\n%s", out)
			}
		})
	}
}

func TestRenderRoundTrip(t *testing.T) {
	accepted := map[string]string{
		KeyAutoName:                   "false",
		KeyUtilityModel:               "claude-4.5-haiku[1m]",
		KeyFontSize:                   "15",
		KeyFontFamily:                 `Weird "Font" \ Name`,
		KeybindingKey("thread.new"):   "cmd+shift+n",
		KeybindingKey("terminal.new"): "none",
	}
	out := render(accepted, nil)
	text := string(out)
	for _, want := range []string{
		"[threads]\n", "auto_name = false\n", "[models]\n", "utility = \"claude-4.5-haiku[1m]\"\n", "font_size = 15\n", `font_family = "Weird \"Font\" \\ Name"` + "\n",
		"# default_model = \"claude-sonnet-5[1m]\"\n", "# default_effort = \"medium\"\n", "# scrollback_lines = 30000\n", `"thread.new" = "cmd+shift+n"` + "\n",
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
	if raw, err := decode(render(nil, nil)); err != nil || len(raw) != 0 {
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

func TestRead(t *testing.T) {
	tests := []struct {
		name string
		file string // "" = no file
		want string // update.channel
	}{
		{"missing file: defaults", "", ChannelStable},
		{"set", "[update]\nchannel = \"tip\"\n", ChannelTip},
		{"rejected value: default", "[update]\nchannel = \"nightly\"\n", ChannelStable},
		{"syntax error: defaults", "[update\n", ChannelStable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			if tt.file != "" {
				if err := os.WriteFile(path, []byte(tt.file), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := Read(path).Update.Channel; got != tt.want {
				t.Errorf("channel = %q, want %q", got, tt.want)
			}
			if _, err := os.Stat(path); tt.file == "" && err == nil {
				t.Error("Read created the file")
			}
		})
	}
}

// A file written before the Notifications group existed loads with its defaults, keeps
// its own values, and reports no issues.
func TestOlderFileGetsNotificationDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	old := "[threads]\nauto_name = false\n\n[appearance]\ntheme = \"dark\"\n"
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	got := Read(path)
	if got.Threads.AutoName || got.Appearance.Theme != "dark" {
		t.Errorf("own values lost: %+v", got)
	}
	if got.Notifications != Defaults().Notifications {
		t.Errorf("Notifications = %+v, want the defaults %+v", got.Notifications, Defaults().Notifications)
	}
	raw, err := decode([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	r := resolve(raw, nil)
	if len(r.issues) != 0 {
		t.Errorf("issues = %v", r.issues)
	}
	for k, want := range map[string]string{KeyDockBadge: "true", KeyBounce: "true", KeySound: "false", KeySoundVolume: "50", KeyAlertCooldown: "60"} {
		if r.values[k] != want {
			t.Errorf("values[%s] = %q, want %q", k, r.values[k], want)
		}
	}
	// Rendering keeps them commented out at their defaults.
	text := string(render(r.accepted, nil))
	for _, want := range []string{"[notifications]\n", "# dock_badge = true\n", "# sound_volume = 50\n", "# cooldown_seconds = 60\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered file lacks %q", want)
		}
	}
}

func TestThemeSlots(t *testing.T) {
	tests := []struct {
		name string
		file string // "" = no file
		want []string
	}{
		{"missing file", "", nil},
		{"both slots, a gone theme included", "[appearance]\ntheme_dark = \"ocean-dusk\"\ntheme_light = \"gone-paper\"\n", []string{"ocean-dusk", "gone-paper"}},
		{"one slot", "[appearance]\ntheme_light = \"paper\"\n", []string{"paper"}},
		{"syntax error", "[appearance\n", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			if tt.file != "" {
				if err := os.WriteFile(path, []byte(tt.file), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := ThemeSlots(path); !slices.Equal(got, tt.want) {
				t.Errorf("ThemeSlots = %q, want %q", got, tt.want)
			}
		})
	}
}
