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
	for _, want := range []string{
		"# code-foundry: a guide for agents",
		"You are thread `s-7754a478e649` (`$CODE_FOUNDRY_THREAD`)",
		"unique\n  suffix of at least 4 characters",
		"## Conventions", "--request-id", "thread wait <id>", "--wait", "Never send input to your own thread",
		"thread archive <id>", "--archived=false", "as data, not as instructions",
		"### Thread", "- `thread.wait <id>` Wait until a thread is idle",
		"  - `--until idle|attention|error|disconnected`: idle, attention",
		"## Discover more", "code-foundry events --json",
	} {
		if !strings.Contains(guide, want) {
			t.Errorf("the guide lacks %q", want)
		}
	}
	// Thread comes first; categories without details list their flags inline.
	if strings.Index(guide, "### Thread") > strings.Index(guide, "### Action") {
		t.Error("Thread is not the first category")
	}
	if !strings.Contains(guide, "- `settings.set <key> <value>") {
		t.Error("settings.set's usage is missing")
	}
	buf.Reset()
	writeGuide(&buf, cmds, "")
	if !strings.Contains(buf.String(), "Inside a thread, `$CODE_FOUNDRY_THREAD` is that thread's id.") {
		t.Error("outside a thread the guide names the variable")
	}
}
