package command

import (
	"errors"
	"slices"
	"testing"
)

func names(r *Registry) []string {
	var out []string
	for _, l := range r.List(Context{}, true) {
		out = append(out, l.Name)
	}
	slices.Sort(out)
	return out
}

func TestReplacePrefix(t *testing.T) {
	named := func(n string) Command { return valid(func(c *Command) { c.Name = n }) }
	tests := []struct {
		name    string
		prefix  string
		cmds    []Command
		want    []string // registry names afterwards
		wantErr error
	}{
		{"add", "plugin.hello.", []Command{named("plugin.hello.greet"), named("plugin.hello.send")},
			[]string{"plugin.hello.greet", "plugin.hello.send", "plugin.list", "plugin.other.x"}, nil},
		{"replace drops the old ones", "plugin.hello.", []Command{named("plugin.hello.greet")},
			[]string{"plugin.hello.greet", "plugin.list", "plugin.other.x"}, nil},
		{"empty removes", "plugin.hello.", nil, []string{"plugin.list", "plugin.other.x"}, nil},
		{"outside prefix", "plugin.hello.", []Command{named("plugin.other.y")}, nil, ErrInvalidCommand},
		{"invalid command", "plugin.hello.", []Command{valid(func(c *Command) { c.Name = "plugin.hello.x"; c.Title = "" })}, nil, ErrInvalidCommand},
		{"duplicate within", "plugin.hello.", []Command{named("plugin.hello.x"), named("plugin.hello.x")}, nil, ErrDuplicate},
		{"bad prefix", "plugin.hello", []Command{named("plugin.hello.x")}, nil, ErrInvalidCommand},
		{"bad prefix shape", "Plugin.", nil, nil, ErrInvalidCommand},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewRegistry()
			if err := r.RegisterAll(named("plugin.list"), named("plugin.other.x"), named("plugin.hello.old")); err != nil {
				t.Fatal(err)
			}
			before := names(r)
			err := r.ReplacePrefix(tt.prefix, tt.cmds)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if got := names(r); !slices.Equal(got, before) {
					t.Fatalf("registry changed on error: %q", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := slices.Sorted(slices.Values(tt.want))
			if got := names(r); !slices.Equal(got, want) {
				t.Fatalf("names = %q, want %q", got, want)
			}
		})
	}
}

func TestReplacePrefixKeepsCommandsInvokable(t *testing.T) {
	r := NewRegistry()
	if err := r.ReplacePrefix("plugin.hello.", []Command{valid(func(c *Command) { c.Name = "plugin.hello.greet" })}); err != nil {
		t.Fatal(err)
	}
	res, err := r.Invoke(t.Context(), Context{}, "plugin.hello.greet", nil)
	if err != nil || res.Message != "ok" {
		t.Fatalf("Invoke = %+v, %v", res, err)
	}
	if err := r.ReplacePrefix("plugin.hello.", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Invoke(t.Context(), Context{}, "plugin.hello.greet", nil); !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("after removal: %v", err)
	}
}
