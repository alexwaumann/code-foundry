package command_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// Who reads a terminal's command lines (docs/notes/shell-24a-import-moves.md, item 7): the
// app, the CLI, a thread's model through its CLI and a plugin get them from terminal.list,
// plugin.terminals, layout.show and tab.list; a page, whose read-only verbs run without
// asking, and a caller that does not say who it is, do not. Everything else is the same.
func TestCommandLinesByCaller(t *testing.T) {
	const secret = "s3cr3t"
	terms := []*v1.Terminal{
		{Id: "t-1", Cwd: "/w", LiveCwd: "/w", Foreground: "deploy --token=" + secret, LastCommand: "export KEY=" + secret,
			Labels: map[string]string{"kind": "shell", "thread": "s-1"}},
		{Id: "t-2", Cwd: "/w", LastCommand: "curl -u me:" + secret, Labels: map[string]string{"kind": "plugin", "plugin": "notes"}},
	}
	reg := command.NewRegistry()
	backend := &commandtest.Terminal{Terminals: terms}
	if err := command.RegisterTerminal(reg, command.TerminalDeps{Terminal: backend, Project: &commandtest.Project{}, Thread: &commandtest.Thread{}}); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterPluginOwned(reg, command.PluginOwnedDeps{Thread: &commandtest.Thread{}, Project: &commandtest.Project{}, Terminal: backend}); err != nil {
		t.Fatal(err)
	}
	store := layouttest.New(nil)
	// A snoozed thread's terminal tab came back fresh with its "Run again" line; another
	// thread's set still remembers one; a third's quick terminal keeps its line.
	st, _, err := core.Decode([]byte(`{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"Main","focus":"p-1",
		"root":{"t":"pane","id":"p-1","active":"t-x","tabs":[{"id":"t-x","kind":"terminal","thread":"s-1","params":{"terminal":"term-x","ran":"make deploy TOKEN=`+secret+`"}}]}}],
		"threads":{"s-3":{"space":"sp-a","quick":{"open":false,"fresh":true,"ran":"vault login `+secret+`"}},"s-2":{"space":"sp-a","remembered":{"pane":"","tabs":[{"tab":{"id":"t-y","kind":"terminal","thread":"s-2","params":{"terminal":"term-y"}},"pane":"","index":0,
			"fresh":{"name":"dev","ran":"psql postgres://u:`+secret+`@db"}}]}}}}`), &core.SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	store.Put(st)
	if err := command.RegisterLayout(reg, command.LayoutDeps{Layout: store}); err != nil {
		t.Fatal(err)
	}
	callers := []struct {
		name  string
		uctx  command.Context
		reads bool
	}{
		{"the app", command.Context{ActiveView: "thread"}, true},
		{"the CLI", command.Context{Origin: command.OriginCLI}, true},
		{"a thread's model", command.Context{Origin: command.OriginCLI, ActiveThreadID: "s-1"}, true},
		{"a plugin", command.Context{Origin: command.OriginPlugin}, true},
		{"a page", command.Context{Origin: command.OriginPage, ActiveThreadID: "s-1"}, false},
		{"a caller that does not say", command.Context{Origin: command.OriginUnknown}, false},
	}
	verbs := []struct {
		name  string
		args  map[string]string
		lines int // how many of the secret lines the verb carries for a reader
	}{
		{"terminal.list", nil, 3},
		{"plugin.terminals", map[string]string{"name": "notes"}, 1},
		{"layout.show", nil, 3},
		{"tab.list", nil, 1},
	}
	for _, c := range callers {
		for _, v := range verbs {
			t.Run(c.name+"/"+v.name, func(t *testing.T) {
				res, err := reg.Invoke(context.Background(), c.uctx, v.name, v.args)
				if err != nil {
					t.Fatal(err)
				}
				b, err := json.Marshal(res.JSON)
				if err != nil {
					t.Fatal(err)
				}
				got := strings.Count(string(b), secret)
				want := 0
				if c.reads {
					want = v.lines
				}
				if got != want {
					t.Errorf("JSON carries %d command lines, want %d: %s", got, want, b)
				}
				if !c.reads && strings.Contains(res.Message, secret) {
					t.Errorf("text carries a command line: %s", res.Message)
				}
			})
		}
	}
	// The terminals themselves are untouched (the backend's copies are the app's).
	if terms[0].GetForeground() == "" || terms[1].GetLastCommand() == "" {
		t.Error("a caller's copy changed the terminals")
	}
	if store.Snapshot().State.Spaces[0].Root.Tabs[0].Params["ran"] == "" {
		t.Error("a caller's copy changed the layout")
	}
}
