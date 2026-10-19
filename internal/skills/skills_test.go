package skills_test

import (
	"bytes"
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/docs"
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
)

// realSources are the daemon's own commands and settings schema, as installSkills
// lists them.
func realSources(t *testing.T) skills.Sources {
	t.Helper()
	ctx := context.Background()
	reg := command.NewRegistry()
	if err := all.Register(reg, all.Deps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	listed, err := api.NewCommand(reg).List(ctx, connect.NewRequest(&v1.ListCommandsRequest{IncludeUnavailable: true}))
	if err != nil {
		t.Fatal(err)
	}
	var infos []settings.CommandInfo
	for _, l := range reg.List(command.Context{}, true) {
		infos = append(infos, settings.CommandInfo{Name: l.Name, Title: l.Title, Description: l.Description,
			Category: l.Category, Keybindings: l.Keybindings, NoKeybinding: l.NoKeybinding})
	}
	st, err := settingstest.New(ctx, t.TempDir(), nil, infos)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	schema, err := api.NewSettings(st).GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	return skills.Sources{Version: "v9.9.9", Commands: listed.Msg.GetCommands(),
		SettingGroups: schema.Msg.GetGroups(), Settings: schema.Msg.GetFields(),
		Commit: "0123456789abcdef0123456789abcdef01234567", SkillsDir: "/Users/ada/.code-foundry/claude/.claude/skills",
		Facts: plugin.HostFactNames()}
}

// frontmatter is a SKILL.md's YAML frontmatter lines, key → value.
func frontmatter(t *testing.T, name string, b []byte) map[string]string {
	t.Helper()
	s, ok := strings.CutPrefix(string(b), "---\n")
	head, _, ok2 := strings.Cut(s, "\n---\n")
	if !ok || !ok2 {
		t.Fatalf("%s has no frontmatter", name)
	}
	out := map[string]string{}
	for _, line := range strings.Split(head, "\n") {
		k, v, ok := strings.Cut(line, ": ")
		if !ok {
			t.Fatalf("%s: frontmatter line %q", name, line)
		}
		out[k] = v
	}
	return out
}

// dynamicCommand is Claude Code's !`command` (run when a skill loads), which managed
// settings may forbid; a skill must never use it.
var dynamicCommand = regexp.MustCompile("!`")

func TestRender(t *testing.T) {
	src := realSources(t)
	files, err := skills.Render(src)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for p := range files {
		paths = append(paths, p)
	}
	want := []string{
		"code-foundry-orchestrate/SKILL.md", "code-foundry-orchestrate/reference/commands.md",
		"code-foundry-orchestrate/reference/patterns.md",
		"code-foundry-help/SKILL.md", "code-foundry-help/reference/getting-started.md",
		"code-foundry-help/reference/settings.md", "code-foundry-help/reference/commands.md",
	}
	want = append(want, pluginSkillFiles...)
	if len(files) != len(want) {
		t.Errorf("files = %q, want %q", paths, want)
	}
	for _, p := range want {
		if len(files[p]) == 0 {
			t.Errorf("%s is missing or empty", p)
		}
	}
	for p, b := range files {
		if dynamicCommand.Match(b) {
			t.Errorf("%s runs a shell command when it loads (!`...`)", p)
		}
	}

	// Frontmatter: names, short descriptions, invocation.
	for _, tt := range []struct {
		skill, userInvocable string
		maxDesc, maxLines    int
	}{
		// Model only: not in the slash menu. Names the user's words for parallel work, and
		// its loop rules are the ones the orchestration experiment tested (orch-skill-v2, v3).
		{skills.Orchestrate, "false", 600, 160},
		{skills.Help, "", 400, 120},   // both: no invocation keys
		{skills.Plugin, "", 600, 120}, // both; names the words that should trigger it
	} {
		p := tt.skill + "/SKILL.md"
		fm := frontmatter(t, p, files[p])
		if fm["name"] != tt.skill {
			t.Errorf("%s: name %q", p, fm["name"])
		}
		desc := strings.Trim(fm["description"], `"`)
		if desc == "" || len(desc) >= tt.maxDesc || strings.Contains(desc, `"`) {
			t.Errorf("%s: description of %d characters (want 1..%d, no inner quotes)", p, len(desc), tt.maxDesc-1)
		}
		if fm["user-invocable"] != tt.userInvocable {
			t.Errorf("%s: user-invocable %q, want %q", p, fm["user-invocable"], tt.userInvocable)
		}
		if _, ok := fm["disable-model-invocation"]; ok {
			t.Errorf("%s: disable-model-invocation is set", p)
		}
		if n := bytes.Count(files[p], []byte("\n")); n > tt.maxLines {
			t.Errorf("%s has %d lines; keep it under %d", p, n, tt.maxLines)
		}
	}

	// Each command reference lists its categories, and only those.
	for _, tt := range []struct {
		path      string
		cats      []string
		notCats   []string
		detailed  string // an arg line only the detailed Thread category has
		mentioned []string
	}{
		{
			path: skills.Orchestrate + "/reference/commands.md", cats: []string{"Thread", "Action", "Workspace", "Project"},
			notCats: []string{"Settings", "Pull Request", "View"}, detailed: "  - `--request-id string`",
			mentioned: []string{"`thread.new`", "`thread.wait <id>`", "`thread.reports`", "`action.run <action>`",
				"`project.worktree.cleanup <project> <path> --yes`", "`workspace.new <name>`"},
		},
		{
			path: skills.Help + "/reference/commands.md", cats: []string{"Project", "Settings", "Thread", "Pull Request", "Action"},
			notCats: []string{"Workspace", "View", "Terminal"},
			// Settings in full, Thread one line each.
			detailed:  "  - `<value>`",
			mentioned: []string{"`settings.set <key> <value>`", "`pr.create`", "`project.add <path>`", "`thread.new`"},
		},
	} {
		got := string(files[tt.path])
		for _, c := range tt.cats {
			if !strings.Contains(got, "\n## "+c+"\n") {
				t.Errorf("%s lacks category %s", tt.path, c)
			}
		}
		for _, c := range tt.notCats {
			if strings.Contains(got, "\n## "+c+"\n") {
				t.Errorf("%s has category %s", tt.path, c)
			}
		}
		if !strings.Contains(got, tt.detailed) {
			t.Errorf("%s lacks %q", tt.path, tt.detailed)
		}
		for _, m := range tt.mentioned {
			if !strings.Contains(got, "- "+m+" ") {
				t.Errorf("%s lacks %s", tt.path, m)
			}
		}
		if !strings.Contains(got, "(v9.9.9)") {
			t.Errorf("%s does not name the version", tt.path)
		}
	}
	if help := string(files[skills.Help+"/reference/commands.md"]); strings.Contains(help, "  - `--request-id") {
		t.Error("the help skill lists thread.new's args; it has the one-line form")
	}

	// The settings reference has one entry per setting with its type and default.
	set := string(files[skills.Help+"/reference/settings.md"])
	for _, f := range src.Settings {
		if n := strings.Count(set, "- `"+f.GetKey()+"` "); n != 1 {
			t.Errorf("settings.md lists %s %d times", f.GetKey(), n)
		}
	}
	for _, want := range []string{
		"## Threads (`[threads]`)", "- `threads.default_model` **",
		"Type: enum, one of `claude-opus-5-5[1m]` (", "Default: `",
		"- `keybindings.thread.new` New Thread: `cmd+n`",
	} {
		if !strings.Contains(set, want) {
			t.Errorf("settings.md lacks %q", want)
		}
	}

	// The getting started guide is the repo's file, the one the GUI bundles.
	repo, err := os.ReadFile("../../docs/GETTING-STARTED.md")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(files[skills.Help+"/reference/getting-started.md"], repo) || !bytes.Equal(docs.GettingStarted, repo) {
		t.Error("reference/getting-started.md is not docs/GETTING-STARTED.md")
	}

	// The orchestrate skill keeps its line cap by pointing at worked sections of
	// patterns.md (orch-skill-v3); each section exists and SKILL.md names it.
	orch, patterns := string(files[skills.Orchestrate+"/SKILL.md"]), string(files[skills.Orchestrate+"/reference/patterns.md"])
	for _, tt := range []struct{ heading, pointer string }{
		{"## 5. A supervised child\n", "`reference/patterns.md` §5"},
		{"## 6. Budget stops\n", "`reference/patterns.md` §6"},
		{"## 7. Discarding a child's work\n", "`reference/patterns.md` §7"},
	} {
		if !strings.Contains(patterns, "\n"+tt.heading) {
			t.Errorf("patterns.md lacks %q", tt.heading)
		}
		if !strings.Contains(orch, tt.pointer) {
			t.Errorf("the orchestrate SKILL.md does not point at %s", tt.pointer)
		}
	}

	// The skills reference their files by the paths they are installed at.
	for _, skill := range []string{skills.Orchestrate, skills.Help, skills.Plugin} {
		body := string(files[skill+"/SKILL.md"])
		for _, ref := range regexp.MustCompile("`(reference/[a-z-]+\\.md)`").FindAllStringSubmatch(body, -1) {
			if _, ok := files[skill+"/"+ref[1]]; !ok {
				t.Errorf("%s names %s, which it does not have", skill, ref[1])
			}
		}
	}
}
