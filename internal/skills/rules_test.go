package skills_test

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/skills"
)

// rule is a rule of a skill that a real run broke before it was written down. It says so
// by naming the note holding the failure (docs/notes/<note>.md). Everything else in a skill
// is free to change: wording belongs to the guide eval, which measures whether models
// still find their way, not to a test that freezes sentences.
//
// says and never are case-insensitive regexps over the text with line wraps folded and
// Markdown's backticks and stars removed. Assert the marker that carries the rule (a verb,
// a flag, a number, a word next to its "never"), so a rewrite that keeps the rule passes.
type rule struct {
	note        string
	file        string
	description bool // the frontmatter's description, not the file
	says, never []string
}

const (
	entryFile    = skills.Entry + "/SKILL.md"
	themeRef     = skills.Entry + "/reference/making-a-theme.md"
	scopesRef    = skills.Entry + "/reference/scopes.md"
	helpFile     = skills.Help + "/SKILL.md"
	sourceRef    = skills.Help + "/reference/reading-the-source.md"
	orchFile     = skills.Orchestrate + "/SKILL.md"
	wakesFile    = skills.Orchestrate + "/reference/wakes.md"
	leadsFile    = skills.Orchestrate + "/reference/leads.md"
	patternsFile = skills.Orchestrate + "/reference/patterns.md"
	pagesFile    = skills.Pages + "/SKILL.md"
	sourcesRef   = skills.Pages + "/reference/sources.md"
	reactRef     = skills.Pages + "/reference/react.md"
	emberFile    = skills.Ember + "/SKILL.md"
)

