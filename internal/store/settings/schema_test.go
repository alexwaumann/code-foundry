package settings

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func field(t *testing.T, key string) Field {
	t.Helper()
	for _, f := range staticFields {
		if f.Key == key {
			return f
		}
	}
	t.Fatalf("no field %s", key)
	return Field{}
}

func TestFieldParse(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(t.TempDir(), "plain")
	if err := os.WriteFile(plain, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		key, in, want, err string
	}{
		{key: KeyAutoName, in: "false", want: "false"},
		{key: KeyAutoName, in: "1", want: "true"},
		{key: KeyAutoName, in: "yes", err: `want true or false, got "yes"`},
		{key: KeyFontSize, in: "14", want: "14"},
		{key: KeyFontSize, in: " 14 ", want: "14"},
		{key: KeyFontSize, in: "8", err: "want 9 to 28, got 8"},
		{key: KeyFontSize, in: "13.5", err: `want an integer, got "13.5"`},
		{key: KeyFetchInterval, in: "0", want: "0"},
		{key: KeyDefaultModel, in: "claude-opus-4-8[1m]", want: "claude-opus-4-8[1m]"},
		{key: KeyDefaultModel, in: "claude-opus-5-5[1m]", want: "claude-opus-5-5[1m]"},
		{key: KeyDefaultModel, in: "gpt-5", err: `want one of "claude-opus-5-5[1m]", "claude-opus-4-8[1m]", "claude-opus-4-7[1m]", "claude-sonnet-5-5[1m]", "claude-sonnet-5[1m]", "claude-sonnet-4-6[1m]", "claude-haiku-5-5[1m]", "claude-4.5-haiku[1m]", got "gpt-5"`},
		// Retired aliases and unsuffixed ids are rejected.
		{key: KeyDefaultModel, in: "opus", err: `want one of "claude-opus-5-5[1m]", "claude-opus-4-8[1m]", "claude-opus-4-7[1m]", "claude-sonnet-5-5[1m]", "claude-sonnet-5[1m]", "claude-sonnet-4-6[1m]", "claude-haiku-5-5[1m]", "claude-4.5-haiku[1m]", got "opus"`},
		{key: KeyDefaultModel, in: "claude-opus-4-8", err: `want one of "claude-opus-5-5[1m]", "claude-opus-4-8[1m]", "claude-opus-4-7[1m]", "claude-sonnet-5-5[1m]", "claude-sonnet-5[1m]", "claude-sonnet-4-6[1m]", "claude-haiku-5-5[1m]", "claude-4.5-haiku[1m]", got "claude-opus-4-8"`},
		{key: KeyNamingModel, in: "claude-4.5-haiku[1m]", want: "claude-4.5-haiku[1m]"},
		{key: KeyNamingModel, in: "claude-opus-4-8[1m]", want: "claude-opus-4-8[1m]"},
		{key: KeyTheme, in: "Dark", err: `want one of "system", "dark", "light", got "Dark"`},
		{key: KeyBackdrop, in: "none", want: "none"},
		{key: KeyBackdrop, in: "aurora", err: `want one of "forest", "none", got "aurora"`},
		{key: KeyThreadWidth, in: "full", want: "full"},
		{key: KeyThreadWidth, in: "wide", err: `want one of "compact", "comfortable", "full", got "wide"`},
		{key: KeyWorktreeDir, in: "~/wt/{repo}", want: "~/wt/{repo}"},
		{key: KeyWorktreeDir, in: "wt", err: `want an absolute path, got "wt"`},
		{key: KeyClaudePath, in: exe, want: exe},
		{key: KeyClaudePath, in: plain, err: plain + " is not an executable file"},
		{key: KeyClaudePath, in: "/nope/claude", err: "/nope/claude does not exist"},
		{key: KeyFontFamily, in: "Iosevka", want: "Iosevka"},
		{key: KeyDockBadge, in: "false", want: "false"},
		{key: KeySound, in: "on", err: `want true or false, got "on"`},
		{key: KeySoundVolume, in: "0", want: "0"},
		{key: KeySoundVolume, in: "100", want: "100"},
		{key: KeySoundVolume, in: "101", err: "want 0 to 100, got 101"},
		{key: KeyAlertCooldown, in: "0", want: "0"},
		{key: KeyAlertCooldown, in: "3600", want: "3600"},
		{key: KeyAlertCooldown, in: "-1", err: "want 0 to 3600, got -1"},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.in, func(t *testing.T) {
			got, err := field(t, tt.key).parse(tt.in)
			if tt.err != "" {
				if err == nil || err.Error() != tt.err {
					t.Fatalf("err = %v, want %q", err, tt.err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("parse = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestSchemaShape(t *testing.T) {
	groups := map[string]bool{}
	for _, g := range Groups {
		groups[g.ID] = true
	}
	seen := map[string]bool{}
	for _, f := range staticFields {
		if seen[f.Key] {
			t.Errorf("%s declared twice", f.Key)
		}
		seen[f.Key] = true
		if !groups[f.Group] || !strings.HasPrefix(f.Key, f.Group+".") {
			t.Errorf("%s: group %q does not prefix the key", f.Key, f.Group)
		}
		if f.Title == "" || f.Description == "" || f.bind == nil {
			t.Errorf("%s: title, description and bind are required", f.Key)
		}
		if f.Default != "" {
			if got, err := f.parse(f.Default); err != nil || got != f.Default {
				t.Errorf("%s: default %q does not parse canonically: %q, %v", f.Key, f.Default, got, err)
			}
		}
		if f.Type == Enum && !slices.Contains(f.Enum, f.Default) {
			t.Errorf("%s: default %q is not an enum value", f.Key, f.Default)
		}
		if len(f.EnumLabels) > 0 && len(f.EnumLabels) != len(f.Enum) {
			t.Errorf("%s: %d enum labels for %d values", f.Key, len(f.EnumLabels), len(f.Enum))
		}
	}
	d := Defaults()
	if d.Appearance.FontSize != 13 || !d.Sessions.AutoName || d.Sessions.ScrollbackLines != 10000 || d.Appearance.Theme != "system" || d.Appearance.Backdrop != "forest" ||
		d.Appearance.ThreadWidth != "comfortable" ||
		d.GitHub.PollIntervalSeconds != 60 || d.Repos.FetchIntervalSeconds != 120 || d.Advanced.LogLevel != "info" {
		t.Errorf("Defaults() = %+v", d)
	}
}

func TestEnumLabels(t *testing.T) {
	tests := []struct {
		key, value, want string
	}{
		{KeyDefaultModel, "claude-opus-5-5[1m]", "Opus 5.5"},
		{KeyDefaultModel, "claude-opus-4-8[1m]", "Opus 4.8"},
		{KeyDefaultModel, "claude-sonnet-4-6[1m]", "Sonnet 4.6"},
		{KeyDefaultModel, "claude-4.5-haiku[1m]", "Haiku 4.5"},
		{KeyNamingModel, "claude-sonnet-5[1m]", "Sonnet 5"},
		{KeyNamingModel, "claude-haiku-5-5[1m]", "Haiku 5.5"},
		// Fields without labels show their values as they are.
		{KeyTheme, "dark", ""},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.value, func(t *testing.T) {
			f := field(t, tt.key)
			i := slices.Index(f.Enum, tt.value)
			if i < 0 {
				t.Fatalf("%q is not an enum value of %s", tt.value, tt.key)
			}
			got := ""
			if len(f.EnumLabels) > 0 {
				got = f.EnumLabels[i]
			}
			if got != tt.want {
				t.Errorf("label = %q, want %q", got, tt.want)
			}
		})
	}
	if f := field(t, KeyDefaultModel); f.Default != "claude-opus-4-8[1m]" {
		t.Errorf("default model = %q, want Opus 4.8", f.Default)
	}
}

func TestNamingModelField(t *testing.T) {
	f := field(t, KeyNamingModel)
	if f.Default != "claude-sonnet-5[1m]" || Defaults().Sessions.NamingModel != "claude-sonnet-5[1m]" {
		t.Errorf("default = %q, Defaults() = %q; want Sonnet 5", f.Default, Defaults().Sessions.NamingModel)
	}
	if f.Group != GroupSessions || f.Restart || !slices.Equal(f.Enum, field(t, KeyDefaultModel).Enum) ||
		!slices.Equal(f.EnumLabels, field(t, KeyDefaultModel).EnumLabels) {
		t.Errorf("field = %+v, want a live Sessions enum over the model registry", f)
	}
	// Directly after "Name sessions automatically".
	if i := slices.IndexFunc(staticFields, func(f Field) bool { return f.Key == KeyAutoName }); staticFields[i+1].Key != KeyNamingModel {
		t.Errorf("field after %s = %s", KeyAutoName, staticFields[i+1].Key)
	}
	for _, in := range []string{"", "gpt-5", "Sonnet", "sonnet"} {
		if _, err := f.parse(in); err == nil || !strings.HasPrefix(err.Error(), "want one of ") {
			t.Errorf("parse(%q) err = %v, want an enum error", in, err)
		}
	}
}

var testCmds = []CommandInfo{
	{Name: "session.new", Title: "New Session", Category: "Session", Keybindings: []string{"cmd+n"}},
	{Name: "terminal.new", Title: "New Terminal", Category: "Terminal", Keybindings: []string{"cmd+t"}},
	{Name: "repo.refresh", Title: "Refresh", Category: "Repository"},
}

func TestResolveKeybindings(t *testing.T) {
	tests := []struct {
		name      string
		raw       map[string]string
		cmds      []CommandInfo
		wantOver  map[string]string
		wantIssue map[string]string // key -> message
		wantValue map[string]string
	}{
		{name: "defaults", cmds: testCmds, wantOver: map[string]string{},
			wantValue: map[string]string{"keybindings.session.new": "cmd+n", "keybindings.repo.refresh": ""}},
		{name: "override normalizes", cmds: testCmds, raw: map[string]string{"keybindings.repo.refresh": "Alt+Cmd+R"},
			wantOver: map[string]string{"repo.refresh": "cmd+alt+r"}, wantValue: map[string]string{"keybindings.repo.refresh": "cmd+alt+r"}},
		{name: "none unbinds", cmds: testCmds, raw: map[string]string{"keybindings.session.new": "NONE"},
			wantOver: map[string]string{"session.new": "none"}, wantValue: map[string]string{"keybindings.session.new": "none"}},
		{name: "reserved chord", cmds: testCmds, raw: map[string]string{"keybindings.session.new": "cmd+k"},
			wantOver: map[string]string{}, wantIssue: map[string]string{"keybindings.session.new": "cmd+k is reserved by the app"},
			wantValue: map[string]string{"keybindings.session.new": "cmd+n"}},
		{name: "collides with a default", cmds: testCmds, raw: map[string]string{"keybindings.repo.refresh": "cmd+t"},
			wantOver: map[string]string{}, wantIssue: map[string]string{"keybindings.repo.refresh": "cmd+t is already bound to terminal.new"}},
		{name: "unbinding frees the chord", cmds: testCmds,
			raw:      map[string]string{"keybindings.terminal.new": "none", "keybindings.repo.refresh": "cmd+t"},
			wantOver: map[string]string{"terminal.new": "none", "repo.refresh": "cmd+t"}},
		{name: "swap", cmds: testCmds,
			raw:      map[string]string{"keybindings.terminal.new": "cmd+n", "keybindings.session.new": "cmd+t"},
			wantOver: map[string]string{"terminal.new": "cmd+n", "session.new": "cmd+t"}},
		{name: "two overrides collide", cmds: testCmds,
			raw:      map[string]string{"keybindings.terminal.new": "cmd+j", "keybindings.session.new": "cmd+j"},
			wantOver: map[string]string{},
			wantIssue: map[string]string{
				"keybindings.terminal.new": "cmd+j is already bound to session.new",
				"keybindings.session.new":  "cmd+j is already bound to terminal.new",
			}},
		{name: "unknown command", cmds: testCmds, raw: map[string]string{"keybindings.nope.nope": "cmd+j"},
			wantOver: map[string]string{}, wantIssue: map[string]string{"keybindings.nope.nope": `unknown command "nope.nope"`}},
		{name: "syntax only before commands are known", raw: map[string]string{"keybindings.nope.nope": "cmd+j", "keybindings.x.y": "cmd+q"},
			wantOver: map[string]string{"nope.nope": "cmd+j"}, wantIssue: map[string]string{"keybindings.x.y": "cmd+q is reserved by the app"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			over, values, issues := resolveKeybindings(tt.raw, tt.cmds)
			if !maps.Equal(over, tt.wantOver) {
				t.Errorf("overrides = %v, want %v", over, tt.wantOver)
			}
			got := map[string]string{}
			for _, is := range issues {
				got[is.Key] = is.Message
			}
			if !maps.Equal(got, tt.wantIssue) && !(len(got) == 0 && len(tt.wantIssue) == 0) {
				t.Errorf("issues = %v, want %v", got, tt.wantIssue)
			}
			for k, v := range tt.wantValue {
				if values[k] != v {
					t.Errorf("values[%s] = %q, want %q", k, values[k], v)
				}
			}
		})
	}
}

func TestKeybindingFields(t *testing.T) {
	fs := keybindingFields(testCmds)
	var keys []string
	for _, f := range fs {
		keys = append(keys, f.Key)
	}
	// Sorted by category, then title.
	want := []string{"keybindings.repo.refresh", "keybindings.session.new", "keybindings.terminal.new"}
	if !slices.Equal(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	if fs[1].Default != "cmd+n" || fs[1].Type != Keybinding || fs[1].Title != "Session: New Session" || fs[0].Default != "" {
		t.Errorf("fields = %+v", fs)
	}
}

func TestCacheTTLField(t *testing.T) {
	f := field(t, KeyCacheTTL)
	if f.Default != "3600" || f.Type != Int || f.Group != GroupSessions || f.Restart || f.Min != 60 || f.Max != 86400 {
		t.Errorf("field = %+v", f)
	}
	if got := Defaults(); got.Sessions.CacheTTLSeconds != 3600 || got.CacheTTL() != time.Hour {
		t.Errorf("Defaults() cache TTL = %d (%v)", got.Sessions.CacheTTLSeconds, got.CacheTTL())
	}
	if i := slices.IndexFunc(staticFields, func(f Field) bool { return f.Key == KeyNamingModel }); staticFields[i+1].Key != KeyCacheTTL {
		t.Errorf("field after %s = %s", KeyNamingModel, staticFields[i+1].Key)
	}
	tests := []struct {
		in string
		ok bool
	}{{"60", true}, {"300", true}, {"86400", true}, {"59", false}, {"86401", false}, {"", false}, {"1h", false}}
	for _, tt := range tests {
		if _, err := f.parse(tt.in); (err == nil) != tt.ok {
			t.Errorf("parse(%q) err = %v, want ok %v", tt.in, err, tt.ok)
		}
	}
}

func TestNotificationFields(t *testing.T) {
	tests := []struct {
		key      string
		typ      Type
		def      string
		min, max int
	}{
		{KeyDockBadge, Bool, "true", 0, 0},
		{KeyBounce, Bool, "true", 0, 0},
		{KeySound, Bool, "false", 0, 0},
		{KeySoundVolume, Int, "50", 0, 100},
		{KeyAlertCooldown, Int, "60", 0, 3600},
	}
	var keys []string
	for _, tt := range tests {
		keys = append(keys, tt.key)
		f := field(t, tt.key)
		// All live: the GUI reads them from every snapshot.
		if f.Group != GroupNotify || f.Type != tt.typ || f.Default != tt.def || f.Min != tt.min || f.Max != tt.max || f.Restart {
			t.Errorf("%s = %+v", tt.key, f)
		}
	}
	// In display order, as one run of fields.
	i := slices.IndexFunc(staticFields, func(f Field) bool { return f.Key == KeyDockBadge })
	var got []string
	for _, f := range staticFields[i : i+len(keys)] {
		got = append(got, f.Key)
	}
	if !slices.Equal(got, keys) {
		t.Errorf("field order = %v, want %v", got, keys)
	}
	// The group sits right after Appearance.
	g := slices.IndexFunc(Groups, func(g Group) bool { return g.ID == GroupNotify })
	if g < 1 || Groups[g-1].ID != GroupAppearance {
		t.Errorf("Notifications group at %d, want after Appearance", g)
	}
	want := Notifications{DockBadge: true, Bounce: true, Sound: false, SoundVolume: 50, CooldownSeconds: 60}
	if got := Defaults().Notifications; got != want {
		t.Errorf("Defaults().Notifications = %+v, want %+v", got, want)
	}
}

func TestDefaultWorktreeField(t *testing.T) {
	f := field(t, KeyDefaultWorktree)
	// Live (the composer reads every snapshot), in Sessions, right after the default effort.
	if f.Group != GroupSessions || f.Type != Enum || f.Default != WorktreeNew || f.Restart || f.Title != "New threads work in" {
		t.Errorf("field = %+v", f)
	}
	if i := slices.IndexFunc(staticFields, func(f Field) bool { return f.Key == KeyDefaultEffort }); staticFields[i+1].Key != KeyDefaultWorktree {
		t.Errorf("field after %s = %s", KeyDefaultEffort, staticFields[i+1].Key)
	}
	if got := Defaults().Sessions.DefaultWorktree; got != WorktreeNew {
		t.Errorf("Defaults().Sessions.DefaultWorktree = %q, want %q", got, WorktreeNew)
	}
	tests := []struct {
		in, label string
		ok        bool
	}{
		{"new", "A fresh copy of the project", true},
		{"current", "The project folder itself", true},
		{"", "", false},
		{"existing", "", false},
		{"New", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := f.parse(tt.in)
			if (err == nil) != tt.ok || (tt.ok && got != tt.in) {
				t.Fatalf("parse(%q) = %q, %v; want ok=%v", tt.in, got, err, tt.ok)
			}
			if tt.ok {
				if label := f.EnumLabels[slices.Index(f.Enum, tt.in)]; label != tt.label {
					t.Errorf("label = %q, want %q", label, tt.label)
				}
			}
		})
	}
}
