package skills_test

import (
	"bytes"
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
		"code-foundry/SKILL.md",
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
	checkProvenance(t, files, src)
	if want := "Rendered by Code Foundry v9.9.9 (commit 0123456789ab) · source: https://github.com/alexwaumann/code-foundry/tree/v9.9.9\n"; src.Provenance()+"\n" != want {
		t.Errorf("provenance of a release = %q, want %q", src.Provenance(), want)
	}

	// Frontmatter: names, short descriptions, invocation. Each cap includes the two
	// lines of the provenance line under the title (control-2-skill-provenance).
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
		{skills.Orchestrate, "false", 600, 138},
		// The entry skill (control-4-capabilities): what the app is, the one rule and the
		// routing table; what exists is daemon.capabilities, not a list in the file.
		{skills.Entry, "false", 400, 70},
		// Its routing and the app's description moved to the entry skill (control-4);
		// the cap came down from 120 with them.
		{skills.Help, "", 400, 105},   // both: no invocation keys
		{skills.Plugin, "", 600, 122}, // both; names the words that should trigger it
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
			path: skills.Help + "/reference/commands.md", cats: []string{"Project", "Settings", "Thread", "Pull Request", "Action", "View"},
			notCats: []string{"Workspace", "Terminal"},
			// Settings in full, Thread one line each.
			detailed: "  - `<value>`",
			// memory.* for "Remembering preferences", View for "Showing things in the app".
			mentioned: []string{"`settings.set <key> <value>`", "`pr.create`", "`project.add <path>`", "`thread.new`",
				"`memory.show`", "`memory.add <text>`", "`memory.remove <entry>`", "`memory.clear --yes`",
				"`view.panel.worktree`", "`view.panel.linked-prs`", "`ui.presence`", "`ui.notify`"},
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
	}
	if help := string(files[skills.Help+"/reference/commands.md"]); strings.Contains(help, "  - `--request-id") {
		t.Error("the help skill lists thread.new's args; it has the one-line form")
	}
	// The help skill saves standing preferences to the app memory, a setting first
	// (docs/notes/control-3-app-memory.md); its description names them so it fires.
	helpSkill := string(files[skills.Help+"/SKILL.md"])
	for _, want := range []string{"standing preference about the app or how you work in it", "\n## Remembering preferences\n",
		"Check `reference/settings.md` first", "`code-foundry memory add \"<preference>\"`", "not your own memory files",
		// The scope rule (control-8-memory-scope): facts about the user, a project or its code
		// are Claude's own memory; "what do you remember" answers from both.
		"nor a fact about the user, a project or its\ncode", "facts go in your own memory files", "plus your own memory files, each\nlabelled",
		// The memory verbs' own wording (control-6-memory-fixes).
		"\"Remembered: …\". New threads follow it;\n   threads already open get it on their next message after a restart",
		"remove the old entry first", "`code-foundry memory show`"} {
		if !strings.Contains(helpSkill, want) {
			t.Errorf("help SKILL.md lacks %q", want)
		}
	}
	// It fires when the user asks to see something and before showing something in the
	// side panel: a "show me" opens it in the thread's own panel without a presence
	// check, ui.presence only decides what to mention, no ui.notify, page verbs only
	// when asked (control-7-skill-routing). It offers actions in the user's words.
	for _, want := range []string{"asks to see something, or before you show something in the app's side panel", "\n## Showing things in the app\n",
		"open it in your own thread's side panel", "A \"show me\" is asking: just open it", "Add `--focus` only when\nthey ask to be taken there",
		"`view.panel.file <path>`, `view.panel.diff <path>`, `view.panel.pr <number>`", "Do not `ui.notify`",
		"`code-foundry ui.presence --json` is only for deciding whether to mention", "refused from a thread no window shows",
		"`code-foundry daemon.capabilities --group\npanel`", "unless a saved preference says not to",
		"\n## Explain first, then offer\n", "Run it only after the user says yes", "\"Want me to make Fresh copy the\n   default?\"",
		"Show the command only if they ask for it", "by its Settings page label", "the code-foundry skill"} {
		if !strings.Contains(helpSkill, want) {
			t.Errorf("help SKILL.md lacks %q", want)
		}
	}
	// Pages the model writes link the frame stylesheet and may follow the theme live
	// (theme-css-route); the entry skill says the first half.
	for _, want := range []string{"`<link rel=\"stylesheet\" href=\"/cf/theme.css\">`", "`--cf-*` variables", "status triples", "type-role classes", "`{type: \"cf:theme\", id, scheme, vars}`"} {
		if !strings.Contains(helpSkill, want) {
			t.Errorf("help SKILL.md lacks %q", want)
		}
		if entry := string(files[skills.Entry+"/SKILL.md"]); !strings.Contains(entry, want) && !strings.Contains(want, "cf:theme") {
			t.Errorf("entry SKILL.md lacks %q", want)
		}
	}
	// A page shows inline in the conversation (inline-html): both skills name the verb,
	// --panel and cf:resize.
	for _, want := range []string{"`code-foundry view.inline <path>`", "`--panel` also opens it beside the thread", "`{type: \"cf:resize\", height}`"} {
		if !strings.Contains(helpSkill, want) {
			t.Errorf("help SKILL.md lacks %q", want)
		}
		if entry := string(files[skills.Entry+"/SKILL.md"]); !strings.Contains(entry, want) {
			t.Errorf("entry SKILL.md lacks %q", want)
		}
	}
	for _, gone := range []string{"`viewed` is true", "check presence", "started from now on"} {
		if strings.Contains(helpSkill, gone) {
			t.Errorf("help SKILL.md still has %q", gone)
		}
	}

	// The entry skill routes to every other skill and to daemon.capabilities, carries
	// the one rule, and says that the model, not the skill, runs commands. The rules
	// that moved out of the help skill (the --id default, project and thread) are here.
	entry := string(files[skills.Entry+"/SKILL.md"])
	for _, want := range []string{"the code-foundry-help skill", "the code-foundry-orchestrate skill", "the code-foundry-plugin skill",
		"`code-foundry daemon.capabilities`, then `--group <name>`", "\"Reading the source\"", "the line under this title",
		"if you can do it with the CLI,\noffer it and do it", "Skills never run\ncommands themselves: you run `code-foundry …` with your Bash tool",
		"Thread commands without `--id` act on it", "A **project** is a folder on the Mac", "\"Work in\"", "`--yes`",
		// The routing testers' threads missed (control-7-skill-routing).
		"Never tell the user skill or command names: say what you will do, not which command",
		"`code-foundry memory add <text>`", "`code-foundry usage.show`", "`view.panel.file <path>`, `view.panel.diff <path>`, `view.panel.pr <n>`",
		"`.html` file", "`code-foundry pr.create`, `code-foundry project.github.publish`", "Add `--focus` only when the user asks",
		"default `threads.default_worktree`", "The app replaces /model, /effort",
		// The setting is the composer's; where thread new puts a thread is the model's call
		// (thread-new-base-origin).
		"Threads you create with `thread new` are yours to place: in place or `--new-worktree`"} {
		if !strings.Contains(entry, want) {
			t.Errorf("entry SKILL.md lacks %q", want)
		}
	}
	// Its description names the words of the prompts that loaded no skill.
	entryDesc := frontmatter(t, skills.Entry+"/SKILL.md", files[skills.Entry+"/SKILL.md"])["description"]
	for _, w := range []string{"version", "model", "effort", "usage", "cost", "worktree", "file, diff, page, HTML or chart", "preference", "remember", "PR"} {
		if !strings.Contains(entryDesc, w) {
			t.Errorf("entry SKILL.md's description lacks %q", w)
		}
	}
	// Every group the index names is a real group.
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
	for _, want := range []string{
		"## Threads (`[threads]`)", "- `threads.default_model` **",
		"Type: enum, one of `claude-opus-5-5[1m]` (", "Default: `",
		"- `keybindings.thread.new` New Thread: `cmd+n`",
	} {
		if !strings.Contains(set, want) {
			t.Errorf("settings.md lacks %q", want)
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

	// The help skill sends internals questions to the source at the provenance line's
	// ref, starting from the architecture doc, and names the line's dev-build caveat.
	help := string(files[skills.Help+"/SKILL.md"])
	for _, want := range []string{"\n## Reading the source\n", "never answer that from memory", "https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>",
		"gh api 'repos/<owner>/<repo>/contents/<path>?ref=<ref>'", "`docs/ARCHITECTURE.md`", "Cite the file paths", "If the line says `dev build`"} {
		if !strings.Contains(help, want) {
			t.Errorf("the help SKILL.md lacks %q", want)
		}
	}
	if dev := (skills.Sources{Version: "dev", Commit: "0123456789abcdef0123456789abcdef01234567"}).Provenance(); !strings.Contains(dev, "(dev build") {
		t.Errorf("a dev build's provenance line %q does not say `dev build`, which the help skill looks for", dev)
	}

	// The skills reference their files by the paths they are installed at.
	for _, skill := range []string{skills.Entry, skills.Orchestrate, skills.Help, skills.Plugin} {
		body := string(files[skill+"/SKILL.md"])
		for _, ref := range regexp.MustCompile("`(reference/[a-z-]+\\.md)`").FindAllStringSubmatch(body, -1) {
			if _, ok := files[skill+"/"+ref[1]]; !ok {
				t.Errorf("%s names %s, which it does not have", skill, ref[1])
			}
		}
	}
}

// checkProvenance checks every file but the plugin skill's example (a new plugin's own
// files, copied out as they are) carries src's provenance line once, right under its
// title, and has no placeholder left.
func checkProvenance(t *testing.T, files skills.Files, src skills.Sources) {
	t.Helper()
	line := src.Provenance()
	if !strings.HasPrefix(line, "Rendered by Code Foundry "+src.Version+" (commit ") ||
		!strings.Contains(line, " · source: https://github.com/alexwaumann/code-foundry") {
		t.Fatalf("provenance line %q", line)
	}
	for p, b := range files {
		if strings.HasPrefix(p, skills.Plugin+"/example/") {
			if bytes.Contains(b, []byte("Rendered by Code Foundry")) {
				t.Errorf("%s (the example) has the provenance line", p)
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
	// Round 2 of the Ember battle test (ember-fixes-2-skill) added the worker checklist,
	// the combination check, cancel, merge, restart and budget recipes: each one was a
	// discovery call or a wrong claim without its line. Pay for new lines by cutting.
	if n := bytes.Count(ember[p], []byte("\n")); n >= 205 {
		t.Errorf("%s has %d lines; keep it under 205", p, n)
	}
	for _, w := range []string{"ember task add", "ember task start", "--notify", "--labels ember,<task id>", "Never pass `--model`", "cf-task://", "reference/leads.md",
		"--budget", "ember remember", "ember board", "Skill tool", "never progress", "thread send --id <worker>", "thread respond --id <worker>",
		"thread subscribe --at", "git -C <worktree> log origin/<branch>", "--branch <branch>",
		"--prompt - <<'EOF'", "never in double quotes", "merge-tree --write-tree", `"no text`, "ember task cancel", "thread unsubscribe",
		"project branch delete", "pr merge", "at most 1000 characters", "no new errors against the base", "report `blocked`, not `done`",
		// ember-research-tasks: Ember reads to split and assign; a question about code is a
		// research task in the project's checkout that reports findings and closes without a branch.
		"never answer it yourself", "per piece. Anything past a handful of reads", "is a research task", "## Research",
		"--new-worktree=false --prompt - <<'EOF'`: the project's checkout", "touches nothing", `"findings": [...]`,
		`done <task id> "<finding>"` + "` (no `--branch`)", "a parent or research task"} {
		if !bytes.Contains(ember[p], []byte(w)) {
			t.Errorf("%s lacks %q", p, w)
		}
	}
	// Gone with ember task start: the two-command dance and its $(...) footgun. Gone in
	// round 2: a prompt in double quotes (its backticks ran in Ember's shell) and "every
	// caveat in the summary" (over the report cap).
	// Gone with ember-research-tasks: "Understand it" and its unbounded reads (a file whole
	// before saying what a project has or lacks), which let Ember run research itself.
	for _, w := range []string{"Two separate commands", "ember task update <task id> --thread", `--prompt "`, "every caveat",
		"**Understand it.**", "before you say what a project has or lacks"} {
		if bytes.Contains(ember[p], []byte(w)) {
			t.Errorf("%s still has %q", p, w)
		}
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
