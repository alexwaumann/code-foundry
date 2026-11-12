package skills_test

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/skills"
)

// pluginSkillFiles are the code-foundry-plugin skill's files.
var pluginSkillFiles = []string{
	"code-foundry-plugin/SKILL.md",
	"code-foundry-plugin/reference/manifest.md", "code-foundry-plugin/reference/protocol.md",
	"code-foundry-plugin/reference/primitives.md", "code-foundry-plugin/reference/ui-layout.md", "code-foundry-plugin/reference/host-api.md",
	"code-foundry-plugin/reference/nodes.md", "code-foundry-plugin/reference/forms.md", "code-foundry-plugin/reference/events.md",
	"code-foundry-plugin/reference/wakes.md", "code-foundry-plugin/reference/owned.md", "code-foundry-plugin/reference/icons.md",
	"code-foundry-plugin/reference/testing.md", "code-foundry-plugin/reference/publishing.md",
	"code-foundry-plugin/reference/cli.md", "code-foundry-plugin/reference/host-commands.md",
	"code-foundry-plugin/reference/host-commands-thread-view.md",
	"code-foundry-plugin/example/plugin.json", "code-foundry-plugin/example/main.go",
	"code-foundry-plugin/example/main_test.go", "code-foundry-plugin/example/Makefile",
	"code-foundry-plugin/example/.gitignore", "code-foundry-plugin/example/.github/workflows/release.yml",
	"code-foundry-plugin/example/.github/workflows/ci.yml", "code-foundry-plugin/example/scripts/registry-entry.go", "code-foundry-plugin/example/scripts/release.sh",
	"code-foundry-plugin/example/README.md",
}

func TestRenderPluginSkill(t *testing.T) {
	src := realSources(t)
	// An installed plugin's own commands are neither verbs nor host commands.
	src.Commands = append(src.Commands, &v1.Command{Name: "plugin.hello.greet", Title: "Say Hello", Category: "Hello"})
	files, err := skills.Render(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pluginSkillFiles {
		switch b := files[p]; {
		case len(b) == 0:
			t.Errorf("%s is missing or empty", p)
		case bytes.Contains(b, []byte("{{cf.")):
			t.Errorf("%s has an unfilled placeholder", p)
		}
	}

	// The filled values: the SDK pin, the example's installed path, the host's version, and
	// what is rendered from the host's own lists. The limits table has its own test
	// (TestViewLimitsNameEveryLimit); nothing here freezes its numbers or a file's prose.
	body := string(files[skills.Plugin+"/SKILL.md"])
	for _, want := range []string{"pluginsdk@" + src.Commit, "code-foundry plugin new <name>", src.Version} {
		if !strings.Contains(body, want) {
			t.Errorf("SKILL.md lacks %q", want)
		}
	}
	if pub := string(files[skills.Plugin+"/reference/publishing.md"]); !strings.Contains(pub, "/Users/ada/.code-foundry/claude/.claude/skills/code-foundry-plugin/example/.github") {
		t.Error("publishing.md lacks the example's installed path")
	}
	manifest := string(files[skills.Plugin+"/reference/manifest.md"])
	for _, fact := range src.Facts {
		if !strings.Contains(manifest, "`"+fact+"`") {
			t.Errorf("manifest.md lacks the host fact %s", fact)
		}
	}
	if icons := string(files[skills.Plugin+"/reference/icons.md"]); !strings.Contains(icons, " activity ") || !strings.Contains(icons, " trash-2 ") {
		t.Errorf("icons.md lacks the icon names: %.300s", icons)
	}
	events := string(files[skills.Plugin+"/reference/events.md"])
	for _, want := range []string{"`thread-list`", "`pullRequestChanged`"} {
		if !strings.Contains(events, want) {
			t.Errorf("events.md lacks %q", want)
		}
	}

	// cli.md: every plugin verb's help and the debugging helpers, the common flags once,
	// and no installed plugin's commands.
	cli := string(files[skills.Plugin+"/reference/cli.md"])
	for _, verb := range []string{"plugin.dev", "plugin.act", "plugin.secrets.delete", "thread.flags", "pr.checks"} {
		if !strings.Contains(cli, "### "+verb+"\n") {
			t.Errorf("cli.md lacks %s", verb)
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

	// host-commands.md and host-commands-thread-view.md: the registry without the plugin
	// namespace, the thread and view categories in the second.
	host := string(files[skills.Plugin+"/reference/host-commands.md"])
	threadView := string(files[skills.Plugin+"/reference/host-commands-thread-view.md"])
	for file, wants := range map[string][]string{
		host:       {"- `pr.checks", "- `terminal.new", "## Terminal\n", "host-commands-thread-view.md"},
		threadView: {"- `thread.send", "- `view.settings", "## Thread\n", "## View\n", "host-commands.md"},
	} {
		for _, want := range wants {
			if !strings.Contains(file, want) {
				t.Errorf("%.60q lacks %q", file, want)
			}
		}
	}
	if strings.Contains(host, "## Thread\n") || strings.Contains(host, "- `thread.send") || strings.Contains(threadView, "- `pr.checks") {
		t.Error("a category is in both host command files")
	}
	if regexp.MustCompile("- `plugin\\.").MatchString(host + threadView) {
		t.Error("the host command files list a plugin.* command")
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
		{"dirty", skills.Sources{Version: "dev", Commit: "abc-dirty"}, "pluginsdk@main`"},
		{"commit", skills.Sources{Version: "dev", Commit: sha}, "pluginsdk@" + sha + "`"},
		// A build from a commit carrying the SDK's tag pins its version.
		{"tagged", skills.Sources{Version: "v1.4.0", Commit: sha, SDKTag: "pluginsdk/v0.2.1"}, "pluginsdk@v0.2.1`"},
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

// Every exported Max*/Min* constant of pluginsdk/ui is a limit the host enforces, so the
// generated limits table (viewLimits) names it: a new limit fails here until it has a
// row.
func TestViewLimitsNameEveryLimit(t *testing.T) {
	notLimits := map[string]bool{
		"MaxProblems": true, // how many problems Validate names
	}
	fset := token.NewFileSet()
	uiFiles, err := filepath.Glob(filepath.Join("..", "..", "pluginsdk", "ui", "*.go"))
	if err != nil || len(uiFiles) == 0 {
		t.Fatal("pluginsdk/ui sources", err)
	}
	var limits []string
	for _, p := range uiFiles {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range f.Decls {
			if g, ok := d.(*ast.GenDecl); ok && g.Tok == token.CONST {
				for _, sp := range g.Specs {
					for _, name := range sp.(*ast.ValueSpec).Names {
						if n := name.Name; (strings.HasPrefix(n, "Max") || strings.HasPrefix(n, "Min")) && name.IsExported() && !notLimits[n] {
							limits = append(limits, n)
						}
					}
				}
			}
		}
	}
	f, err := parser.ParseFile(fset, "plugin.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	named := map[string]bool{}
	for _, d := range f.Decls {
		if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == "viewLimits" {
			ast.Inspect(fn, func(n ast.Node) bool {
				if sel, ok := n.(*ast.SelectorExpr); ok {
					if x, ok := sel.X.(*ast.Ident); ok && x.Name == "ui" {
						named[sel.Sel.Name] = true
					}
				}
				return true
			})
		}
	}
	if len(limits) < 40 {
		t.Fatalf("found %d limits in pluginsdk/ui: %v", len(limits), limits)
	}
	for _, l := range limits {
		if !named[l] {
			t.Errorf("ui.%s is not in viewLimits' table (internal/skills/plugin.go)", l)
		}
	}
}
