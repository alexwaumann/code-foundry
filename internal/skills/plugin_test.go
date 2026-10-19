package skills_test

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// pluginSkillFiles are the code-foundry-plugin skill's files.
var pluginSkillFiles = []string{
	"code-foundry-plugin/SKILL.md",
	"code-foundry-plugin/reference/manifest.md", "code-foundry-plugin/reference/protocol.md",
	"code-foundry-plugin/reference/primitives.md", "code-foundry-plugin/reference/ui-layout.md", "code-foundry-plugin/reference/host-api.md",
	"code-foundry-plugin/reference/testing.md", "code-foundry-plugin/reference/publishing.md",
	"code-foundry-plugin/reference/cli.md", "code-foundry-plugin/reference/host-commands.md",
	"code-foundry-plugin/example/plugin.json", "code-foundry-plugin/example/main.go",
	"code-foundry-plugin/example/main_test.go", "code-foundry-plugin/example/Makefile",
	"code-foundry-plugin/example/.gitignore", "code-foundry-plugin/example/.github/workflows/release.yml",
	"code-foundry-plugin/example/.github/workflows/ci.yml", "code-foundry-plugin/example/scripts/registry-entry.go",
	"code-foundry-plugin/example/README.md",
}

// maxPluginFile bounds every file of the plugin skill: an agent reads a reference whole
// (the Read tool's default window is 2,000 lines, and long files cost context).
const maxPluginFile = 32 << 10

func TestRenderPluginSkill(t *testing.T) {
	src := realSources(t)
	// An installed plugin's own commands are neither verbs nor host commands.
	src.Commands = append(src.Commands, &v1.Command{Name: "plugin.hello.greet", Title: "Say Hello", Category: "Hello"})
	files, err := skills.Render(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pluginSkillFiles {
		b := files[p]
		switch {
		case len(b) == 0:
			t.Errorf("%s is missing or empty", p)
		case len(b) > maxPluginFile:
			t.Errorf("%s has %d bytes; keep it under %d", p, len(b), maxPluginFile)
		case bytes.Contains(b, []byte("{{cf.")):
			t.Errorf("%s has an unfilled placeholder", p)
		}
	}

	// The filled values: the SDK pin, the example's installed path, the host facts, the
	// SDK's names and limits.
	body := string(files[skills.Plugin+"/SKILL.md"])
	for _, want := range []string{
		"go get github.com/alexwaumann/code-foundry/pluginsdk@0123456789abcdef0123456789abcdef01234567\n",
		"cp -R /Users/ada/.code-foundry/claude/.claude/skills/code-foundry-plugin/example/. .\n",
		"This Code Foundry is v9.9.9.",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("SKILL.md lacks %q", want)
		}
	}
	manifest := string(files[skills.Plugin+"/reference/manifest.md"])
	for _, want := range []string{"`pr.checks.provider`", "`thread.hasPr`", "`threads`, `thread`", "`surface`, `act`", "`context-thread`",
		"`activity`, `ban`", "`workflow`, `wrench`"} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest.md lacks %q", want)
		}
	}
	hostAPI := string(files[skills.Plugin+"/reference/host-api.md"])
	for _, want := range []string{"| `threads` | `thread-list` | `threadList` | `snapshot`, `updated`, `removedId`", "| `thread` | `thread` | `thread` | `pending`, `pendingSnapshot` |", "`pullRequestDetailUpdated`, `pullRequestChanged`",
		"| `gh.pullRequestChanged` |"} {
		if !strings.Contains(hostAPI, want) {
			t.Errorf("host-api.md lacks %q", want)
		}
	}
	if prim := string(files[skills.Plugin+"/reference/primitives.md"]); !strings.Contains(prim, "| Elements in a view (nodes, rows, chips, pairs, fields, options, buttons, tabs) | 400 |") {
		t.Error("primitives.md lacks the limits table")
	}
	if prim := string(files[skills.Plugin+"/reference/primitives.md"]); !strings.Contains(prim, "| Containers (section, columns, pane, grid, container) a node sits inside | 4 |") ||
		!strings.Contains(prim, "| Nodes in the toolbar / in the footer | 6 / 6 |") || !strings.Contains(prim, "| A container's widest: narrow / wide (px) | 680 / 1080 |") {
		t.Error("primitives.md lacks the container depth, the strips' or the container's limits")
	}
	if layout := string(files[skills.Plugin+"/reference/ui-layout.md"]); !strings.Contains(layout, "2 columns need 492 px") || !strings.Contains(layout, "view.node.columns") ||
		!strings.Contains(layout, "`view.toolbar`, `view.footer`") || !strings.Contains(layout, "**Up to 6 nodes each**") || !strings.Contains(layout, "`narrow` is at most 680 px, `wide` at most 1080 px") {
		t.Error("ui-layout.md lacks the side by side rule, the capabilities, the strips' cap or the container's widths")
	}
	if layout := string(files[skills.Plugin+"/reference/ui-layout.md"]); !strings.Contains(layout, "floor((width + 12) / (minWidth + 12))") || !strings.Contains(layout, "view.node.group") ||
		!strings.Contains(layout, "text, chips, actions and progress") {
		t.Error("ui-layout.md lacks the grid formula, the group capability or its kinds")
	}
	if prim := string(files[skills.Plugin+"/reference/primitives.md"]); !strings.Contains(prim, "| Grid: items / least and most minWidth (px) / columns / an item's span | 24 / 160 / 480 / 6 / 2 |") ||
		!strings.Contains(prim, "| Items in a group | 8 |") || !strings.Contains(prim, "| Spacer size: least / most (px) | 4 / 64 |") {
		t.Error("primitives.md lacks the grid, group or spacer limits")
	}

	// cli.md: every plugin verb's help and the debugging helpers, the common flags once,
	// and no installed plugin's commands.
	cli := string(files[skills.Plugin+"/reference/cli.md"])
	for _, want := range []string{
		"### plugin.dev\n\n```\nplugin.dev - Develop Plugin\n", "code-foundry plugin dev <path> [flags]",
		"### plugin.act\n", "  --values string", "### plugin.secrets.delete\n", "### thread.flags\n", "### pr.checks\n",
		"(v9.9.9)", "code-foundry events --json --source",
	} {
		if !strings.Contains(cli, want) {
			t.Errorf("cli.md lacks %q", want)
		}
	}
	if strings.Index(cli, "### plugin.dev") > strings.Index(cli, "### plugin.list") {
		t.Error("cli.md does not start with plugin.dev")
	}
	if n := strings.Count(cli, "--context-thread id"); n != 1 {
		t.Errorf("cli.md lists the common flags %d times", n)
	}
	if strings.Contains(cli, "plugin.hello") {
		t.Error("cli.md lists an installed plugin's command")
	}

	// host-commands.md: the registry without the plugin namespace.
	host := string(files[skills.Plugin+"/reference/host-commands.md"])
	for _, want := range []string{"- `thread.send [--id] <text>`", "- `pr.checks", "## Thread\n", "permissions.commands"} {
		if !strings.Contains(host, want) {
			t.Errorf("host-commands.md lacks %q", want)
		}
	}
	if regexp.MustCompile("- `plugin\\.").MatchString(host) {
		t.Error("host-commands.md lists a plugin.* command")
	}

	// The example is plugins/examples/minimal, byte for byte.
	for _, p := range pluginSkillFiles {
		rel, ok := strings.CutPrefix(p, skills.Plugin+"/example/")
		if !ok {
			continue
		}
		repo, err := os.ReadFile(filepath.Join("../../plugins/examples/minimal", rel))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(files[p], repo) {
			t.Errorf("%s is not plugins/examples/minimal/%s", p, rel)
		}
	}
	// The SKILL names only example files it has.
	for _, m := range regexp.MustCompile("`(example/[A-Za-z0-9_./-]*[A-Za-z0-9_-])`").FindAllStringSubmatch(body, -1) {
		if _, ok := files[skills.Plugin+"/"+m[1]]; !ok && !strings.HasSuffix(m[1], "/") {
			t.Errorf("SKILL.md names %s, which the skill does not have", m[1])
		}
	}
}