var rules = []rule{
	// Prompts that loaded no skill, and threads that acted like a terminal assistant.
	{note: "control-7-skill-routing", file: entryFile, description: true,
		says: []string{"version", "model", "effort", "usage", "cost", "worktree", "file", "diff", "html", "chart", "theme", "preference", "remember", `\bprs?\b`}},
	{note: "control-7-skill-routing", file: entryFile, says: []string{
		`never .{0,30}skill or command names`, "memory add", `usage\.show`, `view\.open\.file`, `view\.open\.diff`, `view\.open\.pr`,
		`pr\.create`, `project\.github\.publish`, "--focus", `\.html`, `threads\.default_worktree`, "/model"}},
	{note: "control-7-skill-routing", file: helpFile, says: []string{
		// A "show me" is a tab beside the thread (shell-7-view-open; it was "your own side panel"),
		// with no presence check and no notification.
		`a tab beside you`, "--focus", `view\.open\.file`, `view\.open\.diff`, `view\.open\.pr`, `do not ui\.notify`, `ui\.presence`,
		`daemon\.capabilities --group panel`, "no window shows",
		// Settings by the names the user sees, and nothing run before they say yes.
		"settings page label", "user says yes"}},
	// "show me what's running" listed the Mac's processes; a checklist came back as Markdown.
	{note: "bridge-fix-wording", file: entryFile, description: true, says: []string{"what's running", "their work"}},
	{note: "bridge-fix-wording", file: entryFile, says: []string{`never .{0,20}processes`, "to-do"}},
	{note: "bridge-fix-wording", file: pagesFile, description: true,
		says: []string{"to-do", "tick off", "what's running", "what's going on", "their work", `not .{0,20}processes`}},
	// A refusal shown only in the console left a board empty; rows moved under the pointer;
	// a second click started a second thread.
	{note: "bridge-fix-wording", file: pagesFile, says: []string{`onerror\(e\)`, `e\.message`, `cf\.off`, "rows stay put", "request-id"}},
	// Reminders that died with the session.
	{note: "bridge-fix-c-daemon", file: entryFile, says: []string{"thread subscribe", "checks_passed", "--every", `never .{0,40}cron`, "--watch"}},
	{note: "bridge-fix-c-daemon", file: entryFile, description: true, says: []string{"reminder"}},
	{note: "bridge-fix-c-daemon", file: pagesFile, says: []string{"thread subscribe", "checks_passed", "--every", `never .{0,40}cron`, "--watch",
		// The two data shapes, read with each other's names; the gesture window; duplicate cards.
		"thread_status_idle", `…atms`, `reference/sources\.md`, "5 seconds", "once per file"}},
	{note: "bridge-fix-c-daemon", file: sourcesRef, says: []string{"thread_status_idle", "atms", `new date\(ms\)`}},
	// Pages of `--yes` lines to copy, and an API key left in localStorage (the note's page
	// tasks): the page's own thread, its confirmations, its bulk actions, a password field.
	{note: "bridge-3-skill", file: pagesFile, says: []string{`promise\.all`, "on change, not input", "never pass yes or force", `id: cf\.thread\.id`, `"created-by": ""`, "password field"}},
	// localStorage does not outlive the app.
	{note: "bridge-fix-storage", file: pagesFile, says: []string{`cf\.storage\(`, `localstorage.{0,40}cleared`}},
	// A model told the user to paste a key into the file by hand.
	{note: "file-edit-3-agent", file: entryFile, says: []string{`never ask for it in chat`, `view\.open\.file.{0,60}--edit`}},
	{note: "file-edit-3-agent", file: helpFile, says: []string{`view\.open\.file --edit`}},
	// Unthemed pages in the repo, and hand-posted cf:resize.
	{note: "page-library-fixes-b", file: entryFile, says: []string{"code-foundry-pages skill first", `view\.inline`, `/cf/theme\.css`, `/cf/bridge\.js`, "sizes its card"}},
	{note: "page-library-fixes-b", file: helpFile, says: []string{"code-foundry-pages skill", `view\.inline`, `/cf/theme\.css`, `/cf/bridge\.js`, "sizes its card"}},
	{note: "page-library-fixes-b", file: pagesFile, says: []string{`/cf/theme\.css`, `/cf/bridge\.js`, "sizes the card"}},
	{note: "page-library-fixes-b", file: skills.Pages + "/reference/examples.md", never: []string{"setinterval", "cf:resize"}},
	// Overlays and tooltips that broke in a card, arbitrary classes that did nothing.
	{note: "page-library-fixes-a", file: reactRef, says: []string{"<tooltipprovider>", "<toaster />", "min-h-112", `theme\.css\?scheme=light`}},
	// The theme fuzz: models missed the verbs, the floors, --replace and the scheme.
	{note: "theme-fuzz-daemon", file: themeRef, says: []string{
		`body.{0,20}7:1`, `status.{0,20}4\.5:1`, `surface.{0,60}toward the text`, "contrast:", "--replace", "theme set-scheme",
		"never edit the themes folder", "theme list", `code-foundry-help/reference/themes\.md`}},
	// The removed tabs' questions: what changed is the branch, not the uncommitted work.
	{note: "orch-removed-panels-check", file: entryFile, description: true, says: []string{"worktree's changes or prs"}},
	{note: "orch-removed-panels-check", file: entryFile, says: []string{"commits since its base", "thread mcp", "linkedpullrequests", `thread list --created-by`}},
	// "Remember for this workspace" went to the app memory, then to the primary repo.
	{note: "workspaces-v2-5-skills", file: scopesRef, says: []string{"memory add", "thread checkouts", "primary checkout", `\.claude/skills/<name>/skill\.md`}},
	{note: "theme-fuzz-daemon", file: entryFile, says: []string{`reference/making-a-theme\.md`}},
	{note: "workspaces-v2-5-skills", file: entryFile, says: []string{`reference/scopes\.md`}},
	{note: "workspaces-v2-5-skills", file: helpFile, says: []string{"workspace new", "workspace list", `\.claude/skills/<name>/skill\.md`}},
	{note: "workspaces-v2-5-skills", file: orchFile, says: []string{"thread checkouts", "--new-worktree", "--new-branch", "one worker per checkout", "--projects", "never a branch"}},
	// The store goes by what is remembered, not by the verb.
	{note: "control-8-memory-scope", file: helpFile, description: true, says: []string{"standing preference"}},
	{note: "control-8-memory-scope", file: helpFile, says: []string{"memory add", "memory show", "your own memory files", "each labelled"}},
	// A changed memory reaches open threads only after a restart.
	{note: "control-6-memory-fixes", file: helpFile, says: []string{"after a restart", "remove the old entry"}},
	// The source at the build's own revision, and the dev build's caveat.
	{note: "control-2-skill-provenance", file: helpFile, says: []string{"reading the source", "dev build", `docs/architecture\.md`}},
	{note: "control-2-skill-provenance", file: helpFile, says: []string{`reference/reading-the-source\.md`}},
	{note: "control-2-skill-provenance", file: sourceRef, says: []string{"never answer that from memory", `daemon\.version --json`, "dev build", `docs/architecture\.md`}},
	// Round 3: rules read late or not at all from a reference earned their inline place.
	{note: "orch-skill-v4", file: orchFile, says: []string{`git merge-tree --write-tree`, `git diff origin/<default> --stat`, "--descendants-of", "project branch delete"}},
	{note: "orch-skill-v4", file: orchFile, says: []string{"distinct anchor", `git add -a`, "one line", "from the child's wake"}},
	{note: "orch-skill-v4", file: wakesFile, says: []string{"without --wait"}},
	// A child's last message reaches its parent whole, with git's word on the branch.
	{note: "wake-groups", file: orchFile, says: []string{"--notify-group", "do not feed each"}},
	{note: "thread-ask", file: wakesFile, says: []string{"thread ask", "say nothing"}},
	// A --notify subscription ends with the finish's wake; a send renews it (no manual
	// subscribe), and the parent of a lead holds none on the lead's workers.
	{note: "notify-ends-on-finish", file: orchFile, says: []string{"until the wake that says it finished", "subscribes you again"}},
	{note: "notify-ends-on-finish", file: wakesFile, says: []string{"the last wake from that child", "the send subscribes you", "never subscribe or unsubscribe by hand"},
		never: []string{"fires again on its next settle"}},
	{note: "notify-ends-on-finish", file: leadsFile, says: []string{"its answer wakes no one"}},
	{note: "wake-final-message", file: wakesFile, says: []string{"it said", "from the app, not the thread"}, never: []string{"report_stale", "said more"}},
	{note: "wake-final-message", file: orchFile, says: []string{"no closing report", "thread report blocked"}, never: []string{"after any later message", "report_stale"}},
	{note: "wake-final-message", file: emberFile, says: []string{"no closing report", "what git says"}, never: []string{"after any later message", "report_stale"}},
	{note: "orch-skill-v4", file: leadsFile, says: []string{"thread report progress"}},
	// A repo with no remote: committing is done, and blocked is only for work that cannot be
	// finished (children reported blocked for a push with no origin).
	{note: "wakes-fuzz-fixes", file: orchFile, says: []string{"when the repo has a remote", "with none, committing is done", "only if the work itself cannot be finished"},
		never: []string{"if it is blocked or failed"}},
	{note: "wakes-fuzz-fixes", file: patternsFile, says: []string{"with none, the commit is done", "never for a push or PR step"}},
	// Ember stopped loading the orchestrate skill each epoch: what it took from there lives here.
	{note: "orch-skill-v4", file: emberFile, says: []string{"distinct anchor", "only as many spots", `git add -a`, `git diff origin/<default> --stat`, "one line", "take it from its wake"}},
	// Prompts in double quotes ran their backticks in Ember's shell; the worker checklist.
	{note: "ember-fixes-2-skill", file: emberFile, says: []string{
		"--prompt - <<'eof'", "never in double quotes", "--budget", `merge-tree --write-tree`, `"no text`, "ember task cancel", "thread unsubscribe",
		"project branch delete", "pr merge", "thread subscribe --at", `git -c <worktree> log origin/<branch>`, "--branch <branch>",
		"no new errors", "blocked, not done"},
		never: []string{`--prompt "`, "every caveat", `ember task update <task id> --thread`}},
	// The first battle test: steering a worker, its questions, the task loop (S1 to S6).
	{note: "ember-fixes-1-skill-cli", file: emberFile, says: []string{
		"ember task add", "ember task start", "--notify", "--labels ember,<task id>", "never pass --model", "cf-task://", `reference/leads\.md`,
		"ember remember", "ember board", "skill tool", "never progress", "thread send --id <worker>", "thread respond --id <worker>"}},
	// Ember ran whole investigations itself: a question about code is a research task.
	{note: "ember-research-tasks", file: emberFile, says: []string{"never answer it yourself", "research task", `--new-worktree=false`, "touches nothing", "its findings", `no --branch`}},
	// Only a turn's last text shows, and edits only on an explicit ask.
	{note: "ember-rules-reply", file: emberFile, says: []string{"last text", "tells you to do yourself"}, never: []string{"you never edit files"}},
}

