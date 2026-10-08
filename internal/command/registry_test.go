package command

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

func okRun(context.Context, Context, Args) (Result, error) { return Result{Message: "ok"}, nil }

func valid(mod func(*Command)) Command {
	c := Command{Name: "test.thing", Title: "Thing", Category: "Test", Run: okRun}
	if mod != nil {
		mod(&c)
	}
	return c
}

func TestRegisterValidation(t *testing.T) {
	tests := []struct {
		name    string
		cmd     Command
		wantErr string // substring; "" means success
	}{
		{"valid", valid(nil), ""},
		{"three segments", valid(func(c *Command) { c.Name = "repo.worktree.new" }), ""},
		{"digits after first char", valid(func(c *Command) { c.Name = "a.b2c" }), ""},
		{"single segment", valid(func(c *Command) { c.Name = "thing" }), "name must match"},
		{"uppercase", valid(func(c *Command) { c.Name = "Test.thing" }), "name must match"},
		{"hyphen", valid(func(c *Command) { c.Name = "test.new-thing" }), "name must match"},
		{"segment starts with digit", valid(func(c *Command) { c.Name = "test.2d" }), "name must match"},
		{"trailing dot", valid(func(c *Command) { c.Name = "test." }), "name must match"},
		{"empty", valid(func(c *Command) { c.Name = "" }), "name must match"},
		{"no title", valid(func(c *Command) { c.Title = "" }), "title is required"},
		{"no category", valid(func(c *Command) { c.Category = "" }), "category is required"},
		{"no run", valid(func(c *Command) { c.Run = nil }), "Run is required"},
		{"empty keybinding", valid(func(c *Command) { c.Keybindings = []string{""} }), "empty keybinding"},
		{"arg ok", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "delete-branch", Type: Bool}} }), ""},
		{"arg bad name", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "Bad_Name", Type: String}} }), "name must match"},
		{"arg reserved", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "json", Type: Bool}} }), "reserved"},
		{"arg reserved context", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "context-repo", Type: String}} }), "reserved"},
		{"arg no type", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x"}} }), "unknown type"},
		{"arg duplicate", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: String}, {Name: "x", Type: Int}} }), "declared twice"},
		{"enum without values", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: Enum}} }), "needs values"},
		{"values on non-enum", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: String, Enum: []string{"a"}}} }), "non-enum"},
		{"required with default", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: String, Required: true, Default: "a"}} }), "cannot have a default"},
		{"bad int default", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: Int, Default: "ten"}} }), "default: want an integer"},
		{"bad enum default", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: Enum, Enum: []string{"a"}, Default: "b"}} }), "default: want one of"},
		{"relative path default", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: Path, Default: "rel"}} }), "absolute"},
		{"context on bool", valid(func(c *Command) { c.Args = []ArgSpec{{Name: "x", Type: Bool, Context: ContextRepo}} }), "string or path"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := NewRegistry().Register(tt.cmd)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				return
			}
			if !errors.Is(err, ErrInvalidCommand) || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want ErrInvalidCommand containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestRegisterDuplicate(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(valid(nil)); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(valid(nil)); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("err = %v, want ErrDuplicate", err)
	}
	err := r.RegisterAll(valid(func(c *Command) { c.Name = "test.other" }), valid(nil), valid(func(c *Command) { c.Title = "" }))
	if !errors.Is(err, ErrDuplicate) || !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("RegisterAll err = %v, want both errors joined", err)
	}
	if _, ok := r.Get("test.other"); !ok {
		t.Fatal("valid command in a failing RegisterAll was not registered")
	}
}

