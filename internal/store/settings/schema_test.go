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
		{key: KeyThemeDark, in: "dracula", want: "dracula"},
		{key: KeyThemeLight, in: "rose-pine-dawn", want: "rose-pine-dawn"},
		{key: KeyThemeDark, in: "catppuccin-latte", err: `Catppuccin Latte ("catppuccin-latte") is a light theme; the dark theme must be one of "github-dark", "catppuccin-mocha", "graphite-dark", "dracula", "gruvbox-dark", "nord", "tokyo-night", "rose-pine", "atom-one-dark", "solarized-dark", "monokai-pro", "kanagawa-wave", "everforest-dark-hard", "ayu-mirage", "petros-dusk"`},
		{key: KeyThemeLight, in: "dracula", err: `Dracula ("dracula") is a dark theme; the light theme must be one of "github-light", "catppuccin-latte", "graphite-light", "gruvbox-light", "rose-pine-dawn", "atom-one-light", "solarized-light"`},
		{key: KeyThemeLight, in: "sepia", err: `unknown theme "sepia"; light themes are "github-light", "catppuccin-latte", "graphite-light", "gruvbox-light", "rose-pine-dawn", "atom-one-light", "solarized-light"`},
		{key: KeyBackdrop, in: "none", want: "none"},
		{key: KeyBackdrop, in: "custom", want: "custom"},
		{key: KeyBackdrop, in: "aurora", err: `want one of "forest", "none", "custom", got "aurora"`},
		{key: KeyBackdropFile, in: "0123456789abcdef0123456789abcdef.png", want: "0123456789abcdef0123456789abcdef.png"},
		{key: KeyBackdropFile, in: "my photo.jpg", want: "my photo.jpg"},
		{key: KeyBackdropFile, in: "", want: ""},
		{key: KeyBackdropFile, in: "../settings.toml", err: `want a file name in the backdrops folder, got "../settings.toml"`},
		{key: KeyBackdropFile, in: "/etc/hosts", err: `want a file name in the backdrops folder, got "/etc/hosts"`},
		{key: KeyBackdropFile, in: ".hidden.png", err: `want a file name in the backdrops folder, got ".hidden.png"`},
		{key: KeyPanelKeepOpen, in: "true", want: "true"},
		{key: KeyPanelKeepOpen, in: "yes", err: `want true or false, got "yes"`},
		{key: KeyThreadWidth, in: "full", want: "full"},
		{key: KeyThreadWidth, in: "wide", err: `want one of "compact", "comfortable", "full", got "wide"`},
		{key: KeyClaudePath, in: "wt", err: `want an absolute path, got "wt"`},
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
	if d.Appearance.FontSize != 13 || !d.Threads.AutoName || d.Threads.ScrollbackLines != 10000 || d.Appearance.Theme != "system" || d.Appearance.Backdrop != "forest" ||
		d.Appearance.ThreadWidth != "comfortable" || d.Appearance.PanelKeepOpen ||
		d.GitHub.PollIntervalSeconds != 60 || d.Projects.FetchIntervalSeconds != 120 || d.Advanced.LogLevel != "info" {
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
		{KeyTheme, "system", "System"},
		{KeyThemeDark, "github-dark", "GitHub Dark"},
		{KeyThemeDark, "catppuccin-mocha", "Catppuccin Mocha"},
		{KeyThemeDark, "dracula", "Dracula"},
		{KeyThemeLight, "rose-pine-dawn", "Rosé Pine Dawn"},
		{KeyDefaultEffort, "low", "Low"},
		{KeyDefaultEffort, "xhigh", "Extra high"},
		{KeyDefaultEffort, "max", "Max"},
		{KeyDensity, "compact", "Compact"},
		{KeyThreadWidth, "full", "Full"},
		{KeyBackdrop, "none", "None"},
		{KeyBackdrop, "custom", "Custom"},
		{KeyLogLevel, "warn", "Warn"},
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
}

