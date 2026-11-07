package command_test

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"strconv"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// The callers, as the daemon sees them after internal/api.
var (
	fromPage      = command.Context{ActiveThreadID: "s-1", Origin: command.OriginPage}
	fromUnknown   = command.Context{ActiveThreadID: "s-1", Origin: command.OriginUnknown}
	fromFuture    = command.Context{ActiveThreadID: "s-1", Origin: v1.CallOrigin(99)}
	fromPlugin    = command.Context{ActiveThreadID: "s-1", Origin: command.OriginPlugin}
	fromGUI       = command.Context{ActiveThreadID: "s-1", ActiveView: "thread"}
	fromThreadCLI = command.Context{ActiveThreadID: "s-1", Origin: command.OriginCLI}
	fromPlainCLI  = command.Context{Origin: command.OriginCLI}
)

// classRegistry has one command of each class, and counts what ran.
func classRegistry(t *testing.T) (*command.Registry, *[]string) {
	t.Helper()
	var ran []string
	run := func(name string) func(context.Context, command.Context, command.Args) (command.Result, error) {
		return func(context.Context, command.Context, command.Args) (command.Result, error) {
			ran = append(ran, name)
			return command.Result{}, nil
		}
	}
	reg := command.NewRegistry()
	err := reg.RegisterAll(
		command.Command{Name: "x.unclassified", Title: "Unclassified", Category: "X", Run: run("x.unclassified")},
		command.Command{Name: "x.runs", Title: "Runs", Category: "X", Page: command.PageRuns, Run: run("x.runs")},
		command.Command{Name: "x.drives", Title: "Drives", Category: "X", Page: command.PageDrives, Run: run("x.drives")},
		command.Command{Name: "x.state", Title: "State", Category: "X", Page: command.PageState, Run: run("x.state")},
		command.Command{Name: "x.read", Title: "Read", Category: "X", ReadOnly: true, Run: run("x.read")},
		command.Command{Name: "x.flag", Title: "Flag", Category: "X", Page: command.PageState, Run: run("x.flag"), Args: []command.ArgSpec{
			{Name: "line", Type: command.String, PageAsks: true},
			{Name: "force", Type: command.Bool, PageAsks: true},
			{Name: "cwd", Type: command.String},
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	return reg, &ran
}

// Who is asked, for each class and caller; a confirmed call always runs.
func TestPageGate(t *testing.T) {
	callers := []struct {
		name  string
		ctx   command.Context
		asked bool
	}{
		{"page", fromPage, true},
		{"unknown caller", fromUnknown, true},
		{"origin this daemon does not know", fromFuture, true},
		{"plugin", fromPlugin, false},
		{"GUI", fromGUI, false},
		{"thread CLI", fromThreadCLI, false},
		{"plain CLI", fromPlainCLI, false},
	}
	calls := []struct {
		name  string
		verb  string
		args  map[string]string
		gated bool
	}{
		{"class A", "x.runs", nil, true},
		{"a new command", "x.unclassified", nil, true},
		{"class C with a flag that runs", "x.flag", map[string]string{"line": "ls"}, true},
		{"class C with a bool flag that runs", "x.flag", map[string]string{"force": "true"}, true},
		{"class C without that flag", "x.flag", map[string]string{"cwd": "/w"}, false},
		{"class C with the bool flag off", "x.flag", map[string]string{"force": "false"}, false},
		{"class B", "x.drives", nil, false},
		{"class C", "x.state", nil, false},
		{"class D", "x.read", nil, false},
	}
	for _, c := range callers {
		for _, k := range calls {
			t.Run(c.name+"/"+k.name, func(t *testing.T) {
				reg, ran := classRegistry(t)
				_, err := reg.Invoke(context.Background(), c.ctx, k.verb, k.args)
				var ce *command.ConfirmError
				asked := errors.As(err, &ce)
				if want := c.asked && k.gated; asked != want {
					t.Fatalf("asked = %v, want %v (err %v)", asked, want, err)
				}
				if !asked && err != nil {
					t.Fatal(err)
				}
				if ranIt := len(*ran) == 1; ranIt == asked {
					t.Errorf("ran %v with asked = %v", *ran, asked)
				}
				if _, err := reg.Invoke(context.Background(), c.ctx, k.verb, k.args, command.Confirmed(true)); err != nil {
					t.Fatalf("confirmed: %v", err)
				}
				if last := (*ran)[len(*ran)-1]; last != k.verb {
					t.Errorf("confirmed ran %q", last)
				}
			})
		}
	}
}

// The verbs themselves, with real args, so a change to a verb's class or flags shows here.
func TestPageCallsToRealVerbs(t *testing.T) {
	tests := []struct {
		name string
		verb string
		args map[string]string
		want string // the question; "" runs on
	}{
		{"terminal with a program", "terminal.new", map[string]string{"argv": "touch /tmp/x"}, `terminal.new --argv "touch /tmp/x"`},
		{"terminal with a typed line", "terminal.new", map[string]string{"run": "ls\nrm x"}, `terminal.new --run "ls\nrm x"`},
		{"a plain shell", "terminal.new", map[string]string{"cwd": "/w"}, ""},
		{"a worktree", "project.worktree.new", map[string]string{"project": "r", "branch": "b"}, `project.worktree.new --project "r" --branch "b"`},
		{"a folder to add", "project.add", map[string]string{"path": "/w/repo"}, `project.add --path "/w/repo"`},
		{"the Add Project dialog", "project.add", nil, ""},
		{"a folder of repositories", "project.add-workspace", map[string]string{"folder": "/w"}, `project.add-workspace --folder "/w"`},
		{"a fetch", "git.fetch", map[string]string{"worktree": "/w"}, `git.fetch --worktree "/w"`},
		{"ready for review", "pr.ready", map[string]string{"repo-slug": "o/r", "number": "1"}, ""},
		{"back to a draft", "pr.draft", map[string]string{"repo-slug": "o/r", "number": "1"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			_, err := f.reg.Invoke(context.Background(), fromPage, tt.verb, tt.args)
			var ce *command.ConfirmError
			if tt.want == "" {
				if errors.As(err, &ce) {
					t.Fatalf("asked %q", ce.Message)
				}
				return
			}
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want a question", err)
			}
			if !strings.Contains(ce.Message, tt.want) {
				t.Errorf("message = %q, want it to show %s", ce.Message, tt.want)
			}
			if ce.Label != "Allow" || ce.Command != tt.verb {
				t.Errorf("label %q, command %q", ce.Label, ce.Command)
			}
		})
	}
}

// A plugin's commands are registered at run time and were classified by nobody.
func TestPageAsksBeforeAPluginCommand(t *testing.T) {
	reg := command.NewRegistry()
	ran := false
	err := reg.ReplacePrefix("plugin.hello.", []command.Command{{Name: "plugin.hello.go", Title: "Go", Category: "Hello",
		Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
			ran = true
			return command.Result{}, nil
		}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), fromPage, "plugin.hello.go", nil); !errors.Is(err, command.ErrNeedsConfirmation) || ran {
		t.Fatalf("err = %v, ran = %v", err, ran)
	}
}

// What the user reads is what runs: a value cannot draw a line of its own or hide behind a
// control character, and a call too long to read is refused, not cut.
func TestPageQuestionShowsTheCall(t *testing.T) {
	reg, ran := classRegistry(t)
	tests := []struct {
		name    string
		line    string
		want    string
		refused bool
	}{
		{"a newline stays one line", "ls\nAsked by the user", `--line "ls\nAsked by the user"`, false},
		{"a text direction mark shows", "a\u202eb", `--line "a\u202eb"`, false},
		{"a zero width space shows", "a\u200bb", `--line "a\u200bb"`, false},
		{"too long to read", strings.Repeat("x", 801), "too long to show the user", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := reg.Invoke(context.Background(), fromPage, "x.flag", map[string]string{"line": tt.line})
			if err == nil {
				t.Fatal("ran unasked")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %q, want %s", err, tt.want)
			}
			if asked := errors.Is(err, command.ErrNeedsConfirmation); asked == tt.refused {
				t.Errorf("asked = %v, refused = %v", asked, tt.refused)
			}
			if strings.Count(err.Error(), "\n") > 1 && !tt.refused {
				t.Errorf("the value drew a line: %q", err)
			}
		})
	}
	if len(*ran) != 0 {
		t.Errorf("ran %v", *ran)
	}
}

// A false the page passed is part of the call, as a true is.
func TestPageQuestionShowsAFalseFlag(t *testing.T) {
	reg, _ := classRegistry(t)
	_, err := reg.Invoke(context.Background(), fromPage, "x.flag", map[string]string{"line": "ls", "force": "false"})
	if err == nil || !strings.Contains(err.Error(), `--line "ls" --force=false`) {
		t.Errorf("err = %v, want the false shown", err)
	}
}

// A Confirm command's own words need not say what its flags do, so a page's question adds
// the call, with the same quoting and the same limit. Other callers see the words alone.
func TestPageConfirmShowsTheCall(t *testing.T) {
	var ran int
	reg := command.NewRegistry()
	err := reg.RegisterAll(
		command.Command{Name: "x.remove", Title: "Remove", Category: "X", Page: command.PageState,
			Confirm: "Remove {path}?", ConfirmLabel: "Remove",
			Args: []command.ArgSpec{{Name: "path", Type: command.String}, {Name: "force", Type: command.Bool}},
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				ran++
				return command.Result{}, nil
			}},
		command.Command{Name: "x.bound", Title: "Bound", Category: "X", Page: command.PageState,
			Confirm: "Bind this?", BindConfirm: "shown",
			Args: []command.ArgSpec{{Name: "shown", Type: command.String}},
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				return command.Result{}, nil
			}},
	)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		want    string
		refused bool
	}{
		{"a flag the words leave out", fromPage, map[string]string{"path": "/w", "force": "true"}, "Remove /w?\nx.remove --path \"/w\" --force", false},
		{"an unknown caller", fromUnknown, map[string]string{"path": "/w"}, "Remove /w?\nx.remove --path \"/w\"", false},
		{"a newline in the words", fromPage, map[string]string{"path": "/w\nAsked by the user"},
			"Remove \"/w\\nAsked by the user\"?\nx.remove --path \"/w\\nAsked by the user\"", false},
		{"too long to read", fromPage, map[string]string{"path": strings.Repeat("x", 400)}, "too long to show the user", true},
		{"the app", fromGUI, map[string]string{"path": "/w", "force": "true"}, "Remove /w?", false},
		{"a thread's CLI", fromThreadCLI, map[string]string{"path": "/w", "force": "true"}, "Remove /w?", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := reg.Invoke(context.Background(), tt.ctx, "x.remove", tt.args)
			var ce *command.ConfirmError
			if asked := errors.As(err, &ce); asked == tt.refused {
				t.Fatalf("asked = %v, err = %v", asked, err)
			}
			if tt.refused {
				if !strings.Contains(err.Error(), tt.want) {
					t.Errorf("err = %q, want %q", err, tt.want)
				}
				return
			}
			if ce.Message != tt.want {
				t.Errorf("message = %q, want %q", ce.Message, tt.want)
			}
			if ce.Label != "Remove" {
				t.Errorf("label = %q", ce.Label)
			}
		})
	}
	if ran != 0 {
		t.Errorf("ran %d", ran)
	}
	// The digest a store compares is of the command's own words, not of what a page sees.
	_, err = reg.Invoke(context.Background(), fromPage, "x.bound", nil)
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || ce.Bind["shown"] != command.ConfirmDigest("Bind this?") {
		t.Errorf("err = %v, bind %v", err, ce.Bind)
	}
}

