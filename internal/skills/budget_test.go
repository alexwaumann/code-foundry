package skills_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/guide"
	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Budgets replace the line caps and the guide's soft cap, which measured the wrong thing and
// moved with every addition (docs/notes/guide-budgets.md). They are bytes because bytes are
// what a test can count without a tokenizer, and only a proxy: Opus 5.5 gets 2.3 to 2.9
// bytes per token, depending on the file. Tiers follow who pays:
//
//   - every request of every thread: strict, nothing to spare;
//   - a skill's body, when it loads: looser;
//   - the guide and references, when asked for: a limit, not a target.
//
// Over budget, cut. A number goes down when a trim lands. Raising one needs a reason written
// in its row and a `make guide-eval` run, since a skill's bytes are what that measures.
const (
	// A description's listing goes with every request, like ThreadPrompt, so it gets almost
	// no room: its size on 2026-11-06 rounded up to the next 20 bytes.
	everyRequest = "every request pays for this; cut to add"
	// A body is paid only when it loads, so it gets about 5% over its size on 2026-11-06,
	// rounded up to the next 100: a routing row or two (120 to 250 bytes each) fits, a new
	// section does not.
	whenLoaded = "paid when the skill loads; room for a row or two, not a section"
	// Claude's Bash tool sets an output over 30,000 characters aside in a file, and the
	// agent then greps it instead of reading it (seen in the e2e). This is that limit with a
	// margin, not a target: no run of the guide eval called `guide` at all.
	wholeOutput = "Bash sets output over 30,000 characters aside, and the agent then greps it"
	// A reference is read when a skill points at it and an agent reads it whole; past this
	// it should be two files. It is the plugin skill's old file limit, now for every skill.
	wholeRead = "an agent reads a reference whole; split it instead"
)

// budget is the most bytes something may have.
type budget struct {
	name string
	max  int
	why  string
}

// skillBudgets are the skills' rows: a description and a body each. Ember's are paid only
// by Ember's threads, and they stay the same kind of cost there.
var skillBudgets = []struct {
	skill       string
	description int
	body        int
}{
	{skills.Entry, 420, 8_300},
	{skills.Help, 400, 7_900},
	{skills.Orchestrate, 540, 9_700},
	{skills.Pages, 400, 10_600},
	{skills.Plugin, 420, 5_500},
	{skills.Ember, 260, 13_900},
}

const (
	// threadPromptBudget has its own history: without the page clause's last 92 bytes, page
	// prompts in a project thread wrote unthemed pages into the repo, 1 of 15 routed against
	// 14 of 20 with them (page-library-fixes-b). Anything new has to pay with a cut.
	threadPromptBudget = 1_641
	guideBudget        = 29_000
	referenceBudget    = 32 << 10
)

// skillParts splits a SKILL.md into its description and its body under the frontmatter.
func skillParts(t *testing.T, name string, b []byte) (description string, body []byte) {
	t.Helper()
	description = strings.Trim(frontmatter(t, name, b)["description"], `"`)
	_, body, ok := bytes.Cut(b, []byte("\n---\n"))
	if !ok {
		t.Fatalf("%s has no frontmatter", name)
	}
	return description, body
}

func TestBudgets(t *testing.T) {
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
	check := func(b budget, n int) {
		t.Helper()
		if n > b.max {
			t.Errorf("%s has %d bytes, %d over its budget of %d: %s", b.name, n, n-b.max, b.max, b.why)
		}
	}

	check(budget{"ThreadPrompt", threadPromptBudget, everyRequest}, len(thread.ThreadPrompt))
	for _, s := range skillBudgets {
		p := s.skill + "/SKILL.md"
		description, body := skillParts(t, p, files[p])
		check(budget{p + "'s description", s.description, everyRequest}, len(description))
		check(budget{p + "'s body", s.body, whenLoaded}, len(body))
	}

	var buf bytes.Buffer
	guide.Write(&buf, src.Commands, "s-7754a478e649")
	check(budget{"the guide", guideBudget, wholeOutput}, buf.Len())
	for _, tp := range guide.Topics(src.Commands) {
		buf.Reset()
		if err := guide.WriteTopic(&buf, src.Commands, tp.Name); err != nil {
			t.Fatal(err)
		}
		check(budget{"guide topic " + tp.Name, guideBudget, wholeOutput}, buf.Len())
	}

	for p, b := range files {
		if !strings.HasSuffix(p, "/SKILL.md") {
			check(budget{p, referenceBudget, wholeRead}, len(b))
		}
	}
}

// Every skill has a row: a new one must say what it may cost.
func TestEverySkillHasABudget(t *testing.T) {
	shipped, err := skills.Shipped("/x")
	if err != nil {
		t.Fatal(err)
	}
	has := map[string]bool{}
	for _, s := range skillBudgets {
		has[s.skill] = true
	}
	for _, s := range shipped {
		if !has[s.Name] {
			t.Errorf("%s has no row in skillBudgets", s.Name)
		}
	}
}
