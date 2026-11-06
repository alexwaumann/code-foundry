package skills_test

import (
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bridge"
	"github.com/alexwaumann/code-foundry/internal/pagelib"
	"github.com/alexwaumann/code-foundry/internal/skills"
)

// pagesSkillFiles are the code-foundry-pages skill's files.
var pagesSkillFiles = []string{"code-foundry-pages/SKILL.md", "code-foundry-pages/reference/examples.md",
	"code-foundry-pages/reference/sources.md", "code-foundry-pages/reference/verbs.md", "code-foundry-pages/reference/react.md",
	"code-foundry-pages/reference/components.md", "code-foundry-pages/reference/errors-and-limits.md",
	"code-foundry-pages/reference/welcome.md",
	"code-foundry-pages/reference/welcome.html"}

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

// bridgeHeaderLine is the line of bridge.js's header comment starting with prefix.
func bridgeHeaderLine(t *testing.T, prefix string) string {
	t.Helper()
	for _, line := range strings.Split(string(bridge.Script()), "\n") {
		if rest, ok := strings.CutPrefix(line, " *   "); ok && strings.HasPrefix(rest, prefix) {
			return rest
		}
	}
	t.Fatalf("bridge.js's header has no line for %s", prefix)
	return ""
}

// The pages skill (bridge-3-skill): the bridge as the script serves it, every error code
// and event source, and examples that call real verbs with real args. Its rules are in
// rules_test.go.
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
	// The first-run instructions name the page where PlaceWelcome writes it.
	for _, p := range []string{skills.Pages + "/reference/welcome.md", skills.Help + "/SKILL.md"} {
		if want := "`/Users/ada/.code-foundry/pages/welcome.html`"; !strings.Contains(string(files[p]), want) {
			t.Errorf("%s does not name the welcome page as %s", p, want)
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
	if desc := strings.Trim(fm["description"], `"`); desc == "" || strings.Contains(desc, `"`) {
		t.Errorf("description %q (want one, with no inner quotes)", desc)
	}

	// The API block is bridge.js's header, verbatim, for what a page calls.
	for _, api := range []string{"cf.run(", "cf.on(", "cf.storage(", "cf.fetch("} {
		line := bridgeHeaderLine(t, api)
		if !strings.Contains(body, "\n"+line+"\n") {
			t.Errorf("SKILL.md lacks bridge.js's header line %q", line)
		}
	}
	errors := string(files[skills.Pages+"/reference/errors-and-limits.md"])
	for _, code := range bridge.ErrorCodes {
		if !strings.Contains(errors, "`"+code+"`") || !strings.Contains(errors, "  - `"+code+"`: ") {
			t.Errorf("errors-and-limits.md does not say what to do on %s", code)
		}
	}
	for _, s := range bridge.Sources {
		if !strings.Contains(body, "`"+s+"`") {
			t.Errorf("SKILL.md does not describe the source %s", s)
		}
	}
	// Reads it calls read-only are read-only.
	readOnly := map[string]bool{}
	args := map[string][]string{}
	for _, c := range src.Commands {
		readOnly[c.GetName()] = c.GetReadOnly()
		args[c.GetName()] = []string{} // a verb with no args is a verb too
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
	// In reference/verbs.md (page-library: moved out of SKILL.md for the React skeleton).
	verbsRef := string(files[skills.Pages+"/reference/verbs.md"])
	_, table, _ := strings.Cut(verbsRef, "| Verb | Args |\n")
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

	// reference/components.md names every @cf/ui export, as built (internal/pagelib's
	// ui-exports.json), one line each with what it is, and no name that is not one.
	comps := string(files[skills.Pages+"/reference/components.md"])
	exports := pagelib.UIExports()
	if len(exports) < 50 {
		t.Fatalf("pagelib.UIExports() has %d names; run make pagelib", len(exports))
	}
	for _, name := range exports {
		if !strings.Contains(comps, "\n- `"+name+"`: ") {
			t.Errorf("reference/components.md has no line for @cf/ui's %s", name)
		}
	}
	for _, m := range regexp.MustCompile("\n- `([A-Za-z]+)`: ").FindAllStringSubmatch(comps, -1) {
		if !slices.Contains(exports, m[1]) {
			t.Errorf("reference/components.md lists %s, which @cf/ui does not export", m[1])
		}
	}
	react := string(files[skills.Pages+"/reference/react.md"])
	// What a page loads and the import map, from pagelib.
	for _, want := range []string{pagelib.JSXPath, pagelib.UICSSPath, pagelib.TailwindPath, "/cf/theme.css", "/cf/bridge.js"} {
		if !strings.Contains(react, want) {
			t.Errorf("reference/react.md lacks %q", want)
		}
	}
	for _, im := range pagelib.ImportMap {
		if !strings.Contains(react, "`"+im.Specifier+"`") {
			t.Errorf("reference/react.md does not name the import %s", im.Specifier)
		}
	}
	if regexp.MustCompile(`(src|href)="https?:`).MatchString(react) {
		t.Error("reference/react.md loads something from the internet")
	}

	// The entry and help skills route pages to it; ThreadPrompt is checked in its package.
	if !strings.Contains(string(files[skills.Entry+"/SKILL.md"]), "the code-foundry-pages skill first") {
		t.Error("entry SKILL.md does not route pages to code-foundry-pages")
	}
	if !strings.Contains(string(files[skills.Help+"/SKILL.md"]), "the code-foundry-pages skill") {
		t.Error("help SKILL.md does not point at code-foundry-pages")
	}
}