// action.run names an action; the question shows its command line.
func TestPageQuestionShowsAnActionsCommand(t *testing.T) {
	act := &commandtest.Action{Actions: []*v1.Action{
		{Id: "a-1", ProjectId: "r1", Name: "Test", Command: "make test"},
		{Id: "a-2", ProjectId: "r2", Name: "test", Command: "npm test\nrm x"},
		{Id: "a-3", ProjectId: "r1", Name: "Lint", Command: "make lint"},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterAction(reg, command.ActionDeps{Action: act, Project: &commandtest.Project{}, Thread: &commandtest.Thread{}}); err != nil {
		t.Fatal(err)
	}
	_, err := reg.Invoke(context.Background(), fromPage, "action.run", map[string]string{"action": "test"})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v", err)
	}
	for _, want := range []string{`Its command line: "make test"`, `Its command line: "npm test\nrm x"`} {
		if !strings.Contains(ce.Message, want) {
			t.Errorf("message = %q, want %s", ce.Message, want)
		}
	}
	if strings.Contains(ce.Message, "make lint") {
		t.Errorf("another action in the message: %q", ce.Message)
	}
	_, err = reg.Invoke(context.Background(), fromPage, "action.run", map[string]string{"action": "nope"})
	if !command.IsFailed(err) || errors.Is(err, command.ErrNeedsConfirmation) {
		t.Errorf("an unknown action: err = %v", err)
	}
	for _, m := range act.Requests() {
		if _, ran := m.(*v1.RunActionRequest); ran {
			t.Errorf("ran %v", m)
		}
	}
}

// acted counts the events the plugin heard.
func acted(b *commandtest.PluginSurface) int {
	n := 0
	for _, m := range b.Requests() {
		if _, ok := m.(*v1.SurfaceActRequest); ok {
			n++
		}
	}
	return n
}

// An event of a plugin's view runs the plugin's code: a page asks, and a yes reaches it.
func TestPluginActEventFromAPage(t *testing.T) {
	b := &commandtest.PluginSurface{Got: &v1.GetSurfaceResponse{
		State: &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:  &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[]}`},
		Elements: []*v1.SurfaceElement{
			{Key: "deploy", Kind: "event", Action: "deploy", Label: "Deploy"},
		},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterPluginSurface(reg, b); err != nil {
		t.Fatal(err)
	}
	args := map[string]string{"name": "hello", "surface": "demo", "key": "deploy", "quiet": "true"}
	tests := []struct {
		name  string
		ctx   command.Context
		opts  []command.InvokeOption
		asked bool
	}{
		{"page", fromPage, nil, true},
		{"unknown caller", fromUnknown, nil, true},
		{"GUI", fromGUI, nil, false},
		{"thread CLI", fromThreadCLI, nil, false},
		{"plugin", fromPlugin, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := acted(b)
			_, err := reg.Invoke(context.Background(), tt.ctx, "plugin.act", args, tt.opts...)
			var ce *command.ConfirmError
			if asked := errors.As(err, &ce); asked != tt.asked {
				t.Fatalf("asked = %v, err = %v", asked, err)
			}
			if tt.asked {
				if !strings.Contains(ce.Message, `"deploy"`) || !strings.Contains(ce.Message, `"hello"`) {
					t.Errorf("message = %q", ce.Message)
				}
				if ce.Bind["version"] != "4" {
					t.Errorf("Bind = %v, want the yes pinned to view 4", ce.Bind)
				}
				if acted(b) != before {
					t.Error("the plugin heard it unasked")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if acted(b) != before+1 {
				t.Error("the plugin did not hear it")
			}
		})
	}
	t.Run("page, confirmed", func(t *testing.T) {
		before := acted(b)
		if _, err := reg.Invoke(context.Background(), fromPage, "plugin.act", yes(t, reg, fromPage, args), command.Confirmed(true)); err != nil {
			t.Fatal(err)
		}
		if acted(b) != before+1 {
			t.Error("the plugin did not hear it")
		}
	})
}

// yes is what the host re-invokes with once the user agrees: args and the question's Bind.
func yes(t *testing.T, reg *command.Registry, ctx command.Context, args map[string]string) map[string]string {
	t.Helper()
	_, err := reg.Invoke(context.Background(), ctx, "plugin.act", args)
	var ce *command.ConfirmError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want a question", err)
	}
	out := maps.Clone(args)
	maps.Copy(out, ce.Bind)
	return out
}

// A page's yes covers the one thing it was asked about: when the re-invoke would do anything
// else, nothing runs, neither the plugin's event nor a button's command.
func TestPluginActYesCoversWhatWasAsked(t *testing.T) {
	version := func(n int) map[string]string {
		return map[string]string{"name": "hello", "surface": "demo", "key": "go", "quiet": "true", "version": strconv.Itoa(n)}
	}
	current := map[string]string{"name": "hello", "surface": "demo", "key": "go", "quiet": "true"}
	tests := []struct {
		name   string
		args   map[string]string
		change func(*v1.GetSurfaceResponse, map[string]string)
		kind   string
		ran    int
		heard  int
	}{
		{name: "the question it was asked runs", args: current, ran: 1},
		{name: "a stale version asks about an event, the yes finds a command", args: version(2)},
		{name: "the button's command changes", args: current, change: func(g *v1.GetSurfaceResponse, _ map[string]string) {
			g.Elements[0].Action = "x.drives"
		}},
		{name: "the button's args change", args: current, change: func(g *v1.GetSurfaceResponse, _ map[string]string) {
			g.Elements[0].Args = map[string]string{"line": "other"}
		}},
		{name: "the view moves on", args: current, change: func(g *v1.GetSurfaceResponse, _ map[string]string) { g.View.Version = 5 }},
		{name: "the event it was asked is heard", args: current, kind: "event", heard: 1},
		{name: "the event's value changes", args: current, kind: "event", change: func(_ *v1.GetSurfaceResponse, a map[string]string) { a["value"] = "other" }},
		{name: "no record of the question", args: current, change: func(_ *v1.GetSurfaceResponse, a map[string]string) { delete(a, "asked") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := &commandtest.PluginSurface{Got: &v1.GetSurfaceResponse{
				State:    &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
				View:     &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[]}`},
				Elements: []*v1.SurfaceElement{{Key: "go", Kind: cmp.Or(tt.kind, "command"), Action: "x.runs", Label: "Go"}},
			}}
			reg, ran := classRegistry(t)
			if err := command.RegisterPluginSurface(reg, b); err != nil {
				t.Fatal(err)
			}
			again := yes(t, reg, fromPage, tt.args)
			if tt.change != nil {
				tt.change(b.Got, again)
			}
			_, err := reg.Invoke(context.Background(), fromPage, "plugin.act", again, command.Confirmed(true))
			if tt.ran+tt.heard == 0 && (err == nil || !strings.Contains(err.Error(), "nothing ran")) {
				t.Errorf("err = %v, want a refusal", err)
			}
			if len(*ran) != tt.ran || acted(b) != tt.heard {
				t.Errorf("ran %v, the plugin heard %d", *ran, acted(b))
			}
		})
	}
}

