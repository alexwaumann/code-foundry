package command

import (
	"slices"
	"strings"
	"testing"
)

func TestExpandPath(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	tests := []struct {
		in, want, wantErr string
	}{
		{"/a/b", "/a/b", ""},
		{"/a/../b/", "/b", ""},
		{"~", "/Users/me", ""},
		{"~/proj", "/Users/me/proj", ""},
		{"~bob/proj", "", "~user paths are not supported"},
		{"rel/path", "", "want an absolute path"},
		{".", "", "want an absolute path"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ExpandPath(tt.in)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("got %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestParseArgsPath(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	specs := []ArgSpec{{Name: "cwd", Type: Path, Context: ContextWorktree}}
	tests := []struct {
		name    string
		raw     map[string]string
		ctx     Context
		want    string
		wantCtx string
	}{
		{"tilde expanded and overlaid", map[string]string{"cwd": "~/p"}, Context{}, "/Users/me/p", "/Users/me/p"},
		{"context default", nil, Context{ActiveWorktreePath: "/wt"}, "/wt", "/wt"},
		{"absent", nil, Context{}, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a, eff, err := parseArgs(specs, tt.raw, tt.ctx)
			if err != nil || a.Path("cwd") != tt.want || eff.ActiveWorktreePath != tt.wantCtx {
				t.Fatalf("got %q ctx %q err %v; want %q ctx %q", a.Path("cwd"), eff.ActiveWorktreePath, err, tt.want, tt.wantCtx)
			}
		})
	}
}

func TestArgsAccessorsTolerateMismatch(t *testing.T) {
	a := NewArgs(map[string]any{"n": 3, "s": "x"})
	if a.String("n") != "" || a.Int("s") != 0 || a.Bool("missing") || a.Has("missing") || !a.Has("n") {
		t.Fatal("accessors should return zero values for absent or mistyped args")
	}
}

func TestSplitWords(t *testing.T) {
	tests := []struct {
		in      string
		want    []string
		wantErr string
	}{
		{"", nil, ""},
		{"   ", nil, ""},
		{"claude", []string{"claude"}, ""},
		{"claude --model opus", []string{"claude", "--model", "opus"}, ""},
		{"  a\tb\nc  ", []string{"a", "b", "c"}, ""},
		{`echo 'hello world'`, []string{"echo", "hello world"}, ""},
		{`echo "a \"b\" \$c \n"`, []string{"echo", `a "b" $c \n`}, ""},
		{`a\ b c`, []string{"a b", "c"}, ""},
		{`x'y'"z"`, []string{"xyz"}, ""},
		{`'' ""`, []string{"", ""}, ""},
		{`'it''s'`, []string{"its"}, ""},
		{`'unterminated`, nil, "unterminated single quote"},
		{`"unterminated`, nil, "unterminated double quote"},
		{`trailing\`, nil, "trailing backslash"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := SplitWords(tt.in)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || !slices.Equal(got, tt.want) {
				t.Fatalf("SplitWords(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
			}
		})
	}
}

// Given tells a value the caller passed from a context's or a Default's.
func TestArgsGiven(t *testing.T) {
	specs := []ArgSpec{
		{Name: "model", Type: String, Default: "m-default"},
		{Name: "project", Type: String, Context: ContextProject},
		{Name: "name", Type: String},
	}
	tests := []struct {
		name  string
		raw   map[string]string
		given map[string]bool
	}{
		{"defaults only", map[string]string{}, map[string]bool{"model": false, "project": false, "name": false}},
		{"explicit", map[string]string{"model": "m", "project": "p"}, map[string]bool{"model": true, "project": true, "name": false}},
		{"blank counts as absent", map[string]string{"model": ""}, map[string]bool{"model": false}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a, _, err := parseArgs(specs, tt.raw, Context{ActiveProjectID: "ctx-project"})
			if err != nil {
				t.Fatal(err)
			}
			for name, want := range tt.given {
				if got := a.Given(name); got != want {
					t.Errorf("Given(%q) = %v, want %v (value %q)", name, got, want, a.String(name))
				}
			}
		})
	}
	if a := NewArgs(map[string]any{"model": "m"}); !a.Given("model") || a.Given("name") {
		t.Error("NewArgs: every value counts as given")
	}
}

// Each of a repeatable path's values expands on its own; a bad one fails the whole arg.
func TestParseArgsRepeatablePath(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	specs := []ArgSpec{{Name: "path", Type: Path, Repeatable: true, Positional: true}}
	tests := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{name: "one", raw: "/a/b.go", want: "/a/b.go"},
		{name: "several, each expanded and cleaned", raw: "~/x.go\n/a/./b.go", want: "/Users/me/x.go\n/a/b.go"},
		{name: "a relative one among them", raw: "/a/b.go\nrelative.go", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a, _, err := parseArgs(specs, map[string]string{"path": tt.raw}, Context{})
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, want error %t", err, tt.wantErr)
			}
			if err == nil && a.Path("path") != tt.want {
				t.Errorf("path = %q, want %q", a.Path("path"), tt.want)
			}
		})
	}
}

func TestRepeatableArgValidation(t *testing.T) {
	tests := []struct {
		name string
		spec ArgSpec
		ok   bool
	}{
		{"a string flag", ArgSpec{Name: "a", Type: String, Repeatable: true}, true},
		{"a path flag", ArgSpec{Name: "a", Type: Path, Repeatable: true}, true},
		{"a positional path", ArgSpec{Name: "a", Type: Path, Repeatable: true, Positional: true}, true},
		{"a positional string stays refused", ArgSpec{Name: "a", Type: String, Repeatable: true, Positional: true}, false},
		{"an int", ArgSpec{Name: "a", Type: Int, Repeatable: true}, false},
		{"with a context", ArgSpec{Name: "a", Type: Path, Repeatable: true, Context: ContextWorktree}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.spec.validate(); (err == nil) != tt.ok {
				t.Errorf("validate = %v, want ok %t", err, tt.ok)
			}
		})
	}
}
