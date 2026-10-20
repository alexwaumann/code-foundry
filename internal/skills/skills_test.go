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
		"code-foundry-orchestrate/reference/patterns.md", "code-foundry-orchestrate/reference/wakes.md",
		"code-foundry-orchestrate/reference/leads.md", "code-foundry-orchestrate/reference/sidebar.md",
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
		// Wake and lead rules live in reference files (orch-skill-split); new material
		// goes behind a pointer too, so the cap stays below the old 160. Round 3 of the
		// orchestration experiments (orch-round-3) put nine lines of rules back inline
		// (shared checkout, conflict-free prompts, quiet wake turns, leads, re-reports):
		// the references were read late or not at all, so those rules earn their place.
		{skills.Orchestrate, "false", 600, 136},
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

	// The orchestrate skill keeps its line cap by pointing at reference files: worked
	// sections of patterns.md (orch-skill-v3), and the wake and lead rules
	// (orch-skill-split). Each file has its sections and the file that sends the reader
	// there (SKILL.md, or wakes.md for the supervised and budget sections) names each.
	for _, tt := range []struct{ file, want, from, pointer string }{
		{"reference/patterns.md", "\n## 5. A supervised child\n", "reference/wakes.md", "`reference/patterns.md` §5"},
		{"reference/patterns.md", "\n## 6. Budget stops\n", "reference/wakes.md", "`reference/patterns.md` §6"},
		{"reference/patterns.md", "\n## 7. Discarding a child's work\n", "SKILL.md", "`reference/patterns.md` §7"},
		{"reference/wakes.md", "\n## Pending prompts and questions\n", "SKILL.md", "`reference/wakes.md`"},
		{"reference/wakes.md", "`report_stale: true`", "SKILL.md", "`reference/wakes.md`"},
		{"reference/wakes.md", "\n## A batch of wakes\n", "SKILL.md", "`reference/wakes.md`"},
		{"reference/wakes.md", "\n## After the app restarts\n", "SKILL.md", "`reference/wakes.md`"},
		{"reference/wakes.md", "WITHOUT `--wait`", "SKILL.md", "`reference/wakes.md`"},
		{"reference/wakes.md", "\n## Plugin wake sources\n", "SKILL.md", "`reference/wakes.md`"},
		{"reference/patterns.md", "\n## 8. Checking a batch before the roll-up\n", "SKILL.md", "`reference/patterns.md` §8"},
		{"reference/patterns.md", "\n## 0. The child's prompt\n", "SKILL.md", "`reference/patterns.md` §0"},
		{"reference/wakes.md", "\n## Interrupted\n", "SKILL.md", "`reference/wakes.md`"},
		{"reference/wakes.md", "\n## A child you handed over\n", "reference/sidebar.md", "`reference/wakes.md`"},
		{"reference/leads.md", "# Leads (children that orchestrate)\n", "SKILL.md", "`reference/leads.md`"},
		{"reference/sidebar.md", "\n## Hidden by default\n", "SKILL.md", "`reference/sidebar.md`"},
		{"reference/sidebar.md", "`code-foundry thread sidebar --id <child> --shown=true`", "SKILL.md", "`reference/sidebar.md`"},
		{"reference/sidebar.md", "\n## Handing over\n", "SKILL.md", "`reference/sidebar.md`"},
		{"reference/sidebar.md", "\n## Archiving takes hidden threads along\n", "SKILL.md", "`reference/sidebar.md`"},
		{"reference/leads.md", "Before a lead ends a turn while its workers still run, it posts `code-foundry thread\n  report progress",
			"SKILL.md", "`reference/leads.md`"},
	} {
		if got := string(files[skills.Orchestrate+"/"+tt.file]); !strings.Contains(got, tt.want) {
			t.Errorf("%s lacks %q", tt.file, tt.want)
		}
		if !strings.Contains(string(files[skills.Orchestrate+"/"+tt.from]), tt.pointer) {
			t.Errorf("the orchestrate %s does not point at %s", tt.from, tt.pointer)
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

// Ember's skill is only Ember's: Render leaves it out, EmberFiles has it whole.
func TestEmberSkill(t *testing.T) {
	files, err := skills.Render(skills.Sources{Version: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	for p := range files {
		if strings.HasPrefix(p, skills.Ember+"/") {
			t.Errorf("Render wrote %s", p)
		}
	}
	ember, err := skills.EmberFiles()
	if err != nil {
		t.Fatal(err)
	}
	p := skills.Ember + "/SKILL.md"
	if len(ember) != 1 || len(ember[p]) == 0 {
		t.Fatalf("EmberFiles = %v", ember)
	}
	fm := frontmatter(t, p, ember[p])
	if fm["name"] != skills.Ember || fm["user-invocable"] != "false" {
		t.Errorf("frontmatter = %v", fm)
	}
	if n := bytes.Count(ember[p], []byte("\n")); n >= 160 {
		t.Errorf("%s has %d lines; keep it under 160", p, n)
	}
	for _, w := range []string{"ember task add", "ember task start", "--notify", "--labels ember,<task id>", "Never pass `--model`", "cf-task://", "reference/leads.md",
		"--budget", "ember remember", "ember board", "Skill tool", "never progress", "thread send --id <worker>", "thread respond --id <worker>",
		"thread subscribe --at", "git -C <worktree> log origin/<branch>", "--branch <branch>"} {
		if !bytes.Contains(ember[p], []byte(w)) {
			t.Errorf("%s lacks %q", p, w)
		}
	}
	// Gone with ember task start: the two-command dance and its $(...) footgun.
	for _, w := range []string{"Two separate commands", "ember task update <task id> --thread"} {
		if bytes.Contains(ember[p], []byte(w)) {
			t.Errorf("%s still has %q", p, w)
		}
	}
	if dynamicCommand.Match(ember[p]) {
		t.Errorf("%s runs a shell command when it loads", p)
	}
}
