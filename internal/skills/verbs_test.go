package skills_test

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/guide"
	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// A skill that names a renamed verb or flag sends the model into a failed call, and no
// other test reads the prose, so TestSkillFilesResolve checks what the static files write
// against the live registry (docs/notes/guide-budgets.md). What counts as a command:
//
//   - `code-foundry <verb> [--flag]` in an inline span, a plain or sh fence, a heredoc or
//     a quoted prompt, wherever a line wraps;
//   - a span that starts with a verb and leaves out the program: `thread new --notify`,
//     `view.panel.file --edit`;
//   - h.Invoke and cf.run calls with a literal verb;
//   - a flag with no verb near it (a span or prose): some command must have it.
//
// Prose naming the app or a skill ("the code-foundry skill") is outside code, and go, json,
// html and tsx fences hold SDK types and field names, so neither is read for commands.

// notFlags are the --words in the files that are not code-foundry's: each with its owner.
var notFlags = []string{
	"no-verify",  // git's, in "never --no-verify"
	"until-seen", // an example of a plugin's own flag name (reference/manifest.md)
	"card",       // a CSS variable (reference/react.md)
}

// notFlagPrefixes are CSS custom properties.
var notFlagPrefixes = []string{"cf-", "color-"}

// pluginExamples are the made-up plugins the plugin skill calls (`plugin <name> <command>`);
// their commands exist only once a plugin is installed.
var pluginExamples = []string{"ci", "gh-actions", "notes"}

// notVerbs are dotted names in spans that are neither a verb nor in a live list below.
var notVerbs = []string{
	"project.snapshot", // an event's name (reference/events.md)
}

// otherTools are registry domains that are also real programs: a span starting with one
// is that program unless it says code-foundry.
var otherTools = []string{"git"}

// surface is what the CLI accepts: the registry's commands, the local verbs (not in the
// registry) and every dotted name that means something else.
type surface struct {
	commands   map[string]*v1.Command
	domains    map[string]bool // first segments ("thread", "pr")
	groups     map[string]bool // dotted prefixes of a command ("thread", "project.worktree")
	localVerbs map[string]bool // cmd/code-foundry's subcommands, and help
	localFlags map[string]bool // the flags those parse
	allFlags   map[string]bool
	topics     map[string]bool // `guide <topic>`
	otherNames map[string]bool // plugin capabilities, host facts, setting keys
}

var (
	subcommandName = regexp.MustCompile(`(?m)^\s*\{"([a-z]+)", "`)
	definedFlag    = regexp.MustCompile(`fs\.[A-Z]\w*\((?:&[\w.]+, |\w+, )?"([a-z][a-z-]*)"`)
)

// liveSurface reads the registry, and the CLI's source for its local verbs: their table
// and flag sets are in package main.
func liveSurface(t *testing.T, src skills.Sources) surface {
	t.Helper()
	s := surface{commands: map[string]*v1.Command{}, domains: map[string]bool{}, groups: map[string]bool{},
		localVerbs: map[string]bool{"help": true}, localFlags: map[string]bool{"help": true}, allFlags: map[string]bool{"help": true},
		topics: map[string]bool{}, otherNames: map[string]bool{}}
	for _, c := range src.Commands {
		s.commands[c.GetName()] = c
		parts := strings.Split(c.GetName(), ".")
		s.domains[parts[0]] = true
		for i := 1; i < len(parts); i++ {
			s.groups[strings.Join(parts[:i], ".")] = true
		}
		for _, a := range c.GetArgs() {
			s.allFlags[a.GetName()] = true
		}
	}
	for _, tp := range guide.Topics(src.Commands) {
		s.topics[tp.Name] = true
	}
	for _, n := range slices.Concat(plugintest.HostCapabilities, src.Facts, notVerbs) {
		s.otherNames[n] = true
	}
	for _, f := range src.Settings {
		s.otherNames[f.GetKey()] = true
	}
	main, err := os.ReadFile("../../cmd/code-foundry/main.go")
	if err != nil {
		t.Fatal(err)
	}
	_, table, ok := strings.Cut(string(main), "var subcommands = ")
	table, _, ok2 := strings.Cut(table, "\n}\n")
	if !ok || !ok2 {
		t.Fatal("cmd/code-foundry/main.go has no subcommands table")
	}
	for _, m := range subcommandName.FindAllStringSubmatch(table, -1) {
		s.localVerbs[m[1]] = true
	}
	sources, err := filepath.Glob("../../cmd/code-foundry/*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range sources {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range definedFlag.FindAllStringSubmatch(string(b), -1) {
			s.localFlags[m[1]] = true
			s.allFlags[m[1]] = true
		}
	}
	// The patterns must keep finding what they read: a reshaped table would otherwise
	// turn every local verb into an unknown one, or hide them all.
	if len(s.localVerbs) < 8 || !s.localFlags["since-epoch"] || !s.localFlags["context-thread"] {
		t.Fatalf("local verbs %v, flags %v: the CLI's source changed shape", s.localVerbs, s.localFlags)
	}
	return s
}

