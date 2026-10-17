package settings

import (
	"maps"
	"os"
	"path/filepath"
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
		{name: "typed values", in: "[threads]\nauto_name = false\nscrollback_lines = 5000\n[appearance]\ntheme = \"dark\"\n",
			want: map[string]string{"threads.auto_name": "false", "threads.scrollback_lines": "5000", "appearance.theme": "dark"}},
		{name: "lenient string int", in: "[appearance]\nfont_size = \"15\"\n", want: map[string]string{"appearance.font_size": "15"}},
		{name: "float stays a float", in: "[appearance]\nfont_size = 13.5\n", want: map[string]string{"appearance.font_size": "13.5"}},
		{name: "quoted keybinding keys", in: "[keybindings]\n\"thread.new\" = \"cmd+shift+n\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+shift+n"}},
		{name: "unquoted dotted keybinding keys are flattened", in: "[keybindings]\nthread.new = \"cmd+j\"\nproject.worktree.new = \"cmd+alt+n\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+j", "keybindings.project.worktree.new": "cmd+alt+n"}},
		{name: "top-level key", in: "theme = \"dark\"\n", want: map[string]string{"theme": "dark"}},
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

// Files written before threads were renamed from sessions: [sessions] and the session.*
// keybindings read as [threads] and thread.*. Files written before projects were renamed
// from repos: [repos] and the repo.* keybindings read as [projects] and project.*.
func TestDecodeLegacyNames(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want map[string]string
	}{
		{name: "[sessions] is [threads]", in: "[sessions]\nauto_name = false\ndefault_effort = \"max\"\n",
			want: map[string]string{"threads.auto_name": "false", "threads.default_effort": "max"}},
		{name: "quoted session.* keybindings are thread.*", in: "[keybindings]\n\"session.new\" = \"cmd+shift+n\"\n\"session.rename\" = \"none\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+shift+n", "keybindings.thread.rename": "none"}},
		{name: "unquoted session.* keybindings are thread.*", in: "[keybindings]\nsession.new = \"cmd+j\"\nproject.worktree.new = \"cmd+alt+n\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+j", "keybindings.project.worktree.new": "cmd+alt+n"}},
		{name: "[repos] is [projects]", in: "[repos]\nfetch_interval_seconds = 60\n",
			want: map[string]string{"projects.fetch_interval_seconds": "60"}},
		{name: "repo.* keybindings are project.*", in: "[keybindings]\n\"repo.worktree.new\" = \"cmd+alt+n\"\nrepo.refresh = \"none\"\n\"ui.focus.repo\" = \"cmd+5\"\n\"workspace.add-repo\" = \"cmd+6\"\n\"workspace.remove-repo\" = \"cmd+7\"\n",
			want: map[string]string{"keybindings.project.worktree.new": "cmd+alt+n", "keybindings.project.refresh": "none", "keybindings.ui.focus.project": "cmd+5",
				"keybindings.workspace.add-project": "cmd+6", "keybindings.workspace.remove-project": "cmd+7"}},
		{name: "[projects] wins over [repos]", in: "[repos]\nfetch_interval_seconds = 60\n[projects]\nfetch_interval_seconds = 0\n",
			want: map[string]string{"projects.fetch_interval_seconds": "0"}},
		{name: "repository-like keybindings are left alone", in: "[keybindings]\n\"repository.x\" = \"cmd+8\"\n",
			want: map[string]string{"keybindings.repository.x": "cmd+8"}},
		{name: "the new name wins when both are set", in: "[sessions]\nauto_name = false\nfont_size = 9\n[threads]\nauto_name = true\n[keybindings]\n\"session.new\" = \"cmd+1\"\n\"thread.new\" = \"cmd+2\"\n",
			want: map[string]string{"threads.auto_name": "true", "threads.font_size": "9", "keybindings.thread.new": "cmd+2"}},
		{name: "other groups and keybindings are left alone", in: "[appearance]\ntheme = \"dark\"\n[keybindings]\n\"sessionx.new\" = \"cmd+3\"\n\"terminal.new\" = \"cmd+t\"\n",
			want: map[string]string{"appearance.theme": "dark", "keybindings.sessionx.new": "cmd+3", "keybindings.terminal.new": "cmd+t"}},
		{name: "a top-level sessions key is not a table", in: "sessions = \"x\"\n", want: map[string]string{"sessions": "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decode([]byte(tt.in))
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
		name string
		in   string
		want map[string]string
	}{
		{name: "projects.worktree_dir is dropped", in: "[projects]\nfetch_interval_seconds = 60\nworktree_dir = \"~/tmp/x\"\n",
			want: map[string]string{"projects.fetch_interval_seconds": "60"}},
		{name: "legacy repos.worktree_dir is dropped", in: "[repos]\nworktree_dir = \"~/wt/{repo}\"\n",
			want: map[string]string{}},
		{name: "both names are dropped", in: "[repos]\nworktree_dir = \"~/a\"\n[projects]\nworktree_dir = \"~/b\"\n",
			want: map[string]string{}},
		{name: "worktree_dir in another table is not retired", in: "[gitops]\nworktree_dir = \"~/c\"\n",
			want: map[string]string{"gitops.worktree_dir": "~/c"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := decode([]byte(tt.in))
			if err != nil || !maps.Equal(raw, tt.want) {
				t.Fatalf("decode = %v, %v; want %v", raw, err, tt.want)
			}
			r := resolve(raw, testCmds)
			for _, is := range r.issues {
				if strings.Contains(is.Key, "worktree_dir") && strings.HasPrefix(is.Key, GroupProjects) {
					t.Errorf("retired key reported: %+v", is)
				}
			}
			if strings.Contains(string(render(r.accepted)), "worktree_dir") {
				t.Errorf("rendered file still has worktree_dir")
			}
		})
	}
}

func TestRenderRoundTrip(t *testing.T) {
	accepted := map[string]string{
		KeyAutoName:                   "false",
		KeyNamingModel:                "claude-4.5-haiku[1m]",
		KeyFontSize:                   "15",
		KeyFontFamily:                 `Weird "Font" \ Name`,
		KeybindingKey("thread.new"):   "cmd+shift+n",
		KeybindingKey("terminal.new"): "none",
	}
	out := render(accepted)
	text := string(out)
	for _, want := range []string{
		"[threads]\n", "auto_name = false\n", "naming_model = \"claude-4.5-haiku[1m]\"\n", "font_size = 15\n", `font_family = "Weird \"Font\" \\ Name"` + "\n",
		"# default_model = \"claude-opus-4-8[1m]\"\n", "# default_effort = \"high\"\n", "# scrollback_lines = 10000\n", `"thread.new" = "cmd+shift+n"` + "\n",
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
	old := "[sessions]\nauto_name = false\n\n[appearance]\ntheme = \"dark\"\n"
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
	text := string(render(r.accepted))
	for _, want := range []string{"[notifications]\n", "# dock_badge = true\n", "# sound_volume = 50\n", "# cooldown_seconds = 60\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered file lacks %q", want)
		}
	}
}