// foldForRules is what rules match against.
func foldForRules(s string) string {
	s = strings.NewReplacer("`", "", "**", "").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}

func TestSkillRules(t *testing.T) {
	src := realSources(t)
	files, err := skills.Render(src)
	if err != nil {
		t.Fatal(err)
	}
	ember, err := skills.EmberFiles(src)
	if err != nil {
		t.Fatal(err)
	}
	for p, b := range ember {
		files[p] = b
	}
	for _, r := range rules {
		if _, err := os.Stat("../../docs/notes/" + r.note + ".md"); err != nil {
			t.Errorf("rule from %s: %v", r.note, err)
		}
		b, ok := files[r.file]
		if !ok {
			t.Errorf("rule from %s: no file %s", r.note, r.file)
			continue
		}
		text := string(b)
		where := r.file
		if r.description {
			text, _ = skillParts(t, r.file, b)
			where += "'s description"
		}
		text = foldForRules(text)
		for _, want := range r.says {
			if !regexp.MustCompile("(?i)" + want).MatchString(text) {
				t.Errorf("%s no longer says %q (a rule from docs/notes/%s.md)", where, want, r.note)
			}
		}
		for _, gone := range r.never {
			if regexp.MustCompile("(?i)" + gone).MatchString(text) {
				t.Errorf("%s says %q again (docs/notes/%s.md)", where, gone, r.note)
			}
		}
	}
}
