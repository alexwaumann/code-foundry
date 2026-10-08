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
