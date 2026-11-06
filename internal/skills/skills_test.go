package skills_test

import (
	"bytes"
	"cmp"
	"context"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/docs"
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/guide"
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
		PagesDir: "/Users/ada/.code-foundry/pages", Facts: plugin.HostFactNames()}
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

// referenceName is `reference/<file>.md`, with the other skill that owns it before it and
// the section after it, if any.
var referenceName = regexp.MustCompile("(?:(code-foundry[a-z-]*) skill's\\s+)?`(reference/[a-z-]+\\.md)`(?: §([0-9a-z]+))?")

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
		"code-foundry/SKILL.md", "code-foundry/reference/commands.md",
		"code-foundry/reference/making-a-theme.md", "code-foundry/reference/scopes.md",
		"code-foundry-orchestrate/SKILL.md",
		"code-foundry-orchestrate/reference/patterns.md", "code-foundry-orchestrate/reference/wakes.md",
		"code-foundry-orchestrate/reference/leads.md", "code-foundry-orchestrate/reference/sidebar.md",
		"code-foundry-help/SKILL.md", "code-foundry-help/reference/getting-started.md",
		"code-foundry-help/reference/settings.md",
		"code-foundry-help/reference/themes.md",
	}
	want = append(want, pluginSkillFiles...)
	want = append(want, pagesSkillFiles...)
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
	checkProvenance(t, files, src)
	if want := "Rendered by Code Foundry v9.9.9 (commit 0123456789ab) · source: https://github.com/alexwaumann/code-foundry/tree/v9.9.9\n"; src.Provenance()+"\n" != want {
		t.Errorf("provenance of a release = %q, want %q", src.Provenance(), want)
	}

	// Frontmatter: names and invocation. What each may cost is in budget_test.go.
	for _, tt := range []struct{ skill, userInvocable string }{
		{skills.Orchestrate, "false"}, // model only: not in the slash menu
		{skills.Entry, "false"},
		{skills.Help, ""}, // both: no invocation keys
		{skills.Plugin, ""},
	} {
		p := tt.skill + "/SKILL.md"
		fm := frontmatter(t, p, files[p])
		if fm["name"] != tt.skill {
			t.Errorf("%s: name %q", p, fm["name"])
		}
		desc := strings.Trim(fm["description"], `"`)
		if desc == "" || strings.Contains(desc, `"`) {
			t.Errorf("%s: description %q (want one, with no inner quotes)", p, desc)
		}
		if fm["user-invocable"] != tt.userInvocable {
			t.Errorf("%s: user-invocable %q, want %q", p, fm["user-invocable"], tt.userInvocable)
		}
		if _, ok := fm["disable-model-invocation"]; ok {
			t.Errorf("%s: disable-model-invocation is set", p)
		}
	}

	// One command index, in the entry skill, and the other skills name where it is.
	index := string(files[skills.Entry+"/reference/commands.md"])
	for _, c := range src.Commands {
		if n := strings.Count(index, "- `"+c.GetName()+"` "); n != b2i(!guide.LeftOut(c)) {
			t.Errorf("the index lists %s %d times; left out: %t", c.GetName(), n, guide.LeftOut(c))
		}
	}
	for _, s := range []string{skills.Help, skills.Orchestrate} {
		if !bytes.Contains(files[s+"/SKILL.md"], []byte("reference/commands.md")) {
			t.Errorf("%s does not say where the command index is", s)
		}
	}

	// The entry skill routes: to every other skill, and to every capabilities group.
	entry := string(files[skills.Entry+"/SKILL.md"])
	for _, s := range []string{skills.Help, skills.Orchestrate, skills.Plugin, skills.Pages} {
		if !strings.Contains(entry, s) {
			t.Errorf("entry SKILL.md does not route to %s", s)
		}
	}
	for _, g := range command.CapabilityGroups() {
		if !strings.Contains(entry, g) {
			t.Errorf("entry SKILL.md does not name the capabilities group %s", g)
		}
	}

	// The settings reference has one entry per setting with its type and default.
	set := string(files[skills.Help+"/reference/settings.md"])
	for _, f := range src.Settings {
		if n := strings.Count(set, "- `"+f.GetKey()+"` "); n != 1 {
			t.Errorf("settings.md lists %s %d times", f.GetKey(), n)
		}
	}

	// The getting started guide is the repo's file, the one the GUI bundles, with the
	// provenance line under its title.
	repo, err := os.ReadFile("../../docs/GETTING-STARTED.md")
	if err != nil {
		t.Fatal(err)
	}
	title, rest, _ := bytes.Cut(repo, []byte("\n"))
	shipped := slices.Concat(title, []byte("\n\n"+src.Provenance()+"\n"), rest)
	if !bytes.Equal(files[skills.Help+"/reference/getting-started.md"], shipped) || !bytes.Equal(docs.GettingStarted, repo) {
		t.Error("reference/getting-started.md is not docs/GETTING-STARTED.md with the provenance line under its title")
	}
	// So are the theme notes (theme-slots-3).
	themesRepo, err := os.ReadFile("../../docs/THEMES.md")
	if err != nil {
		t.Fatal(err)
	}
	themesTitle, themesRest, _ := bytes.Cut(themesRepo, []byte("\n"))
	if !bytes.Equal(files[skills.Help+"/reference/themes.md"], slices.Concat(themesTitle, []byte("\n\n"+src.Provenance()+"\n"), themesRest)) || !bytes.Equal(docs.Themes, themesRepo) {
		t.Error("reference/themes.md is not docs/THEMES.md with the provenance line under its title")
	}

	// The help skill's source reading goes by the provenance line, whose dev build caveat
	// it names (a rule in rules_test.go).
	if dev := (skills.Sources{Version: "dev", Commit: "0123456789abcdef0123456789abcdef01234567"}).Provenance(); !strings.Contains(dev, "(dev build") {
		t.Errorf("a dev build's provenance line %q does not say `dev build`, which the help skill looks for", dev)
	}

	// The skills reference their files by the paths they are installed at, and a section by
	// its number.
	for _, skill := range []string{skills.Entry, skills.Orchestrate, skills.Help, skills.Plugin, skills.Pages} {
		for p, b := range files {
			if !strings.HasPrefix(p, skill+"/") || !strings.HasSuffix(p, ".md") {
				continue
			}
			for _, ref := range referenceName.FindAllStringSubmatch(string(b), -1) {
				owner := cmp.Or(ref[1], skill)
				target, ok := files[owner+"/"+ref[2]]
				if !ok {
					t.Errorf("%s names %s, which %s does not have", p, ref[2], owner)
				}
				if ref[3] != "" && !bytes.Contains(target, []byte("\n## "+ref[3]+". ")) {
					t.Errorf("%s points at %s §%s, which has no such section", p, ref[2], ref[3])
				}
			}
		}
	}
}