var (
	fence      = regexp.MustCompile("(?m)^[ \t]*```([a-z]*)[ \t]*$")
	inlineSpan = regexp.MustCompile("`([^`\n]+(?:\n[^`\n]+)*)`")
	quotedText = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"|'([^'\n]*)'`)
	cliCall    = regexp.MustCompile(`(?:^|[\s(])code-foundry\s+`)
	flagToken  = regexp.MustCompile(`(?:^|[\s\[(=,/])--([a-zA-Z][a-zA-Z0-9-]*)`)
	verbWord   = regexp.MustCompile(`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`)
	callEnds   = regexp.MustCompile(`\||&&|;|\$\(|\)|\n`)
	literalRun = regexp.MustCompile(`(?:h\.Invoke\(ctx, |cf\.run\()"([a-z][a-z.-]*)"`)
	fileName   = regexp.MustCompile(`\.(json|css|md|go|ts|tsx|js|html|yml|sh)$`)
)

// markdownParts splits a Markdown file into what its plain and sh fences hold, its inline
// spans with line wraps folded, and the prose left over.
func markdownParts(md string) (fences, spans []string, prose string) {
	var rest strings.Builder
	pos := 0
	locs := fence.FindAllStringSubmatchIndex(md, -1)
	for i := 0; i+1 < len(locs); i += 2 {
		opening, closing := locs[i], locs[i+1]
		rest.WriteString(md[pos:opening[0]])
		if lang := md[opening[2]:opening[3]]; lang == "" || lang == "sh" {
			fences = append(fences, md[opening[1]:closing[0]])
		}
		pos = closing[1]
	}
	rest.WriteString(md[pos:])
	text := rest.String()
	for _, m := range inlineSpan.FindAllStringSubmatch(text, -1) {
		spans = append(spans, strings.Join(strings.Fields(m[1]), " "))
	}
	return fences, spans, inlineSpan.ReplaceAllString(text, " ")
}

// shellCalls are the commands of some shell text, one per pipe stage or line, with quoted
// strings blanked; what the quotes held (a child's prompt) follows, as shell text itself.
func shellCalls(text string) []string {
	text = strings.ReplaceAll(text, "\\\n", " ")
	var inner []string
	blanked := quotedText.ReplaceAllStringFunc(text, func(q string) string {
		inner = append(inner, strings.ReplaceAll(q[1:len(q)-1], `\"`, `"`))
		return `""`
	})
	calls := callEnds.Split(blanked, -1)
	for _, q := range inner {
		if strings.Contains(q, "code-foundry ") {
			calls = append(calls, shellCalls(q)...)
		}
	}
	return calls
}

// leadingWords are the words of a call before its first flag or placeholder.
func leadingWords(call string) []string {
	var words []string
	for _, f := range strings.Fields(call) {
		if !verbWord.MatchString(f) {
			break
		}
		words = append(words, f)
	}
	return words
}

// flagsOf are the --flags written in some text.
func flagsOf(text string) []string {
	var out []string
	for _, m := range flagToken.FindAllStringSubmatch(text, -1) {
		out = append(out, m[1])
	}
	return out
}

// hasFlag reports whether the CLI takes --name on c: runRegistry's flags or c's args.
func hasFlag(c *v1.Command, name string) bool {
	if name == "yes" {
		return c.GetRequiresConfirmation()
	}
	if name == "json" || name == "help" || strings.HasPrefix(name, "context-") {
		return true
	}
	return slices.ContainsFunc(c.GetArgs(), func(a *v1.ArgSpec) bool { return a.GetName() == name })
}

// foreignFlag reports whether a --word in a file belongs to something else.
func foreignFlag(name string) bool {
	return slices.Contains(notFlags, name) ||
		slices.ContainsFunc(notFlagPrefixes, func(p string) bool { return strings.HasPrefix(name, p) })
}

// checkCall checks one call, its program name removed. Like the CLI it takes the longest
// run of words naming a command; a domain with a .show command runs that, but only with
// no words left over, or any typo after `project` would pass as project.show's argument.
func (s surface) checkCall(call string) []string {
	words := leadingWords(call)
	if len(words) == 0 {
		return nil
	}
	if s.localVerbs[words[0]] {
		switch {
		case words[0] == "help" && len(words) > 1:
			return s.checkVerb(words[1:], "")
		case words[0] == "guide" && len(words) > 1 && !s.topics[words[1]]:
			return []string{fmt.Sprintf("no guide topic %q", words[1])}
		case words[0] == "guide" || len(words) == 1:
			var problems []string
			for _, f := range flagsOf(call) {
				if !s.localFlags[f] {
					problems = append(problems, fmt.Sprintf("%s has no flag --%s", words[0], f))
				}
			}
			return problems
		}
	}
	return s.checkVerb(words, call)
}