func TestListOrderAndAvailability(t *testing.T) {
	r := NewRegistry()
	needsTerminal := func(c Context) bool { return c.ActiveTerminalID != "" }
	err := r.RegisterAll(
		valid(func(c *Command) { c.Name, c.Category, c.Title = "b.two", "B", "Zeta" }),
		valid(func(c *Command) { c.Name, c.Category, c.Title = "b.one", "B", "Alpha" }),
		valid(func(c *Command) { c.Name, c.Category, c.Title, c.When = "a.kill", "A", "Kill", needsTerminal }),
		valid(func(c *Command) { c.Name, c.Category, c.Title = "a.same", "A", "Same" }),
		valid(func(c *Command) { c.Name, c.Category, c.Title = "a.alsosame", "A", "Same" }),
	)
	if err != nil {
		t.Fatal(err)
	}
	names := func(ls []Listed) (out []string) {
		for _, l := range ls {
			n := l.Name
			if !l.Available {
				n += "(off)"
			}
			out = append(out, n)
		}
		return out
	}
	tests := []struct {
		name string
		ctx  Context
		all  bool
		want []string
	}{
		{"available only, no context", Context{}, false, []string{"a.alsosame", "a.same", "b.one", "b.two"}},
		{"include unavailable", Context{}, true, []string{"a.kill(off)", "a.alsosame", "a.same", "b.one", "b.two"}},
		{"terminal context", Context{ActiveTerminalID: "t1"}, false, []string{"a.kill", "a.alsosame", "a.same", "b.one", "b.two"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := names(r.List(tt.ctx, tt.all)); !slices.Equal(got, tt.want) {
				t.Fatalf("List = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestInvoke(t *testing.T) {
	type seen struct {
		ctx  Context
		args Args
	}
	var got seen
	r := NewRegistry()
	err := r.Register(Command{
		Name: "terminal.kill", Title: "Kill", Category: "Terminal",
		Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Context: ContextTerminal},
			{Name: "signal", Type: Enum, Enum: []string{"hup", "kill"}, Default: "hup"},
			{Name: "grace", Type: Int},
			{Name: "force", Type: Bool},
		},
		When: func(c Context) bool { return c.ActiveTerminalID != "" },
		Run: func(_ context.Context, c Context, a Args) (Result, error) {
			got = seen{c, a}
			return Result{Message: "killed " + a.String("id")}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		cmd     string
		ctx     Context
		args    map[string]string
		wantErr error
		wantMsg string // error substring or result message
		check   func(t *testing.T, s seen)
	}{
		{name: "unknown", cmd: "terminal.nope", wantErr: ErrUnknownCommand, wantMsg: `unknown command "terminal.nope"`},
		{name: "unavailable", cmd: "terminal.kill", wantErr: ErrUnavailable, wantMsg: "terminal.kill: not available in this context"},
		{name: "context supplies id", cmd: "terminal.kill", ctx: Context{ActiveTerminalID: "t1"}, wantMsg: "killed t1",
			check: func(t *testing.T, s seen) {
				if s.args.String("signal") != "hup" || s.args.Has("grace") || s.args.Bool("force") {
					t.Errorf("defaults: signal=%q has(grace)=%v force=%v", s.args.String("signal"), s.args.Has("grace"), s.args.Bool("force"))
				}
			}},
		{name: "explicit id stands in for context", cmd: "terminal.kill", args: map[string]string{"id": "t2"}, wantMsg: "killed t2",
			check: func(t *testing.T, s seen) {
				if s.ctx.ActiveTerminalID != "t2" {
					t.Errorf("Run ctx terminal = %q, want t2", s.ctx.ActiveTerminalID)
				}
			}},
		{name: "explicit id beats context", cmd: "terminal.kill", ctx: Context{ActiveTerminalID: "t1"}, args: map[string]string{"id": "t2"}, wantMsg: "killed t2"},
		{name: "typed args", cmd: "terminal.kill", args: map[string]string{"id": "t", "signal": "kill", "grace": "5", "force": "true"}, wantMsg: "killed t",
			check: func(t *testing.T, s seen) {
				if s.args.String("signal") != "kill" || s.args.Int("grace") != 5 || !s.args.Bool("force") {
					t.Errorf("args = %+v", s.args)
				}
			}},
		{name: "empty string is absent", cmd: "terminal.kill", ctx: Context{ActiveTerminalID: "t1"}, args: map[string]string{"id": "", "grace": ""}, wantMsg: "killed t1"},
		{name: "unknown arg", cmd: "terminal.kill", args: map[string]string{"id": "t", "bogus": "1"}, wantErr: ErrInvalidArgs, wantMsg: `unknown argument "bogus"`},
		{name: "bad int", cmd: "terminal.kill", args: map[string]string{"id": "t", "grace": "soon"}, wantErr: ErrInvalidArgs, wantMsg: `argument "grace": want an integer, got "soon"`},
		{name: "bad bool", cmd: "terminal.kill", args: map[string]string{"id": "t", "force": "yes"}, wantErr: ErrInvalidArgs, wantMsg: "want true or false"},
		{name: "bad enum", cmd: "terminal.kill", args: map[string]string{"id": "t", "signal": "term"}, wantErr: ErrInvalidArgs, wantMsg: "want one of hup, kill"},
		// Arg syntax is checked before availability, so a typo is reported as such.
		{name: "bad arg before availability", cmd: "terminal.kill", args: map[string]string{"grace": "x"}, wantErr: ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got = seen{}
			res, err := r.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil {
				if !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %q, want containing %q", err, tt.wantMsg)
				}
				return
			}
			if res.Message != tt.wantMsg {
				t.Fatalf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if tt.check != nil {
				tt.check(t, got)
			}
		})
	}
}

func TestInvokeRequiredWithoutContext(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(valid(func(c *Command) {
		c.Args = []ArgSpec{{Name: "path", Type: Path, Required: true}}
	})); err != nil {
		t.Fatal(err)
	}
	_, err := r.Invoke(context.Background(), Context{}, "test.thing", nil)
	var ae *ArgError
	if !errors.As(err, &ae) || ae.Arg != "path" || err.Error() != `test.thing: missing required argument "path"` {
		t.Fatalf("err = %v, want missing required path", err)
	}
}