// A page pressing a plugin's button gets the question of the verb behind it, and the yes to
// plugin.act is the yes to that verb.
func TestPluginButtonFromAPageAsksForItsCommand(t *testing.T) {
	b := &commandtest.PluginSurface{Got: &v1.GetSurfaceResponse{
		State:    &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:     &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[]}`},
		Elements: []*v1.SurfaceElement{{Key: "go", Kind: "command", Action: "x.runs", Label: "Go"}},
	}}
	reg, ran := classRegistry(t)
	if err := command.RegisterPluginSurface(reg, b); err != nil {
		t.Fatal(err)
	}
	args := map[string]string{"name": "hello", "surface": "demo", "key": "go", "quiet": "true"}
	_, err := reg.Invoke(context.Background(), fromPage, "plugin.act", args)
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || !strings.Contains(ce.Message, "x.runs") || ce.Bind["version"] != "4" || len(*ran) != 0 {
		t.Fatalf("err = %v, bind %v, ran %v", err, ce.Bind, *ran)
	}
	if _, err := reg.Invoke(context.Background(), fromPage, "plugin.act", yes(t, reg, fromPage, args), command.Confirmed(true)); err != nil {
		t.Fatal(err)
	}
	if len(*ran) != 1 {
		t.Errorf("ran %v", *ran)
	}
}

// The CLI saying it is one does not make a plugin's button the user's: it still runs as the
// plugin's, which a user-only setting refuses.
func TestPluginButtonFromTheCLIStaysThePlugins(t *testing.T) {
	b := &commandtest.PluginSurface{Got: &v1.GetSurfaceResponse{
		State:    &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:     &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[]}`},
		Elements: []*v1.SurfaceElement{{Key: "go", Kind: "command", Action: "plugin.hello.go", Label: "Go"}},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterPluginSurface(reg, b); err != nil {
		t.Fatal(err)
	}
	var got v1.CallOrigin
	if err := reg.Register(command.Command{Name: "plugin.hello.go", Title: "Go", Category: "Hello",
		Run: func(_ context.Context, uctx command.Context, _ command.Args) (command.Result, error) {
			got = uctx.Origin
			return command.Result{}, nil
		}}); err != nil {
		t.Fatal(err)
	}
	args := map[string]string{"name": "hello", "surface": "demo", "key": "go", "quiet": "true"}
	if _, err := reg.Invoke(context.Background(), fromPlainCLI, "plugin.act", args); err != nil {
		t.Fatal(err)
	}
	if got != command.OriginPlugin {
		t.Errorf("Origin = %v, want the plugin's", got)
	}
}

func TestFromUser(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{"GUI", command.Context{ActiveView: "thread", CallerThreadID: "s-1"}, true},
		{"plain CLI", command.Context{Origin: command.OriginCLI}, true},
		{"thread CLI", command.Context{Origin: command.OriginCLI, CallerThreadID: "s-1"}, false},
		{"page", command.Context{Origin: command.OriginPage}, false},
		{"plugin", command.Context{Origin: command.OriginPlugin}, false},
		{"unknown caller", command.Context{Origin: command.OriginUnknown}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.ctx.FromUser(); got != tt.want {
				t.Errorf("FromUser = %v, want %v", got, tt.want)
			}
		})
	}
}
