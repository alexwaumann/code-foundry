package thread

import "testing"

func TestPromptText(t *testing.T) {
	names := func(id string) (string, bool) {
		switch id {
		case "s-known":
			return "Fix resize race", true
		case "s-unnamed":
			return "", true
		}
		return "", false
	}
	cite := "[Assistant quote](cf-cite://v1/s-1/m1%2F0?text=the%20resize%20handler&start=0&end=18&prefix=&suffix=&comment=why%3F)"
	tests := []struct {
		name, text, composer string
		want, wantRestore    string
	}{
		{name: "plain typed text", text: "  fix the tests  ", want: "fix the tests"},
		{name: "multi-line text keeps its lines", text: "one\ntwo", want: "one\ntwo"},
		{name: "attachment-only composer text is empty", text: "[Image: a.png; ref=/x/a.png]", composer: "![a.png](cf-attachment://0)",
			want: "", wantRestore: ""},
		{name: "an image chip goes with one space", text: "x", composer: "look ![a.png](cf-attachment://0) here",
			want: "look here", wantRestore: "look here"},
		{name: "a trailing chip takes the space before it", text: "x", composer: "look ![a.pdf](cf-attachment://1)",
			want: "look", wantRestore: "look"},
		{name: "file tag as its decoded path", text: "x", composer: "see [my file.ts](cf-file://r-1/src/my%20file.ts) now",
			want: "see src/my file.ts now", wantRestore: "see [my file.ts](cf-file://r-1/src/my%20file.ts) now"},
		{name: "directory tag keeps its slash", text: "x", composer: "[src/](cf-file://r-1/src/)", want: "src/",
			wantRestore: "[src/](cf-file://r-1/src/)"},
		{name: "thread tag as its current name", text: "x", composer: "like [Old name](cf-thread://s-known)",
			want: "like Fix resize race", wantRestore: "like [Old name](cf-thread://s-known)"},
		{name: "unknown thread keeps its label", text: "x", composer: "like [Gone](cf-thread://s-gone)", want: "like Gone",
			wantRestore: "like [Gone](cf-thread://s-gone)"},
		{name: "unnamed thread keeps its label", text: "x", composer: "like [Label](cf-thread://s-unnamed)", want: "like Label",
			wantRestore: "like [Label](cf-thread://s-unnamed)"},
		{name: "pr tag as its number", text: "x", composer: "review [#42](cf-pr://octo/repo/42)", want: "review #42",
			wantRestore: "review [#42](cf-pr://octo/repo/42)"},
		{name: "skills by name", text: "x", composer: "[/deploy](cf-skill://~/deploy) and [/ship it](cf-skill://r-1/ship%20it)",
			want: "/deploy and /ship it", wantRestore: "[/deploy](cf-skill://~/deploy) and [/ship it](cf-skill://r-1/ship%20it)"},
		{name: "citation as its quote and comment", text: cite, composer: cite + " thanks",
			want: `"the resize handler" why? thanks`, wantRestore: cite + " thanks"},
		{name: "typed file reference", text: "open @cf-file://r-1/src/a%20b.ts please", want: "open @src/a b.ts please"},
		{name: "typed thread line as its current name", text: `see [Thread "Old" (id s-known)] too`, want: "see Fix resize race too"},
		{name: "typed thread line of an unknown thread", text: `see [Thread "Old" (id s-gone)]`, want: "see Old"},
		{name: "typed citation link", text: cite, want: `"the resize handler" why?`},
		{name: "typed pr projection as typed", text: "fix octo/repo#42", want: "fix octo/repo#42"},
		{name: "a tag-like text that is not a token stays", text: "x", composer: "[a](https://example.com)",
			want: "[a](https://example.com)", wantRestore: "[a](https://example.com)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, restore := promptText(tt.text, tt.composer, names)
			if got != tt.want || restore != tt.wantRestore {
				t.Errorf("promptText = %q, %q; want %q, %q", got, restore, tt.want, tt.wantRestore)
			}
		})
	}
}
