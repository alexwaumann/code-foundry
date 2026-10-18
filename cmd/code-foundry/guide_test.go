package main

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
	writeGuide(&buf, cmds, "s-7754a478e649")
	guide := buf.String()
	for _, c := range cmds {
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
		"### Thread", "- `thread.wait <id>` Wait until a thread is idle",
		"  - `--until idle|attention|error|disconnected`: idle, attention",
		"## Discover more", "code-foundry events --json",
		// Confirmation, children, project refs, and --all composing.
		"Commands shown with `--yes` may ask for confirmation", "- `thread.remove [--id] [--ids] --yes` ",
		"thread list --created-by $CODE_FOUNDRY_THREAD`", "`--created-by user`",
		// Reports in one call; several threads at once.
		"their reports in one call:\n  `thread reports --created-by $CODE_FOUNDRY_THREAD` (`--json` for the data)", "- `thread.reports` The reports of threads",
		"thread archive --id <id>`", "`--ids a,b,c` acts on several", "- `thread.archive [--id] [--ids] --yes` ",
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
	// Thread comes first; categories without details list their flags inline.
	if strings.Index(guide, "### Thread") > strings.Index(guide, "### Action") {
		t.Error("Thread is not the first category")
	}
	if !strings.Contains(guide, "- `settings.set <key> <value>") {
		t.Error("settings.set's usage is missing")
	}
	// Every command that asks for confirmation shows --yes, in the detailed and the
	// one-line forms alike; no other command does.
	for _, c := range cmds {
		u := guideUsage(c)
		if !strings.Contains(guide, "- `"+u+"` ") || strings.HasSuffix(u, " --yes") != c.GetRequiresConfirmation() {
			t.Errorf("%s: usage %q in the guide, requires_confirmation %t", c.GetName(), u, c.GetRequiresConfirmation())
		}
	}
	buf.Reset()
	writeGuide(&buf, cmds, "")
	if !strings.Contains(buf.String(), "Inside a thread, `$CODE_FOUNDRY_THREAD` is that thread's id.") {
		t.Error("outside a thread the guide names the variable")
	}
}