// checkVerb checks that words name a command or a group, and that it takes call's flags.
func (s surface) checkVerb(words []string, call string) []string {
	joined := strings.Join(words, ".")
	if segments := strings.Split(joined, "."); segments[0] == "plugin" && len(segments) > 1 && slices.Contains(pluginExamples, segments[1]) {
		return nil
	}
	var cmd *v1.Command
	for n := len(words); n > 0 && cmd == nil; n-- {
		cmd = s.commands[strings.Join(words[:n], ".")]
	}
	if cmd == nil {
		cmd = s.commands[joined+".show"]
	}
	if cmd == nil {
		if s.groups[joined] {
			return nil
		}
		return []string{fmt.Sprintf("no verb %q", strings.Join(words, " "))}
	}
	var problems []string
	for _, f := range flagsOf(call) {
		if !hasFlag(cmd, f) {
			problems = append(problems, fmt.Sprintf("%s has no flag --%s", cmd.GetName(), f))
		}
	}
	return problems
}

// checkSpan checks an inline span, which may be a call without the program name, a flag,
// or something else altogether.
func (s surface) checkSpan(span string) []string {
	var problems []string
	for _, call := range shellCalls(span) {
		if loc := cliCall.FindStringIndex(call); loc != nil {
			problems = append(problems, s.checkCall(call[loc[1]:])...)
			continue
		}
		fields := strings.Fields(call)
		if len(fields) == 0 {
			continue
		}
		first := fields[0]
		switch domain, _, dotted := strings.Cut(first, "."); {
		case strings.HasPrefix(first, "--"), strings.HasPrefix(first, "[--"):
			problems = append(problems, s.checkLooseFlags(call)...)
		case !verbWord.MatchString(first), !s.domains[domain], slices.Contains(otherTools, domain):
		case dotted && (s.otherNames[first] || fileName.MatchString(first)):
		case dotted, len(fields) > 1:
			problems = append(problems, s.checkCall(call)...)
		}
	}
	return problems
}

// checkLooseFlags checks flags with no verb in sight: some command must take each.
func (s surface) checkLooseFlags(text string) []string {
	var problems []string
	for _, f := range flagsOf(text) {
		if !s.allFlags[f] && !foreignFlag(f) {
			problems = append(problems, fmt.Sprintf("no command has --%s", f))
		}
	}
	return problems
}

// checkFile checks one static skill file and says how many calls it read.
func (s surface) checkFile(name, text string) (problems []string, calls int) {
	shell := func(block string) {
		for _, call := range shellCalls(block) {
			if loc := cliCall.FindStringIndex(call); loc != nil {
				calls++
				problems = append(problems, s.checkCall(call[loc[1]:])...)
			}
		}
	}
	for _, m := range literalRun.FindAllStringSubmatch(text, -1) {
		calls++
		problems = append(problems, s.checkVerb(strings.Split(m[1], "."), "")...)
	}
	if !strings.HasSuffix(name, ".md") {
		shell(text)
		return problems, calls
	}
	fences, spans, prose := markdownParts(text)
	for _, f := range fences {
		shell(f)
	}
	for _, sp := range spans {
		if strings.Contains(sp, "code-foundry ") {
			calls++
		}
		problems = append(problems, s.checkSpan(sp)...)
	}
	return append(problems, s.checkLooseFlags(prose)...), calls
}