func TestSDKPin(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	for _, tt := range []struct{ commit, tag, want string }{
		{sha, "", sha},
		{sha, "pluginsdk/v0.2.1", "v0.2.1"},
		{sha, "pluginsdk/v10.0.12", "v10.0.12"},
		{sha, "v0.2.1", sha},                         // not the SDK's tag
		{sha, "pluginsdk/v0.2.1-rc.1", sha},          // not a release
		{sha, "pluginsdk/v0.2", sha},                 // not semver
		{sha + "-dirty", "pluginsdk/v0.2.1", "main"}, // a modified checkout is not the tag
		{sha + "-dirty", "", "main"},
		{"", "", "main"},
		{"", "pluginsdk/v0.2.1", "main"},
		{"v1.2.3", "", "main"},
	} {
		if got := skills.SDKPin(tt.commit, tt.tag); got != tt.want {
			t.Errorf("SDKPin(%q, %q) = %q, want %q", tt.commit, tt.tag, got, tt.want)
		}
	}
	for _, tt := range []struct {
		name string
		src  skills.Sources
		want string
	}{
		// A build without a clean commit names main.
		{"dirty", skills.Sources{Version: "dev", Commit: "abc-dirty"}, "pluginsdk@main\n"},
		{"commit", skills.Sources{Version: "dev", Commit: sha}, "pluginsdk@" + sha + "\n"},
		// A build from a commit carrying the SDK's tag pins its version.
		{"tagged", skills.Sources{Version: "v1.4.0", Commit: sha, SDKTag: "pluginsdk/v0.2.1"}, "pluginsdk@v0.2.1\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			files, err := skills.Render(tt.src)
			if err != nil {
				t.Fatal(err)
			}
			if body := string(files[skills.Plugin+"/SKILL.md"]); !strings.Contains(body, "go get github.com/alexwaumann/code-foundry/"+tt.want) {
				t.Errorf("SKILL.md does not pin %q", tt.want)
			}
		})
	}
}

// The skill lists the icons the GUI draws (ui.Icons); once the GUI's allowlist is in
// this tree the two must agree.
func TestIconsMatchTheGUI(t *testing.T) {
	src, err := os.ReadFile("../../gui/frontend/src/components/plugin/icons.ts")
	if os.IsNotExist(err) {
		t.Skip("no plugin icon allowlist in the GUI yet")
	}
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	start := strings.Index(body, "PLUGIN_ICONS")
	end := strings.Index(body[max(start, 0):], "\n};")
	if start < 0 || end < 0 {
		t.Fatal("icons.ts has no PLUGIN_ICONS map")
	}
	var gui []string
	for _, m := range regexp.MustCompile(`(?m)^\s+"?([a-z0-9-]+)"?:`).FindAllStringSubmatch(body[start:start+end], -1) {
		gui = append(gui, m[1])
	}
	if !slices.Equal(gui, ui.Icons) {
		t.Errorf("the GUI draws %v, pluginsdk/ui.Icons says %v", gui, ui.Icons)
	}
}
