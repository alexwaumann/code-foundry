package command

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestShellWords(t *testing.T) {
	tests := []struct {
		name string
		line string
		want []string // nil: not one simple command
	}{
		{"words", "code-foundry thread list", []string{"code-foundry", "thread", "list"}},
		{"spaces and tabs", "  code-foundry \t thread  list  ", []string{"code-foundry", "thread", "list"}},
		{"flag with value", "code-foundry thread send --id=s-1", []string{"code-foundry", "thread", "send", "--id=s-1"}},
		{"path and plain punctuation", "a/b.c:d,e+f@g%h_i-j", []string{"a/b.c:d,e+f@g%h_i-j"}},
		{"single quotes keep metacharacters", `a 'x; rm -rf ~ $(y) ` + "`z`" + ` | & > < * "q" \'`, []string{"a", `x; rm -rf ~ $(y) ` + "`z`" + ` | & > < * "q" \`}},
		{"single quotes keep a newline", "a 'one\ntwo'", []string{"a", "one\ntwo"}},
		{"empty single quotes are a word", "a ''", []string{"a", ""}},
		{"quotes join", `a b'c'"d"e`, []string{"a", "bcde"}},
		{"plain double quotes", `a "two words"`, []string{"a", "two words"}},
		{"empty", "", []string{}},

		{"semicolon", "a; b", nil},
		{"and", "a && b", nil},
		{"or", "a || b", nil},
		{"pipe", "a | b", nil},
		{"background", "a &", nil},
		{"redirect", "a > b", nil},
		{"append", "a >> b", nil},
		{"input", "a < b", nil},
		{"heredoc", "a <<EOF\nb\nEOF", nil},
		{"subshell", "(a)", nil},
		{"group", "{ a; }", nil},
		{"command substitution", "a $(b)", nil},
		{"backticks", "a `b`", nil},
		{"variable", "a $HOME", nil},
		{"braced variable", "a ${HOME}", nil},
		{"ansi-c quotes", "a $'b'", nil},
		{"newline", "a\nb", nil},
		{"trailing newline", "a\n", nil},
		{"carriage return", "a\rb", nil},
		{"form feed", "a\fb", nil},
		{"star", "a *", nil},
		{"question mark", "a ?", nil},
		{"bracket", "a [b]", nil},
		{"brace expansion", "a {b,c}", nil},
		{"tilde", "a ~/b", nil},
		{"comment", "a # b", nil},
		{"history", "a !b", nil},
		{"caret", "a ^b", nil},
		{"backslash", `a b\ c`, nil},
		{"backslash newline", "a \\\nb", nil},
		{"zsh equals", "a =ls", nil},
		{"non-breaking space", "a b", nil},
		{"non-ascii word", "a é", nil},
		{"nul outside quotes", "a\x00b", nil},
		{"nul in single quotes", "a 'b\x00c'", nil},
		{"unterminated single quote", "a 'b", nil},
		{"unterminated double quote", `a "b`, nil},
		{"double quoted substitution", `a "$(b)"`, nil},
		{"double quoted variable", `a "$HOME"`, nil},
		{"double quoted backticks", "a \"`b`\"", nil},
		{"double quoted backslash", `a "b\"c"`, nil},
		{"double quoted newline", "a \"b\nc\"", nil},
		{"double quoted semicolon", `a "b; c"`, nil},
		{"double quoted single quote", `a "it's"`, nil},
		{"quote then metacharacter", "a 'b';c", nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			words, ok := shellWords(tc.line)
			if tc.want == nil {
				if ok {
					t.Fatalf("%q split into %+v, want refused", tc.line, words)
				}
				return
			}
			if !ok {
				t.Fatalf("%q refused, want %q", tc.line, tc.want)
			}
			got := make([]string, len(words))
			for i, w := range words {
				got[i] = w.text
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("%q split into %q, want %q", tc.line, got, tc.want)
			}
		})
	}
}

func TestShellWordsBare(t *testing.T) {
	words, ok := shellWords(`a 'b' c"d" e`)
	if !ok || len(words) != 4 {
		t.Fatalf("words %+v, %v", words, ok)
	}
	want := []bool{true, false, false, true}
	for i, w := range words {
		if w.bare != want[i] {
			t.Errorf("word %d %+v: bare want %v", i, w, want[i])
		}
	}
}

// What shellWords returns is what bash and zsh pass: every line it accepts runs in each
// shell against a stand-in for the CLI that writes down its arguments.
func TestShellWordsMatchTheShells(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "argv")
	stub := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > '" + out + "'\n"
	if err := os.WriteFile(filepath.Join(dir, "code-foundry"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		"code-foundry thread list",
		"code-foundry a/b.c:d,e+f@g%h_i-j --x=y --z==w",
		`code-foundry 'x; rm -rf ~ $(y) | & > < * "q" \' b'c'"d"e`,
		"code-foundry 'one\ntwo' ''",
		`code-foundry "two  words" -- '-x'`,
		"code-foundry 1 2=3 a=b %1 +x @y",
	}
	for _, shell := range []string{"bash", "zsh"} {
		path, err := exec.LookPath(shell)
		if err != nil {
			t.Logf("%s is not installed", shell)
			continue
		}
		for _, line := range lines {
			words, ok := shellWords(line)
			if !ok {
				t.Fatalf("%q refused", line)
			}
			_ = os.Remove(out)
			cmd := exec.Command(path, "-c", line)
			cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin"}
			if b, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%s -c %q: %v: %s", shell, line, err, b)
			}
			b, err := os.ReadFile(out)
			if err != nil {
				t.Fatalf("%s -c %q wrote nothing: %v", shell, line, err)
			}
			got := strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
			want := make([]string, 0, len(words))
			for _, w := range words[1:] {
				want = append(want, w.text)
			}
			if !slices.Equal(got, want) {
				t.Errorf("%s passed %q for %q, shellWords says %q", shell, got, line, want)
			}
		}
	}
}

// Whatever it is given, shellWords returns: and a line it accepts has no metacharacter
// left outside single quotes.
func FuzzShellWords(f *testing.F) {
	for _, s := range []string{"code-foundry thread list", `a 'b' "c"`, "a; b", "a '", `a "`, "'", `"`, "\\", "$()", "a\x00", "\xff'\xff'"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, line string) {
		words, ok := shellWords(line)
		if !ok {
			return
		}
		rest := line
		for {
			i := strings.IndexByte(rest, '\'')
			head := rest
			if i >= 0 {
				head = rest[:i]
			}
			if strings.ContainsAny(head, "$`;|&<>\n\\(){}*?[]~#!^") {
				t.Fatalf("accepted %q (%+v): metacharacter outside single quotes", line, words)
			}
			if i < 0 {
				return
			}
			j := strings.IndexByte(rest[i+1:], '\'')
			if j < 0 {
				t.Fatalf("accepted %q: unterminated quote", line)
			}
			rest = rest[i+j+2:]
		}
	})
}