// checkProvenance checks every file but those copied out as they are (the plugin skill's
// example, a new plugin's own files, and the welcome page, which PlaceWelcome writes to
// the pages root) carries src's provenance line once, right under its title, and has no
// placeholder left.
func checkProvenance(t *testing.T, files skills.Files, src skills.Sources) {
	t.Helper()
	line := src.Provenance()
	if !strings.HasPrefix(line, "Rendered by Code Foundry "+src.Version+" (commit ") ||
		!strings.Contains(line, " · source: https://github.com/alexwaumann/code-foundry") {
		t.Fatalf("provenance line %q", line)
	}
	for p, b := range files {
		if strings.HasPrefix(p, skills.Plugin+"/example/") || p == skills.Pages+"/reference/"+skills.WelcomeFile {
			if bytes.Contains(b, []byte("Rendered by Code Foundry")) {
				t.Errorf("%s (copied out as it is) has the provenance line", p)
			}
			continue
		}
		body := string(b)
		if fm, rest, ok := strings.Cut(body, "\n---\n\n"); ok && strings.HasPrefix(fm, "---\n") {
			body = rest // a SKILL.md's frontmatter
		}
		title, _, _ := strings.Cut(body, "\n")
		switch {
		case strings.Count(string(b), line) != 1:
			t.Errorf("%s has the provenance line %d times, want once", p, strings.Count(string(b), line))
		case !strings.HasPrefix(title, "# ") || !strings.HasPrefix(body, title+"\n\n"+line+"\n\n"):
			t.Errorf("%s does not have the provenance line right under its title", p)
		}
		if strings.Contains(body, "{{cf.") {
			t.Errorf("%s has an unfilled placeholder", p)
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
	// A dev build: the line names the commit and says the source may differ.
	src := skills.Sources{Version: "dev", Commit: "0123456789abcdef0123456789abcdef01234567-dirty"}
	ember, err := skills.EmberFiles(src)
	if err != nil {
		t.Fatal(err)
	}
	p := skills.Ember + "/SKILL.md"
	if len(ember) != 1 || len(ember[p]) == 0 {
		t.Fatalf("EmberFiles = %v", ember)
	}
	checkProvenance(t, ember, src)
	if want := "Rendered by Code Foundry dev (commit 0123456789ab-dirty) · source: https://github.com/alexwaumann/code-foundry/tree/0123456789abcdef0123456789abcdef01234567 (dev build"; !bytes.Contains(ember[p], []byte(want)) {
		t.Errorf("%s lacks %q", p, want)
	}
	fm := frontmatter(t, p, ember[p])
	if fm["name"] != skills.Ember || fm["user-invocable"] != "false" {
		t.Errorf("frontmatter = %v", fm)
	}
	if dynamicCommand.Match(ember[p]) {
		t.Errorf("%s runs a shell command when it loads", p)
	}
}

// Shipped lists what Render ships (not Ember's), each with its description's first
// clause as a one-line purpose and its installed SKILL.md path.
func TestShipped(t *testing.T) {
	got, err := skills.Shipped("/home/.claude/skills")
	if err != nil {
		t.Fatal(err)
	}
	want := []skills.Skill{
		{Name: skills.Entry, Purpose: "Start here for anything about Code Foundry, the app this thread runs in", Path: "/home/.claude/skills/code-foundry/SKILL.md"},
		{Name: skills.Help, Purpose: "Answer how-to questions about Code Foundry, the app this thread runs in", Path: "/home/.claude/skills/code-foundry-help/SKILL.md"},
		{Name: skills.Orchestrate, Purpose: "Run several pieces of work in parallel as Code Foundry threads, each in its own worktree and branch",
			Path: "/home/.claude/skills/code-foundry-orchestrate/SKILL.md"},
		{Name: skills.Pages, Purpose: "Build an HTML or React page that reads Code Foundry live and acts on it through /cf/bridge.js",
			Path: "/home/.claude/skills/code-foundry-pages/SKILL.md"},
		{Name: skills.Plugin, Purpose: "Build, debug and publish a Code Foundry plugin", Path: "/home/.claude/skills/code-foundry-plugin/SKILL.md"},
	}
	if !slices.Equal(got, want) {
		t.Errorf("Shipped = %+v\nwant %+v", got, want)
	}
	files, err := skills.Render(skills.Sources{Version: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range got {
		if _, ok := files[s.Name+"/SKILL.md"]; !ok {
			t.Errorf("Shipped lists %s, which Render does not ship", s.Name)
		}
	}
}

// b2i is 1 for true.
func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}