// TestNewThreadDefaults pins the defaults a fresh install starts from (Alex,
// 2026-10-17): Sonnet 5 at medium effort, Sonnet 4.6 naming, the project folder
// itself, comfortable density.
func TestNewThreadDefaults(t *testing.T) {
	d := Defaults()
	tests := []struct {
		key, want, got string
	}{
		{KeyDefaultModel, "claude-sonnet-5[1m]", d.Threads.DefaultModel},
		{KeyDefaultEffort, "medium", d.Threads.DefaultEffort},
		{KeyNamingModel, "claude-sonnet-4-6[1m]", d.Threads.NamingModel},
		{KeyDefaultWorktree, WorktreeCurrent, d.Threads.DefaultWorktree},
		{KeyDensity, "comfortable", d.Appearance.Density},
	}
	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			if f := field(t, tt.key); f.Default != tt.want || tt.got != tt.want {
				t.Errorf("field default = %q, Defaults() = %q, want %q", f.Default, tt.got, tt.want)
			}
		})
	}
}

func TestNamingModelField(t *testing.T) {
	f := field(t, KeyNamingModel)
	if f.Group != GroupThreads || f.Restart || !slices.Equal(f.Enum, field(t, KeyDefaultModel).Enum) ||
		!slices.Equal(f.EnumLabels, field(t, KeyDefaultModel).EnumLabels) {
		t.Errorf("field = %+v, want a live Threads enum over the model registry", f)
	}
	// Directly after "Name threads automatically".
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
	{Name: "thread.new", Title: "New Thread", Category: "Thread", Keybindings: []string{"cmd+n"}},
	{Name: "terminal.new", Title: "New Terminal", Category: "Terminal", Keybindings: []string{"cmd+t"}},
	{Name: "project.refresh", Title: "Refresh", Category: "Project"},
	{Name: "pr.open", Title: "Open Pull Request", Category: "Pull Request"},
	{Name: "thread.list", Title: "List Threads", Category: "Thread", NoKeybinding: true},
	{Name: "daemon.status", Title: "Daemon Status", Category: "Daemon", NoKeybinding: true},
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
			wantValue: map[string]string{"keybindings.thread.new": "cmd+n", "keybindings.project.refresh": ""}},
		{name: "override normalizes", cmds: testCmds, raw: map[string]string{"keybindings.project.refresh": "Alt+Cmd+R"},
			wantOver: map[string]string{"project.refresh": "cmd+alt+r"}, wantValue: map[string]string{"keybindings.project.refresh": "cmd+alt+r"}},
		{name: "NoKeybinding command", cmds: testCmds, raw: map[string]string{"keybindings.thread.list": "cmd+y"},
			wantOver: map[string]string{}, wantIssue: map[string]string{"keybindings.thread.list": "thread.list cannot have a keybinding"}},
		{name: "none unbinds", cmds: testCmds, raw: map[string]string{"keybindings.thread.new": "NONE"},
			wantOver: map[string]string{"thread.new": "none"}, wantValue: map[string]string{"keybindings.thread.new": "none"}},
		{name: "reserved chord", cmds: testCmds, raw: map[string]string{"keybindings.thread.new": "cmd+k"},
			wantOver: map[string]string{}, wantIssue: map[string]string{"keybindings.thread.new": "cmd+k is reserved by the app"},
			wantValue: map[string]string{"keybindings.thread.new": "cmd+n"}},
		{name: "collides with a default", cmds: testCmds, raw: map[string]string{"keybindings.project.refresh": "cmd+t"},
			wantOver: map[string]string{}, wantIssue: map[string]string{"keybindings.project.refresh": "cmd+t is already bound to terminal.new"}},
		{name: "unbinding frees the chord", cmds: testCmds,
			raw:      map[string]string{"keybindings.terminal.new": "none", "keybindings.project.refresh": "cmd+t"},
			wantOver: map[string]string{"terminal.new": "none", "project.refresh": "cmd+t"}},
		{name: "swap", cmds: testCmds,
			raw:      map[string]string{"keybindings.terminal.new": "cmd+n", "keybindings.thread.new": "cmd+t"},
			wantOver: map[string]string{"terminal.new": "cmd+n", "thread.new": "cmd+t"}},
		{name: "two overrides collide", cmds: testCmds,
			raw:      map[string]string{"keybindings.terminal.new": "cmd+j", "keybindings.thread.new": "cmd+j"},
			wantOver: map[string]string{},
			wantIssue: map[string]string{
				"keybindings.terminal.new": "cmd+j is already bound to thread.new",
				"keybindings.thread.new":   "cmd+j is already bound to terminal.new",
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
	// Sorted by category, then title; NoKeybinding commands left out.
	want := []string{"keybindings.project.refresh", "keybindings.pr.open", "keybindings.terminal.new", "keybindings.thread.new"}
	if !slices.Equal(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	if f := fs[3]; f.Default != "cmd+n" || f.Type != Keybinding || f.Title != "New Thread" || f.Placeholder != "thread.new" ||
		f.Page != PageKeybindings || f.Section != "thread" {
		t.Errorf("thread.new field = %+v", f)
	}
	if fs[1].Section != "pull-request" || fs[0].Default != "" {
		t.Errorf("fields = %+v", fs)
	}
	// The section names the category, so a "<Category>: " prefix goes.
	if got := keybindingFields([]CommandInfo{{Name: "git.fetch", Title: "Git: Fetch", Category: "Git"}})[0].Title; got != "Fetch" {
		t.Errorf("git.fetch title = %q, want Fetch", got)
	}
	// No value for a command without a field.
	if _, values, _ := resolveKeybindings(nil, testCmds); len(values) != len(fs) {
		t.Errorf("values = %v, want one per field", values)
	}

	// The keybindings page: one section per category with a bindable command, in the
	// palette's order; Daemon has none.
	var secs []Section
	for _, p := range pages(testCmds) {
		if p.ID == PageKeybindings {
			secs = p.Sections
		}
	}
	wantSecs := []Section{{ID: "project", Title: "Project"}, {ID: "pull-request", Title: "Pull Request"}, {ID: "terminal", Title: "Terminal"}, {ID: "thread", Title: "Thread"}}
	if !slices.Equal(secs, wantSecs) {
		t.Errorf("keybinding sections = %v, want %v", secs, wantSecs)
	}
	if len(Pages[slices.IndexFunc(Pages, func(p Page) bool { return p.ID == PageKeybindings })].Sections) != 0 {
		t.Errorf("pages() changed Pages")
	}
}

// TestPages checks the display hierarchy: every field's page and section exist, every
// section has fields, a row stays within one section, and DependsOn names a Bool field.
func TestPages(t *testing.T) {
	fields := append(slices.Clone(staticFields), keybindingFields(testCmds)...)
	type ref struct{ page, section string }
	count := map[ref]int{}
	pageIDs := map[string]bool{}
	for _, p := range pages(testCmds) {
		if pageIDs[p.ID] {
			t.Errorf("page %s declared twice", p.ID)
		}
		pageIDs[p.ID] = true
		if p.Title == "" || len(p.Sections) == 0 {
			t.Errorf("page %s: title and sections are required", p.ID)
		}
		for _, s := range p.Sections {
			if _, dup := count[ref{p.ID, s.ID}]; dup {
				t.Errorf("section %s/%s declared twice", p.ID, s.ID)
			}
			count[ref{p.ID, s.ID}] = 0
		}
		if len(p.Sections) > 1 {
			for _, s := range p.Sections {
				if s.Title == "" {
					t.Errorf("section %s/%s: only a page's single section may be untitled", p.ID, s.ID)
				}
			}
		}
	}
	byKey := map[string]Field{}
	rowSection := map[string]ref{}
	prevRow := ""
	for _, f := range fields {
		byKey[f.Key] = f
	}
	var prev ref
	seen := map[ref]bool{}
	for _, f := range fields {
		at := ref{f.Page, f.Section}
		n, ok := count[at]
		if !ok {
			t.Errorf("%s: page %q section %q is not in Pages", f.Key, f.Page, f.Section)
			continue
		}
		count[at] = n + 1
		// A section's fields are one run, so field order is display order.
		if at != prev && seen[at] {
			t.Errorf("%s: section %s/%s is split", f.Key, f.Page, f.Section)
		}
		seen[at], prev = true, at
		if f.Row != "" {
			if s, ok := rowSection[f.Row]; ok && (s != at || prevRow != f.Row) {
				t.Errorf("%s: row %q is split or spans sections (%v, %v)", f.Key, f.Row, s, at)
			}
			rowSection[f.Row] = at
		}
		prevRow = f.Row
		if f.DependsOn != "" {
			if d, ok := byKey[f.DependsOn]; !ok || d.Type != Bool || d.DependsOn != "" {
				t.Errorf("%s: depends on %q, want a top-level Bool field", f.Key, f.DependsOn)
			}
		}
		if f.Unit != "" && f.Type != Int {
			t.Errorf("%s: a unit on a non-Int field", f.Key)
		}
		if strings.Contains(f.Title, "(seconds)") {
			t.Errorf("%s: title %q carries its unit", f.Key, f.Title)
		}
	}
	for at, n := range count {
		if n == 0 {
			t.Errorf("section %s/%s has no fields", at.page, at.section)
		}
	}
	// Every Int field measured in seconds says so with its unit.
	for _, f := range staticFields {
		if strings.HasSuffix(f.Key, "_seconds") && f.Unit != "s" {
			t.Errorf("%s: unit %q, want s", f.Key, f.Unit)
		}
	}
}

func TestCacheTTLField(t *testing.T) {
	f := field(t, KeyCacheTTL)
	if f.Default != "3600" || f.Type != Int || f.Group != GroupThreads || f.Restart || f.Min != 60 || f.Max != 86400 {
		t.Errorf("field = %+v", f)
	}
	if got := Defaults(); got.Threads.CacheTTLSeconds != 3600 || got.CacheTTL() != time.Hour {
		t.Errorf("Defaults() cache TTL = %d (%v)", got.Threads.CacheTTLSeconds, got.CacheTTL())
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
	// Live (the composer reads every snapshot), in Threads, right after the default effort.
	if f.Group != GroupThreads || f.Type != Enum || f.Default != WorktreeCurrent || f.Restart || f.Title != "New threads work in" {
		t.Errorf("field = %+v", f)
	}
	if i := slices.IndexFunc(staticFields, func(f Field) bool { return f.Key == KeyDefaultEffort }); staticFields[i+1].Key != KeyDefaultWorktree {
		t.Errorf("field after %s = %s", KeyDefaultEffort, staticFields[i+1].Key)
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

func TestPluginRegistriesField(t *testing.T) {
	tests := []struct {
		raw, want, issue string
	}{
		{raw: "", want: ""},
		{raw: "o/a, https://x.example/index.json", want: "o/a, https://x.example/index.json"},
		{raw: "none", want: "none"},
		{raw: "o/a, http://x.example/index.json", want: "", issue: "plain http only for localhost"},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			r := resolve(map[string]string{KeyPluginRegistries: tt.raw}, nil)
			if got := r.settings.Plugins.Registries; got != tt.want {
				t.Errorf("value = %q, want %q", got, tt.want)
			}
			var issue string
			for _, is := range r.issues {
				if is.Key == KeyPluginRegistries {
					issue = is.Message
				}
			}
			if (tt.issue == "") != (issue == "") || !strings.Contains(issue, tt.issue) {
				t.Errorf("issue = %q, want %q", issue, tt.issue)
			}
		})
	}
}

func TestBranchPrefix(t *testing.T) {
	tests := []struct {
		v, want string
		wantErr bool
	}{
		{v: "cf", want: "cf"},
		{v: "alex/wip/", want: "alex/wip"},
		{v: "team_a.b", want: "team_a.b"},
		{v: BranchPrefixNone, want: ""},
		{v: "a b", wantErr: true},
		{v: "-x", wantErr: true},
		{v: "a..b", wantErr: true},
		{v: "a//b", wantErr: true},
		{v: "x.lock", wantErr: true},
		{v: "/", wantErr: true},
		{v: "ü", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.v, func(t *testing.T) {
			err := checkBranchPrefix(tt.v)
			if (err != nil) != tt.wantErr {
				t.Fatalf("checkBranchPrefix(%q) = %v", tt.v, err)
			}
			if got := (Projects{BranchPrefix: tt.v}).BranchPrefixValue(); err == nil && got != tt.want {
				t.Errorf("BranchPrefixValue = %q, want %q", got, tt.want)
			}
		})
	}
}
