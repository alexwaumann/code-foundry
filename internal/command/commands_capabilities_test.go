package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/presence"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/version"
)

type capFixture struct {
	reg     *command.Registry
	plugins *commandtest.Plugin
	memory  *commandtest.Memory
	skills  *commandtest.SkillSnapshot
	schema  *v1.GetSettingsSchemaResponse
}

// newCapFixture registers daemon.capabilities next to the commands its groups read
// (daemon, view, MCP and agents panels, settings, memory, presence) over fakes: a
// thread s-1 is viewed in one of two attended windows, one plugin with a command and a
// surface, two memory entries, one marketplace skill.
func newCapFixture(t *testing.T) capFixture {
	t.Helper()
	ctx := context.Background()
	st, err := settingstest.New(ctx, t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	set := api.NewSettings(st)
	schema, err := set.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	f := capFixture{
		reg: command.NewRegistry(),
		plugins: &commandtest.Plugin{Plugins: []*v1.Plugin{{
			Name: "gh-actions", Version: "0.3.0", Enabled: true, State: v1.PluginState_PLUGIN_STATE_RUNNING,
			Description: "GitHub Actions runs for the thread's branch. Rerun failed jobs.",
			Commands:    []*v1.PluginCommand{{Name: "plugin.gh-actions.rerun", Title: "Rerun Failed Jobs"}},
			Surfaces: []*v1.PluginSurface{{Id: "runs", Title: "Actions", Scope: "thread",
				ShowCommand: "plugin.gh-actions.show.runs", Kind: "plugin.gh-actions.runs"}},
		}}},
		memory: &commandtest.Memory{Texts: []string{"Always open PRs as drafts", "Never open the side panel on your own"}},
		skills: &commandtest.SkillSnapshot{Snap: &skill.Snapshot{Installed: []skill.Installed{
			{Kind: marketplace.KindSkill, Name: "sql-helper", Registry: "ai-marketplace", Enabled: true, Description: "Write SQL: queries and migrations."},
			{Kind: marketplace.KindSkill, Name: "gone", Missing: true},
		}}},
		schema: schema.Msg,
	}
	thread := &commandtest.Thread{}
	emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
	pres := command.PresenceDeps{
		Presence: func() presence.State { return presence.State{Kind: presence.Foreground, Attended: true} },
		Windows:  func() int { return 2 },
		Viewed:   func(id string) bool { return id == "s-1" },
	}
	v := version.Info{Version: "v0.21.3", Commit: "844a109c01234567890abcdef0123456789abcde", GoVersion: "go1.26.10"}
	err = errors.Join(
		command.RegisterDaemon(f.reg, command.DaemonInfo{Version: v}),
		command.RegisterView(f.reg, command.ViewDeps{Emitter: emit, Thread: thread}),
		command.RegisterMcp(f.reg, thread, emit),
		command.RegisterAgents(f.reg, thread, emit),
		command.RegisterSettings(f.reg, set, nil),
		command.RegisterMemory(f.reg, command.MemoryDeps{}),
		command.RegisterPresence(f.reg, pres),
		command.RegisterCapabilities(f.reg, command.CapabilitiesDeps{
			Version: v, Settings: set, Memory: f.memory, Plugins: f.plugins, Skills: f.skills, Presence: pres,
			Shipped: func() []command.ShippedSkill {
				return []command.ShippedSkill{
					{Name: "code-foundry", Purpose: "Start here for anything about Code Foundry", Path: "/h/claude/.claude/skills/code-foundry/SKILL.md"},
					{Name: "code-foundry-help", Purpose: "Answer how-to questions", Path: "/h/claude/.claude/skills/code-foundry-help/SKILL.md"},
				}
			},
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f capFixture) run(t *testing.T, args map[string]string) (command.Result, error) {
	t.Helper()
	return f.reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-1"}, "daemon.capabilities", args)
}

// jsonOf is v as the CLI's --json prints it, decoded into a generic value.
func jsonOf(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCapabilitiesIndex(t *testing.T) {
	f := newCapFixture(t)
	res, err := f.run(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(res.Message, "\n")
	if len(lines) > 15 {
		t.Errorf("the index has %d lines, keep it under 15:\n%s", len(lines), res.Message)
	}
	if lines[0] != "Code Foundry v0.21.3 (commit 844a109c0123): what this app can do, by group." {
		t.Errorf("first line %q", lines[0])
	}
	if last := lines[len(lines)-1]; !strings.Contains(last, "code-foundry daemon.capabilities --group <name>") {
		t.Errorf("last line %q", last)
	}
	idx := res.JSON.(command.CapabilitiesIndex)
	if idx.Version != "v0.21.3" || len(idx.Groups) != len(command.CapabilityGroups()) {
		t.Fatalf("index JSON = %+v", idx)
	}
	fields := len(f.schema.GetFields())
	for i, tt := range []struct {
		name  string
		count int // -1: none
		has   string
	}{
		{"build", -1, "v0.21.3, source https://github.com/alexwaumann/code-foundry/tree/v0.21.3"},
		{"commands", len(f.reg.List(command.Context{}, true)), "commands in 4 categories"},
		{"pages", 6, "main-pane pages"},
		{"panel", 10, "(1 from plugins)"},
		{"rendering", len(command.Renderings), "markdown, code, paths, images, PDFs, HTML"},
		{"skills", 2, "1 more installed for Claude Code"},
		{"plugins", 1, "installed plugins"},
		{"settings", fields, "settings in"},
		{"memory", 2, "standing preferences"},
		{"presence", -1, "foreground+attended (the user is looking at the app)"},
	} {
		row := idx.Groups[i]
		if row.Name != tt.name || row.Error != "" {
			t.Errorf("group %d = %+v, want %s", i, row, tt.name)
			continue
		}
		switch {
		case tt.count < 0 && row.Count != nil:
			t.Errorf("%s count = %d, want none", tt.name, *row.Count)
		case tt.count >= 0 && (row.Count == nil || *row.Count != tt.count):
			t.Errorf("%s count = %v, want %d", tt.name, row.Count, tt.count)
		}
		if !strings.Contains(row.Description, tt.has) {
			t.Errorf("%s description %q lacks %q", tt.name, row.Description, tt.has)
		}
		if !strings.HasPrefix(lines[i+1], tt.name+" ") || !strings.Contains(lines[i+1], tt.has) {
			t.Errorf("index line %q", lines[i+1])
		}
	}
}

// A group that cannot be read says why on its index line; the others still list.
func TestCapabilitiesIndexError(t *testing.T) {
	f := newCapFixture(t)
	f.memory.Err = errors.New("permission denied")
	f.plugins.Err = connect.NewError(connect.CodeUnavailable, errors.New("plugins down"))
	res, err := f.run(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"memory           remembered standing preferences (memory.* verbs) (unavailable: read the memory: permission denied)",
		"plugins          installed plugins with their commands and surfaces (unavailable: list plugins: ", "\nsettings  "} {
		if !strings.Contains(res.Message, want) {
			t.Errorf("index lacks %q:\n%s", want, res.Message)
		}
	}
	if _, err := f.run(t, map[string]string{"group": "memory"}); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("--group memory err = %v", err)
	}
	// A daemon without the plugin store lists no plugins rather than failing.
	f.plugins.Err = connect.NewError(connect.CodeUnimplemented, nil)
	if res, err := f.run(t, map[string]string{"group": "plugins"}); err != nil || !strings.HasPrefix(res.Message, "plugins: 0 installed.") {
		t.Errorf("--group plugins without a store = %q, %v", res.Message, err)
	}
}

func TestCapabilitiesGroups(t *testing.T) {
	f := newCapFixture(t)
	for _, tt := range []struct {
		group   string
		has     []string
		hasNot  []string
		json    map[string]any // top-level JSON values to compare
		jsonLen map[string]int // top-level JSON arrays and their lengths
	}{
		{group: "build",
			has: []string{"build: Code Foundry v0.21.3\n", "commit: 844a109c01234567890abcdef0123456789abcde\n", "go: go1.26.10\n",
				"source: https://github.com/alexwaumann/code-foundry/tree/v0.21.3\n", "\"Reading the source\""},
			hasNot: []string{"dev build"},
			json:   map[string]any{"version": "v0.21.3", "source_ref": "v0.21.3", "source_url": "https://github.com/alexwaumann/code-foundry/tree/v0.21.3"}},
		{group: "commands",
			has: []string{"`code-foundry commands`", "`code-foundry help <command>`", "\nDaemon (3): daemon.status (Daemon Status), daemon.version (Daemon Version),\n  daemon.capabilities (Show Capabilities)\n",
				"\nView (", " memory.show (Memory: Show Preferences)", "some have none (Copy, Cite"},
			jsonLen: map[string]int{"categories": 4}},
		{group: "pages",
			has: []string{"pages: 6.", "run one only when asked", "prefer a panel verb", "  view.dashboard       Show the dashboard in every app window.\n", "refuses unless --focus", "Ember (the flame above New thread)", "Themes (theme.pick", "  view.pullrequests    ",
				"  view.projects ", "  view.usage ", "  view.settings ", "  view.help ", "view.back, view.forward"},
			hasNot:  []string{"  view.back ", "view.panel.", "view.inline"},
			jsonLen: map[string]int{"pages": 6}},
		{group: "panel",
			has: []string{"panel: 9 surfaces.", "--thread (default: the thread you run in)",
				"  view.panel.worktree      the overview of the worktree the thread runs in", "  view.panel.mcp ", "  view.panel.agents ",
				"  view.panel.linked-prs ", "  view.panel.usage ", "  view.panel.threads ",
				"  view.panel.file ", "  view.panel.diff ", "  view.panel.pr ", "renders as a chip", ".html files render there interactively", "view.inline <path> (--title, --panel) shows an .html page inline", "cf:resize",
				"Plugin surfaces (their show verb acts on each window's selection, not a thread):\n  plugin.gh-actions.show.runs", "Actions (thread scope, from the plugin gh-actions)\n",
				"Panel actions (they flip state you cannot see): view.panel.", "view.panel.toggle", "view.panel.split",
				"`code-foundry ui.presence --json` only tells you whether to mention", "a \"show me\" is asking",
				"unless a remembered preference says not to", "no ui.notify", "Pass --focus only when the user asks"},
			hasNot:  []string{"  view.panel.toggle ", "Open the", "Before opening one", "  its "},
			jsonLen: map[string]int{"surfaces": 9, "plugin_surfaces": 1, "actions": 4}},
		{group: "rendering",
			has: []string{"  markdown ", "  code ", "Run in terminal", "  paths ", "File tab", "  pdfs ", "  html ", "  not rendered ",
				"  bridge ", `<script src="/cf/bridge.js"></script>`, "gesture, declined, unavailable, invalid, failed, timeout",
				"thread-list, thread, gh, action, plugin, terminal, project, workspace, settings, update, ui, ember",
				"only from a click or key press", "a quick read awaited first still counts", "unavailable: an unknown verb",
				"invalid: a wrong or missing arg", "values are strings, numbers or booleans", "current snapshot first",
				"the whole new snapshot after each change", "not --json's shape", "only while Ember's board is open",
				"a message to show the user", "kept by Code Foundry (256 KiB)", "starts empty", "a wake (thread subscribe) or a plugin",
				"ask the user for a token", "cf.fetch(url, {method, headers, body, timeout})", "CORS rules never block it",
				"resolves for every status", "private networks are allowed", "send it in a header with cf.fetch",
				// The page library, a line per specifier and file.
				"  react pages ", `<script type="text/tsx">`, "  @cf/ui        /cf/ui.js: ", "  @cf/icons     /cf/icons.js: all of lucide-react",
				"  react-dom/client /cf/react-dom-client.js", "  /cf/jsx.js    the loader", "  /cf/ui.css    ", "  /cf/tailwind.js optional",
				"A mockup of another product skips both"},
			jsonLen: map[string]int{"renderings": len(command.Renderings)}},
		{group: "skills",
			has: []string{"skills: 2 every thread gets", "  code-foundry               Start here for anything about Code Foundry\n",
				"/h/claude/.claude/skills/code-foundry-help/SKILL.md", "  skill sql-helper (ai-marketplace, enabled): Write SQL", "not the thread's full skill list"},
			hasNot:  []string{"gone"},
			jsonLen: map[string]int{"shipped": 2, "installed": 1}},
		{group: "plugins",
			has: []string{"plugins: 1 installed.", "gh-actions 0.3.0 (running): GitHub Actions runs for the thread's branch\n",
				"  commands: plugin.gh-actions.rerun (Rerun Failed Jobs)\n", "  surfaces: Actions (plugin.gh-actions.show.runs)"},
			jsonLen: map[string]int{"plugins": 1}},
		{group: "settings",
			has:     []string{"`code-foundry settings get --json`", "`settings set <key> <value>`", "\n  threads "},
			json:    map[string]any{"count": float64(len(f.schema.GetFields()))},
			jsonLen: map[string]int{"groups": len(f.schema.GetGroups())}},
		{group: "memory",
			has: []string{"memory: 2 standing preferences remembered.", "  memory.add     Memory: Remember a Preference\n",
				"  memory.clear ", "  memory.remove ", "  memory.show "},
			json:    map[string]any{"count": float64(2)},
			jsonLen: map[string]int{"commands": 4}},
		{group: "presence",
			has:  []string{"presence: foreground+attended (the user is looking at the app)\nwindows: 2\nthread s-1: viewed", "`code-foundry ui.presence`"},
			json: map[string]any{"state": "foreground+attended", "attended": true, "windows": float64(2), "thread": "s-1", "viewed": true}},
	} {
		t.Run(tt.group, func(t *testing.T) {
			res, err := f.run(t, map[string]string{"group": tt.group})
			if err != nil {
				t.Fatal(err)
			}
			for _, h := range tt.has {
				if !strings.Contains(res.Message, h) {
					t.Errorf("lacks %q:\n%s", h, res.Message)
				}
			}
			for _, h := range tt.hasNot {
				if strings.Contains(res.Message, h) {
					t.Errorf("has %q:\n%s", h, res.Message)
				}
			}
			js := jsonOf(t, res.JSON)
			for k, want := range tt.json {
				if js[k] != want {
					t.Errorf("JSON %s = %v, want %v", k, js[k], want)
				}
			}
			for k, n := range tt.jsonLen {
				if got, _ := js[k].([]any); len(got) != n {
					t.Errorf("JSON %s has %d entries, want %d: %v", k, len(got), n, js[k])
				}
			}
			{
				if n := strings.Count(res.Message, "\n"); n > 40 {
					t.Errorf("--group %s has %d lines; keep it to a screen", tt.group, n)
				}
			}
		})
	}
	if _, err := f.run(t, map[string]string{"group": "nope"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("--group nope err = %v", err)
	}
}

// A dev build's build group says its source may not match.
func TestCapabilitiesDevBuild(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterCapabilities(reg, command.CapabilitiesDeps{Version: version.Info{Version: "dev", Commit: "0123456789abcdef0123456789abcdef01234567-dirty"}}); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "daemon.capabilities", map[string]string{"group": "build"})
	if err != nil || !strings.Contains(res.Message, "(dev build: the source there may not match this build)") {
		t.Errorf("dev build = %q, %v", res.Message, err)
	}
	// Without stores every group still answers: empty, not failing.
	res, err = reg.Invoke(context.Background(), command.Context{}, "daemon.capabilities", nil)
	if err != nil || !strings.Contains(res.Message, "settings") || !strings.Contains(res.Message, "(unavailable: no settings)") {
		t.Errorf("bare index = %q, %v", res.Message, err)
	}
	for _, g := range []string{"skills", "plugins", "memory", "presence", "pages", "panel"} {
		if _, err := reg.Invoke(context.Background(), command.Context{}, "daemon.capabilities", map[string]string{"group": g}); err != nil {
			t.Errorf("--group %s without stores: %v", g, err)
		}
	}
}