func TestSkillFilesResolve(t *testing.T) {
	s := liveSurface(t, realSources(t))
	calls := 0
	err := filepath.WalkDir("files", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		problems, n := s.checkFile(p, string(b))
		calls += n
		for _, pr := range problems {
			t.Errorf("%s: %s", p, pr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The files hold about 200: far fewer means the patterns stopped matching.
	if calls < 150 {
		t.Errorf("read %d calls in the skill files; the patterns no longer match", calls)
	}
}

// What the test reads and what it must leave alone. The bad rows are the planted mistakes:
// a verb or flag renamed in the registry looks exactly like them to the test.
func TestResolveChecker(t *testing.T) {
	s := liveSurface(t, realSources(t))
	for _, tt := range []struct {
		name, text string
		want       []string
	}{
		// Planted mistakes.
		{"bad verb", "Run `code-foundry thread subscrib --pr a/b#1`.", []string{`no verb "thread subscrib"`}},
		{"bad verb in a fence", "```\ncode-foundry project worktree cleenup <path>\n```\n", []string{`no verb "project worktree cleenup"`}},
		{"bad verb in an sh fence, wrapped", "```sh\ncode-foundry thread \\\n  nwe --name x\n```\n", []string{`no verb "thread nwe"`}},
		{"bad verb wrapped in a span", "Run `code-foundry thread\nnwe`, then.", []string{`no verb "thread nwe"`}},
		{"bad verb in a child's prompt", "```\ncode-foundry thread new --prompt \"Last: code-foundry thread reprot done\"\n```\n", []string{`no verb "thread reprot done"`}},
		{"bad verb in a heredoc", "```\ncode-foundry thread new --prompt - <<'EOF'\nThen code-foundry thread reprot done.\nEOF\n```\n", []string{`no verb "thread reprot"`}},
		{"bad bare verb", "Use `thread subscrib --every 1h`.", []string{`no verb "thread subscrib"`}},
		{"bad dotted verb", "Use `view.panel.fil <path>`.", []string{`no verb "view.panel.fil"`}},
		{"bad cf.run", `cf.run("thread.sned", {})`, []string{`no verb "thread sned"`}},
		{"bad h.Invoke", "```go\nh.Invoke(ctx, \"thread.sned\", nil)\n```\n", []string{`no verb "thread sned"`}},
		{"bad help target", "`code-foundry help thread nwe`", []string{`no verb "thread nwe"`}},
		{"bad guide topic", "`code-foundry guide nope`", []string{`no guide topic "nope"`}},
		{"bad flag", "Run `code-foundry thread new --new-worktre`.", []string{"thread.new has no flag --new-worktre"}},
		{"bad flag past a placeholder", "`thread new --name <n> --nofity`", []string{"thread.new has no flag --nofity"}},
		{"another verb's flag", "`code-foundry thread get --notify`", []string{"thread.get has no flag --notify"}},
		{"--yes without a confirmation", "`code-foundry thread get --yes`", []string{"thread.get has no flag --yes"}},
		{"bad local flag", "`code-foundry events --sorce x`", []string{"events has no flag --sorce"}},
		{"bad loose flag in a span", "Pass `--new-worktre` to it.", []string{"no command has --new-worktre"}},
		{"bad loose flag in prose", "Pass --new-worktre to it.", []string{"no command has --new-worktre"}},
		// Calls that are right.
		{"good call", "`code-foundry thread new --name x --notify --json --context-thread y`", nil},
		{"spaced and dotted", "`code-foundry thread.new`, `code-foundry project worktree cleanup <p> --yes`", nil},
		{"a domain's show", "`code-foundry usage`", nil},
		{"a group", "`code-foundry thread`, `code-foundry project worktree`", nil},
		{"positionals", `` + "`code-foundry thread report done \"it's done\" --data '{\"a\": 1}'`", nil},
		{"pipe to another tool", "`code-foundry thread list --json | jq --raw-output .`", nil},
		{"local verbs", "`code-foundry events --json --source thread-list`, `code-foundry guide action`, `code-foundry help thread new`", nil},
		{"a local word that is a domain", "`code-foundry daemon.capabilities --group panel`, `code-foundry daemon status`", nil},
		// False positives the audit met.
		{"prose naming a skill", "Read the code-foundry skill, then code-foundry-help.", nil},
		{"wake message", "```\n[code-foundry wake] Thread s-1 settled\n```\n", nil},
		{"home path", "`~/.code-foundry/pages`, `github.com/alexwaumann/code-foundry/pluginsdk`", nil},
		{"SDK types in Go", "```go\nh.Run(\"--anything\") // thread new --nope\nui.Text(\"code-foundry nope\")\n```\n", nil},
		{"field names in JSON", "```json\n{\"thread.nope\": \"--nope\"}\n```\n", nil},
		{"a page's HTML", "```html\n<p>code-foundry nope</p>\n```\n", nil},
		{"another tool", "`git push --delete`, `gh pr view --web`, `go test --nope`", nil},
		{"a plain word pair", "`thread`, `plugin`", nil},
		{"a plugin file", "`plugin.json`, `ui.css`", nil},
		{"a plugin's own command", "`code-foundry plugin ci run rerun-failed`, `plugin notes add \"x\"`", nil},
		{"a capability, a fact, a setting", "`view.node.tabs`, `thread.pr.url`, `dictation.enabled`", nil},
		{"camelCase is a field", "`thread.hasPr`, `gh.pullRequestChanged`", nil},
		{"CSS variables", "`--cf-surface`, `--color-brand: #fff`, `--cf-*`", nil},
		{"git's flag", "never `--no-verify`", nil},
		{"a stray backtick stays in its paragraph", "A ` stray.\n\n`code-foundry thread get`\n", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := s.checkFile("x.md", tt.text)
			if !slices.Equal(got, tt.want) {
				t.Errorf("checkFile(%q) = %q, want %q", tt.text, got, tt.want)
			}
		})
	}
}
