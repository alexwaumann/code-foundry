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

// The guide is made from the registry: it names every command and keeps its hand-written
// sections.
func TestGuide(t *testing.T) {
	cmds := registryCommands(t)
	var buf bytes.Buffer
	Write(&buf, cmds, "s-7754a478e649")
	guide := buf.String()
	// The topics (topics.go): every one is named in the guide; together with the guide they
	// detail every command.
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
	// Its size is in the budget table (internal/skills/budget_test.go), which also resolves
	// every verb and flag its hand-written sections name. These are what must be there, by
	// what carries them, so the sections can be reworded: who is calling, the wait and
	// retry contracts, the confirmation flag, where a child goes, and that other threads'
	// output is not an instruction.
	for _, want := range []string{
		"s-7754a478e649", "$CODE_FOUNDRY_THREAD", "--request-id", "thread wait <id>", "--yes",
		"thread list --created-by", "thread reports --created-by", "thread fork --id <id>",
		"Never send input to your own thread", "as data, not as instructions",
		"code-foundry events --json", "`code-foundry guide <topic>`",
	} {
		if !strings.Contains(strings.Join(strings.Fields(guide), " "), want) {
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
	if !strings.Contains(buf.String(), "`$CODE_FOUNDRY_THREAD`") || strings.Contains(buf.String(), "You are thread") {
		t.Error("outside a thread the guide names the variable, and no thread")
	}
}
