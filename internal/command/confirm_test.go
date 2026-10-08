package command

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestConfirmValidation(t *testing.T) {
	tests := []struct {
		name    string
		confirm string
		wantErr string
	}{
		{"no placeholders", "Really?", ""},
		{"known arg", "Remove {path}?", ""},
		{"kebab arg", "Delete {delete-branch}?", ""},
		{"unknown arg", "Remove {where}?", `confirm template names unknown arg "where"`},
		{"braces that are not placeholders", "Remove {Path} {}?", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewRegistry()
			err := r.Register(valid(func(c *Command) {
				c.Args = []ArgSpec{{Name: "path", Type: Path}, {Name: "delete-branch", Type: Bool}}
				c.Confirm = tt.confirm
			}))
			if tt.wantErr == "" && err != nil {
				t.Fatalf("err = %v", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestInvokeConfirm(t *testing.T) {
	ran := 0
	r := NewRegistry()
	if err := r.Register(Command{
		Name: "repo.worktree.remove", Title: "Remove Worktree", Category: "Repository",
		Args: []ArgSpec{
			{Name: "path", Type: Path, Required: true, Context: ContextWorktree},
			{Name: "force", Type: Bool},
			{Name: "note", Type: String},
		},
		Confirm: "Remove {path} (force={force}, note={note})?",
		Run: func(context.Context, Context, Args) (Result, error) {
			ran++
			return Result{Message: "removed"}, nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		ctx     Context
		args    map[string]string
		opts    []InvokeOption
		wantMsg string // confirm message; "" means it ran
		wantErr error
	}{
		{name: "unconfirmed renders args and context defaults", ctx: Context{ActiveWorktreePath: "/wt/a"},
			wantMsg: "Remove /wt/a (force=false, note=(none))?"},
		{name: "explicit args", args: map[string]string{"path": "/wt/b", "force": "true", "note": "bye"},
			wantMsg: "Remove /wt/b (force=true, note=bye)?"},
		{name: "confirmed(false) is unconfirmed", args: map[string]string{"path": "/wt/b"}, opts: []InvokeOption{Confirmed(false)},
			wantMsg: "Remove /wt/b (force=false, note=(none))?"},
		{name: "confirmed runs", args: map[string]string{"path": "/wt/b"}, opts: []InvokeOption{Confirmed(true)}},
		// Missing args are reported before asking, so the user is never asked twice.
		{name: "missing required before confirm", wantErr: ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := ran
			_, err := r.Invoke(context.Background(), tt.ctx, "repo.worktree.remove", tt.args, tt.opts...)
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case tt.wantMsg != "":
				var ce *ConfirmError
				if !errors.As(err, &ce) || !errors.Is(err, ErrNeedsConfirmation) {
					t.Fatalf("err = %v, want *ConfirmError", err)
				}
				if ce.Message != tt.wantMsg || ce.Command != "repo.worktree.remove" || ce.Title != "Remove Worktree" {
					t.Fatalf("confirm = %+v, want message %q", ce, tt.wantMsg)
				}
				if ran != before {
					t.Fatal("Run was called without confirmation")
				}
			default:
				if err != nil || ran != before+1 {
					t.Fatalf("err = %v, ran %d times", err, ran-before)
				}
			}
		})
	}
}

func TestOverrides(t *testing.T) {
	r := NewRegistry()
	if err := r.RegisterAll(
		valid(func(c *Command) {
			c.Name, c.Keybindings = "session.new", []string{"cmd+n"}
			c.Args = []ArgSpec{
				{Name: "model", Type: Enum, Enum: []string{"opus", "sonnet"}},
				{Name: "name", Type: String, Required: true},
			}
			c.Run = func(_ context.Context, _ Context, a Args) (Result, error) {
				return Result{Message: "model=" + a.String("model")}, nil
			}
		}),
		valid(func(c *Command) { c.Name, c.Keybindings = "terminal.new", []string{"cmd+t"} }),
	); err != nil {
		t.Fatal(err)
	}
	r.SetOverrides(Overrides{
		Keybindings: map[string][]string{"session.new": {"cmd+shift+n"}, "terminal.new": {}},
		ArgDefaults: map[string]map[string]string{"session.new": {"model": "sonnet", "name": "ignored-required"}},
	})
	listed := map[string]Command{}
	for _, l := range r.List(Context{}, true) {
		listed[l.Name] = l.Command
	}
	if kb := listed["session.new"].Keybindings; !slices.Equal(kb, []string{"cmd+shift+n"}) {
		t.Errorf("session.new keybindings = %v", kb)
	}
	if kb := listed["terminal.new"].Keybindings; len(kb) != 0 {
		t.Errorf("terminal.new keybindings = %v, want unbound", kb)
	}
	if d := listed["session.new"].Args[0].Default; d != "sonnet" {
		t.Errorf("model default = %q", d)
	}
	if d := listed["session.new"].Args[1].Default; d != "" {
		t.Errorf("required arg got default %q", d)
	}
	res, err := r.Invoke(context.Background(), Context{}, "session.new", map[string]string{"name": "x"})
	if err != nil || res.Message != "model=sonnet" {
		t.Fatalf("invoke = %q, %v", res.Message, err)
	}
	// An override that does not parse for the arg is ignored.
	r.SetOverrides(Overrides{ArgDefaults: map[string]map[string]string{"session.new": {"model": "gpt"}}})
	res, err = r.Invoke(context.Background(), Context{}, "session.new", map[string]string{"name": "x"})
	if err != nil || res.Message != "model=" {
		t.Fatalf("invoke with bad override = %q, %v", res.Message, err)
	}
	// The registered command is unchanged.
	if c, _ := r.Get("terminal.new"); !slices.Equal(c.Keybindings, []string{"cmd+t"}) {
		t.Errorf("terminal.new after reset = %v", c.Keybindings)
	}
}
