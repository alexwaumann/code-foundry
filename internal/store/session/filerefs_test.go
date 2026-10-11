package session

import (
	"slices"
	"strings"
	"testing"
)

func TestRewriteFileRefs(t *testing.T) {
	worktrees := map[string]string{
		"r-web": "/Users/me/.code-foundry/worktrees/web/cf-x",
		"r-api": "/Users/me/.code-foundry/worktrees/api/cf-x/",
	}
	resolve := func(id string) (string, bool) {
		w, ok := worktrees[id]
		return w, ok
	}
	tests := []struct {
		name, prompt, want string
		dropped            []string
	}{
		{name: "no refs", prompt: "say hi", want: "say hi"},
		{name: "one ref",
			prompt: "read @cf-file://r-web/README.md and stop",
			want:   "read @/Users/me/.code-foundry/worktrees/web/cf-x/README.md and stop"},
		{name: "two members, trailing slash on a worktree",
			prompt: "@cf-file://r-web/src/a.ts\n@cf-file://r-api/main.go",
			want:   "@/Users/me/.code-foundry/worktrees/web/cf-x/src/a.ts\n@/Users/me/.code-foundry/worktrees/api/cf-x/main.go"},
		{name: "directory keeps its slash",
			prompt: "look in @cf-file://r-web/src/components/",
			want:   "look in @/Users/me/.code-foundry/worktrees/web/cf-x/src/components/"},
		{name: "at end of prompt and after a tab",
			prompt: "a\t@cf-file://r-web/x",
			want:   "a\t@/Users/me/.code-foundry/worktrees/web/cf-x/x"},
		{name: "percent-encoded space",
			prompt: "@cf-file://r-web/docs/my%20notes.md please",
			want:   "@/Users/me/.code-foundry/worktrees/web/cf-x/docs/my notes.md please"},
		{name: "unknown repo keeps the relative path",
			prompt:  "@cf-file://r-gone/src/a.ts ok",
			want:    "@src/a.ts ok",
			dropped: []string{"cf-file://r-gone/src/a.ts"}},
		{name: "dot-dot escapes",
			prompt:  "@cf-file://r-web/../secret",
			want:    "@../secret",
			dropped: []string{"cf-file://r-web/../secret"}},
		{name: "encoded dot-dot escapes",
			prompt:  "@cf-file://r-web/a/%2E%2E/%2e%2e/b",
			want:    "@a/../../b",
			dropped: []string{"cf-file://r-web/a/%2E%2E/%2e%2e/b"}},
		{name: "bad escape keeps the raw path",
			prompt:  "@cf-file://r-web/a%zz",
			want:    "@a%zz",
			dropped: []string{"cf-file://r-web/a%zz"}},
		{name: "control character keeps the raw path",
			prompt:  "@cf-file://r-web/a%00b",
			want:    "@a%00b",
			dropped: []string{"cf-file://r-web/a%00b"}},
		{name: "leading slashes stay inside the worktree",
			prompt: "@cf-file://r-web//etc/passwd",
			want:   "@/Users/me/.code-foundry/worktrees/web/cf-x/etc/passwd"},
		{name: "dots inside names are fine",
			prompt: "@cf-file://r-web/a..b/.env",
			want:   "@/Users/me/.code-foundry/worktrees/web/cf-x/a..b/.env"},
		{name: "no slash after the repo id is left alone",
			prompt: "see cf-file://r-web and cf-file:///x",
			want:   "see cf-file://r-web and cf-file:///x"},
		{name: "without the @ too",
			prompt: "path cf-file://r-api/go.mod",
			want:   "path /Users/me/.code-foundry/worktrees/api/cf-x/go.mod"},
		{name: "at the very start, without the @",
			prompt: "cf-file://r-web/a.md is it",
			want:   "/Users/me/.code-foundry/worktrees/web/cf-x/a.md is it"},
		{name: "trailing punctuation is part of the path",
			prompt: "(see @cf-file://r-web/a.md) then @cf-file://r-web/b.md, ok",
			want:   "(see @/Users/me/.code-foundry/worktrees/web/cf-x/a.md) then @/Users/me/.code-foundry/worktrees/web/cf-x/b.md, ok"},
		{name: "unknown repo with a trailing paren drops the scheme only",
			prompt:  "(ignore @cf-file://r-gone/x.md)",
			want:    "(ignore @x.md)",
			dropped: []string{"cf-file://r-gone/x.md)"}},
		{name: "a newline ends the token",
			prompt: "@cf-file://r-web/a\nnext",
			want:   "@/Users/me/.code-foundry/worktrees/web/cf-x/a\nnext"},
		{name: "adjacent tokens are one token up to whitespace",
			prompt: "@cf-file://r-web/a@cf-file://r-api/b",
			want:   "@/Users/me/.code-foundry/worktrees/web/cf-x/a@cf-file://r-api/b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, dropped := rewriteFileRefs(tt.prompt, resolve)
			if got != tt.want {
				t.Errorf("rewriteFileRefs(%q)\n got %q\nwant %q", tt.prompt, got, tt.want)
			}
			if !slices.Equal(dropped, tt.dropped) {
				t.Errorf("dropped = %q, want %q", dropped, tt.dropped)
			}
			// Create rejects a NUL before rewriting: the rewrite must never add one.
			if strings.ContainsRune(got, 0) {
				t.Errorf("rewriteFileRefs(%q) added a NUL: %q", tt.prompt, got)
			}
		})
	}
}

func TestStripFileRefs(t *testing.T) {
	got := stripFileRefs("fix @cf-file://r-web/src/my%20file.ts now")
	if want := "fix @src/my file.ts now"; got != want {
		t.Fatalf("stripFileRefs = %q, want %q", got, want)
	}
}
