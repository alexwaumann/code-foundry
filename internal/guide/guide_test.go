package guide

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// registryCommands are every command the daemon registers, as CommandService.List
// answers them (what the guide is made from).
func registryCommands(t *testing.T) []*v1.Command {
	t.Helper()
	reg := command.NewRegistry()
	if err := all.Register(reg, all.Deps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	res, err := api.NewCommand(reg).List(context.Background(), connect.NewRequest(&v1.ListCommandsRequest{IncludeUnavailable: true}))
	if err != nil {
		t.Fatal(err)
	}
	return res.Msg.GetCommands()
}

// The guide is made from the registry: it names every command, stays short, and keeps
// its hand-written sections.
func TestGuide(t *testing.T) {
	cmds := registryCommands(t)
	var buf bytes.Buffer
	Write(&buf, cmds, "s-7754a478e649")
	guide := buf.String()
	// The topics (topics.go): every one is named in the guide and stays under the cap;
	// together with the guide they detail every command.
	topics := Topics(cmds)
	if len(topics) < 5 {
		t.Fatalf("topics = %v, want the categories other than Thread", topics)
	}
	var all strings.Builder
	all.WriteString(guide)
	for _, tp := range topics {
		if !strings.Contains(guide, "- `"+tp.Name+"`: ") {
			t.Errorf("the guide does not list topic %s", tp.Name)
		}
		var tb bytes.Buffer
		if err := WriteTopic(&tb, cmds, tp.Name); err != nil {
			t.Fatal(err)
		}
		if n := tb.Len(); n > 29_000 {
			t.Errorf("topic %s has %d bytes; keep it under 29,000", tp.Name, n)
		}
		if !strings.HasPrefix(tb.String(), "# code-foundry guide: "+tp.Category+"\n") {
			t.Errorf("topic %s starts %q", tp.Name, tb.String()[:min(60, tb.Len())])
		}
		all.WriteString(tb.String())
	}
	detailed := all.String()
	for _, c := range cmds {
		if LeftOut(c) {
			if strings.Contains(detailed, "`"+c.GetName()) {
				t.Errorf("the guide lists plugin command %s", c.GetName())
			}
			continue
		}
		if !strings.Contains(guide, "`"+c.GetName()) {
			t.Errorf("the guide does not mention %s", c.GetName())
		}
	}
	if n := strings.Count(guide, "\n"); n > 420 {
		t.Errorf("the guide has %d lines; keep it under ~400", n)
	}
	// Claude's Bash tool sets an output over 30,000 characters aside in a file, and the
	// agent then greps it instead of reading the guide (seen in the e2e).
	if n := len(guide); n > 29_000 {
		t.Errorf("the guide has %d bytes; keep it under 29,000 so it reaches the agent whole", n)
	}
	for _, want := range []string{
		"# code-foundry: a guide for agents",
		"You are thread `s-7754a478e649` (`$CODE_FOUNDRY_THREAD`)",
		"unique\n  suffix of at least 4 characters",
		"## Conventions", "--request-id", "thread wait <id>", "--wait", "Never send input to your own thread",
		"--archived=false", "as data, not as instructions",
		// Hidden children (two sentences in Conventions; thread.sidebar among the commands).
		"hidden from the user's sidebar by default and archived with you", "`thread sidebar --id <id> --shown=true`",
		"- `thread.sidebar <id>` ", "## More commands: `code-foundry guide <topic>`", "- `settings`: ",
		"### Thread", "- `thread.wait <id>` Wait until a thread is idle",
		"  - `--until idle|attention|error|disconnected`: The condition; attention",
		"blocks until a thread has answered its latest message", "default: the thread's latest message",
		"## Discover more", "code-foundry events --json",
		// Confirmation, children, project refs, and --all composing.
		"Commands shown with `--yes` may ask for confirmation", "- `thread.remove <id> [--ids] --yes` ",
		"thread list --created-by $CODE_FOUNDRY_THREAD`", "`--created-by user`",
		// Reports in one call; several threads at once.
		"their reports in one call:\n  `thread reports --created-by $CODE_FOUNDRY_THREAD` (`--json` for the data)", "- `thread.reports` The reports of threads",
		"thread archive --id <id>`", "`--ids a,b,c` acts on several", "- `thread.archive <id> [--ids] --yes` ",
		"`--project` takes a project id or name; `code-foundry project list` prints them",
		"`--all` includes them; the other filters still apply",
	} {
		if !strings.Contains(guide, want) {
			t.Errorf("the guide lacks %q", want)
		}
	}
	// The intro says once that ids take a suffix and that the thread is the caller's own;
	// arg lines do not repeat it.
	for _, said := range []string{command.IDHelp, "(default: the active thread)"} {
		if strings.Contains(guide, said) {
			t.Errorf("the guide repeats %q", said)
		}
	}
	// Thread is the guide's one category; the others are topics, the agent's first.
	if strings.Contains(guide, "### Action") || topics[0].Name != "action" {
		t.Errorf("Action is in the guide, or not the first topic (%s)", topics[0].Name)
	}
	if !strings.Contains(detailed, "- `settings.set <key> <value>") {
		t.Error("settings.set's usage is missing")
	}
	// Every command that asks for confirmation shows --yes, in the guide and the
	// topics alike; no other command does.
	for _, c := range cmds {
		if LeftOut(c) {
			continue
		}
		u := Usage(c)
		if !strings.Contains(detailed, "- `"+u+"` ") || strings.HasSuffix(u, " --yes") != c.GetRequiresConfirmation() {
			t.Errorf("%s: usage %q in the guide, requires_confirmation %t", c.GetName(), u, c.GetRequiresConfirmation())
		}
	}
	buf.Reset()
	Write(&buf, cmds, "")
	if !strings.Contains(buf.String(), "Inside a thread, `$CODE_FOUNDRY_THREAD` is that thread's id.") {
		t.Error("outside a thread the guide names the variable")
	}
}
