package skills_test

import (
	"bytes"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bridge"
	"github.com/alexwaumann/code-foundry/internal/skills"
)

// pagesSkillFiles are the code-foundry-pages skill's files.
var pagesSkillFiles = []string{"code-foundry-pages/SKILL.md", "code-foundry-pages/reference/examples.md",
	"code-foundry-pages/reference/sources.md"}

// cfRun is a cf.run call in a skill file with a literal verb and an args object:
// cf.run("verb", { a: x, "b-c": y }).
var cfRun = regexp.MustCompile(`cf\.run\("([a-z.-]+)",\s*\{([^}]*)\}`)

// backticked is a `word` in a table cell.
var backticked = regexp.MustCompile("`([a-zA-Z.-]+)`")

// cfOn is a cf.on call with a literal source and a function literal.
var cfOn = regexp.MustCompile(`cf\.on\("[a-z-]+",\s*\(`)

// callArgs counts the top-level arguments of the call whose "(" starts src.
func callArgs(src string) int {
	depth, n := 0, 0
	var quote rune
	for _, r := range src {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'' || r == '`':
			quote = r
		case r == '(' || r == '{' || r == '[':
			depth++
			if depth == 1 {
				n = 1
			}
		case r == ')' || r == '}' || r == ']':
			depth--
			if depth == 0 {
				return n
			}
		case r == ',' && depth == 1:
			n++
		}
	}
	return n
}

// argKey is one key of such an args object: a bare name or a quoted one.
var argKey = regexp.MustCompile(`(?:^|,)\s*(?:"([a-z-]+)"|([a-z][a-zA-Z]*))\s*:`)

// The pages skill (bridge-3-skill): what a page is for, the bridge as the script serves
// it, the gesture rule, every error code and event source, the own-thread id, storage and
// the limits; its examples call real verbs with real args.
func TestRenderPagesSkill(t *testing.T) {
	src := realSources(t)
	files, err := skills.Render(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pagesSkillFiles {
		if len(files[p]) == 0 {
			t.Fatalf("%s is missing or empty", p)
		}
	}
	p := skills.Pages + "/SKILL.md"
	body := string(files[p])
	fm := frontmatter(t, p, files[p])
	if fm["name"] != skills.Pages {
		t.Errorf("name %q", fm["name"])
	}
	// Model-invocable and in the slash menu, like help and plugin.
	if _, ok := fm["user-invocable"]; ok {
		t.Errorf("user-invocable is set")
	}
	desc := strings.Trim(fm["description"], `"`)
	if len(desc) >= 400 || strings.Contains(desc, `"`) {
		t.Errorf("description of %d characters (want under 400, no inner quotes)", len(desc))
	}
	// "what's running", "my work", "tick off" and "to-do" loaded no skill in testing
	// (bridge-fix-wording); "never the processes" keeps "what's running" off ps.
	for _, w := range []string{"page", "dashboard", "form", "chart", "tool", "checklist", "board", "tracker", "UI", "/cf/bridge.js",
		"to-do", "tick off", "what's running", "what's going on", "their work", "not the Mac's processes"} {
		if !strings.Contains(desc, w) {
			t.Errorf("description lacks %q", w)
		}
	}
	// The examples are in reference/examples.md.
	if n := bytes.Count(files[p], []byte("\n")); n > 160 {
		t.Errorf("%s has %d lines; keep it under 160", p, n)
	}
	for _, f := range pagesSkillFiles {
		if n := len(files[f]); n > 16<<10 {
			t.Errorf("%s has %d bytes; keep it under %d", f, n, 16<<10)
		}
	}

	// The API block is bridge.js's header, verbatim.
	for _, line := range []string{"cf.run(verb, args?, opts?)    Promise of {text, json}; rejects with {code, message}",
		"cf.on(source, fn) / cf.off    live data, fn(value, source): now, then on change; on returns an unsubscribe",
		"cf.storage(prefix?)           the thread's page storage, kept across app restarts"} {
		if !strings.Contains(body, "\n"+line+"\n") || !bytes.Contains(bridge.Script(), []byte(line)) {
			t.Errorf("SKILL.md lacks the header line %q", line)
		}
	}
	for _, code := range bridge.ErrorCodes {
		if !strings.Contains(body, "`"+code+"`") || !strings.Contains(body, "  - `"+code+"`: ") {
			t.Errorf("SKILL.md does not say what to do on %s", code)
		}
	}
	for _, s := range bridge.Sources {
		if !strings.Contains(body, "`"+s+"`") {
			t.Errorf("SKILL.md does not describe the source %s", s)
		}
	}
	for _, want := range []string{
		// Page, wake, plugin or reply; a wake for reminders and schedules, never the
		// session's cron (bridge-fix-c-daemon).
		"## Page, wake, plugin or reply", "the code-foundry-plugin skill", "It runs only while it is on screen",
		"`code-foundry thread subscribe --pr owner/name#4 --until checks_passed`", "`--every 1h`", "--until attention --repeat",
		"Never Claude\n  Code's own cron or a `--watch` loop",
		// The two shapes and the field reference.
		"Two shapes, never mixed", "THREAD_STATUS_IDLE", "`…AtMs`", "`reference/sources.md`",
		// The skeleton.
		`<link rel="stylesheet" href="/cf/theme.css">`, `<script src="/cf/bridge.js"></script>`, "await cf.ready", "`--cf-*` variables",
		"no framework", "no build step", "`--json`",
		// The gesture rule, confirmations, own thread.
		"runs only from a click or key press in the page", "counts for 5 seconds", "`await Promise.all(items.map(", "on `change`, not `input`",
		"Never pass `yes` or `force`", "its own dialog opens over the page", "`id: cf.thread.id`", "`sidebar: true`",
		"update that row from the result at once", "a wrong or missing arg",
		// Live data and state.
		"never polling", "Never `setInterval`", "`cf.storage(", "survives reloads and app\nrestarts", "Every page of this\nthread shares it",
		"`localStorage` is cleared when the app quits", "another thread starts empty", "only while Ember is open", "show its message",
		// onError and cf.off; rows that do not move under the pointer (bridge-fix-wording).
		"`onError(e)` gets a refusal: show `e.message` in the\npage", "`cf.off(source)`", "**Rows stay put**", "acts on its row's id",
		// Wording from testing: the folder, limits, the verbs table, declines, results.
		"read nothing in\nother threads' folders or the app's home", "never try values on the user's real settings to find a limit",
		"A starter list: every verb the CLI runs works", "not an error. Button back, at most a muted", "never print `text`",
		"`request-id` per row: a second click then resolves with the same thread, a success",
		// Limits.
		"**On screen only.**", "SSO and OAuth redirects", "ask the user to paste an API", "a plugin is needed",
		"**Data a source lacks**", "A plugin cannot feed a page",
		"reference/examples.md", "`code-foundry view.inline <path>", "once per file", "never\nrun view.inline for that file again",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("SKILL.md lacks %q", want)
		}
	}
	// Reads it calls read-only are read-only.
	readOnly := map[string]bool{}
	args := map[string][]string{}
	for _, c := range src.Commands {
		readOnly[c.GetName()] = c.GetReadOnly()
		for _, a := range c.GetArgs() {
			args[c.GetName()] = append(args[c.GetName()], a.GetName())
		}
	}
	for _, v := range []string{"thread.get", "thread.list", "usage.show", "pr.checks", "settings.get"} {
		if !readOnly[v] || !strings.Contains(body, v) {
			t.Errorf("%s is named as a read but is not read-only (or not named)", v)
		}
	}

	// Every cf.run in the skill calls a real verb with its real args.
	n := 0
	for _, f := range pagesSkillFiles {
		for _, m := range cfRun.FindAllStringSubmatch(string(files[f]), -1) {
			n++
			verb, obj := m[1], m[2]
			known, ok := args[verb]
			if !ok {
				t.Errorf("%s: cf.run(%q): no such verb", f, verb)
				continue
			}
			for _, k := range argKey.FindAllStringSubmatch(obj, -1) {
				name := k[1] + k[2]
				if !slices.Contains(known, name) {
					t.Errorf("%s: cf.run(%q) passes %q, not one of its args %v", f, verb, name, known)
				}
			}
		}
	}
	if n < 3 {
		t.Errorf("found %d cf.run calls in the pages skill; the pattern no longer matches", n)
	}

	// "Verbs pages use": each row's verbs are real, its backticked words are their args,
	// and the marks match the registry (read: read-only; asks: a confirmation).
	confirms := map[string]bool{}
	for _, c := range src.Commands {
		confirms[c.GetName()] = c.GetRequiresConfirmation()
	}
	_, table, _ := strings.Cut(body, "## Verbs pages use\n")
	table, _, _ = strings.Cut(table, "\n## ")
	rows := 0
	for _, line := range strings.Split(table, "\n") {
		cols := strings.Split(line, " | ")
		if len(cols) != 2 || !strings.HasPrefix(line, "| `") {
			continue
		}
		rows++
		verbs := backticked.FindAllStringSubmatch(cols[0], -1)
		var known []string
		for _, v := range verbs {
			if _, ok := args[v[1]]; !ok {
				t.Errorf("verbs table: no such verb %q", v[1])
			}
			known = append(known, args[v[1]]...)
			if strings.Contains(cols[0], "(read)") != readOnly[v[1]] && len(verbs) == 1 {
				t.Errorf("verbs table: %s marked read %v, registry %v", v[1], strings.Contains(cols[0], "(read)"), readOnly[v[1]])
			}
			if strings.Contains(cols[0], "(asks") && !confirms[v[1]] {
				t.Errorf("verbs table: %s marked as asking first but has no confirmation", v[1])
			}
		}
		for _, a := range backticked.FindAllStringSubmatch(cols[1], -1) {
			if !slices.Contains(known, a[1]) && a[1] != "headSha" {
				t.Errorf("verbs table: %q is not an arg of %s", a[1], cols[0])
			}
		}
	}
	if rows < 8 {
		t.Errorf("verbs table has %d rows", rows)
	}

	// The field reference has a section per source (its fields are checked against the
	// GUI's view models by gui/frontend/src/api/bridgeSourcesDoc.test.ts).
	ref := string(files[skills.Pages+"/reference/sources.md"])
	for _, s := range bridge.Sources {
		if !strings.Contains(ref, "\n## "+s+"\n") {
			t.Errorf("reference/sources.md has no section for %s", s)
		}
	}
	for _, want := range []string{"THREAD_STATUS_IDLE", "AtMs", "`new Date(ms)`", "code unavailable"} {
		if !strings.Contains(ref, want) {
			t.Errorf("reference/sources.md lacks %q", want)
		}
	}

	ex := string(files[skills.Pages+"/reference/examples.md"])
	for _, want := range []string{`cf.on("gh"`, `cf.run("pr.merge"`, `"head-sha": pr.headSha`, `cf.run("thread.new"`, "Promise.allSettled",
		`type="password"`, `cf.storage("linear")`, "await cf.ready"} {
		if !strings.Contains(ex, want) {
			t.Errorf("examples.md lacks %q", want)
		}
	}
	if strings.Contains(ex, "setInterval") || strings.Contains(ex, "cf:resize") {
		t.Error("examples.md polls or sizes the card by hand")
	}
	// Every cf.on in the skeleton and the examples passes an onError: a refusal shown
	// only in the console left a board empty in testing.
	ons := 0
	for _, f := range []string{p, skills.Pages + "/reference/examples.md"} {
		src := string(files[f])
		for _, i := range cfOn.FindAllStringIndex(src, -1) {
			ons++
			if n := callArgs(src[i[0]+len("cf.on"):]); n < 3 {
				t.Errorf("%s: %s… passes %d args; pass an onError that shows the message", f, src[i[0]:min(i[1]+40, len(src))], n)
			}
		}
	}
	if ons < 2 {
		t.Errorf("found %d cf.on calls in the skeleton and examples; the pattern no longer matches", ons)
	}
	for _, want := range []string{`"request-id": `, `json?.name`, `"not merged"`, `"muted"`, "localeCompare"} {
		if !strings.Contains(ex, want) {
			t.Errorf("examples.md lacks %q", want)
		}
	}

	// The entry and help skills route pages to it; ThreadPrompt is checked in its package.
	if !strings.Contains(string(files[skills.Entry+"/SKILL.md"]), "the code-foundry-pages skill first") {
		t.Error("entry SKILL.md does not route pages to code-foundry-pages")
	}
	if !strings.Contains(string(files[skills.Help+"/SKILL.md"]), "the code-foundry-pages skill") {
		t.Error("help SKILL.md does not point at code-foundry-pages")
	}
}
