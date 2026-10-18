package thread

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestProvisionalName(t *testing.T) {
	long := "Refactor the authentication middleware so that every handler checks the session token"
	tests := []struct {
		name     string
		composer string
		text     string
		want     string
	}{
		{name: "short prompt as is", text: "Fix the login redirect", want: "Fix the login redirect"},
		{name: "empty", text: "  \n\t ", want: ""},
		{name: "whitespace collapses", text: "  Fix   the\tlogin   redirect  ", want: "Fix the login redirect"},
		{name: "first line", text: "Fix the login redirect\nIt loops forever on Safari", want: "Fix the login redirect"},
		{name: "first line with text", text: "\n\n   \nAdd a dark mode\nmore", want: "Add a dark mode"},
		{name: "first sentence", text: "Fix the login redirect. It loops forever on Safari.", want: "Fix the login redirect"},
		{name: "question kept", text: "Why does the build fail? It worked yesterday", want: "Why does the build fail?"},
		{name: "exclamation kept", text: "Ship the release now! Everything is green", want: "Ship the release now!"},
		{name: "trailing period goes", text: "Add a dark mode.", want: "Add a dark mode"},
		{name: "trailing colon goes", text: "Fix these tests:\n- a\n- b", want: "Fix these tests"},
		{name: "abbreviation does not end a sentence", text: "Use a schema library, e.g. zod for the forms. Then test", want: "Use a schema library, e.g. zod for the forms"},
		{name: "version does not end a sentence", text: "Upgrade to v1.2. Then rebuild", want: "Upgrade to v1.2"},
		{name: "one-word sentence does not end it", text: "Hi. Please fix the flaky test", want: "Hi. Please fix the flaky test"},
		{name: "period inside a word", text: "Rename config.yaml to settings.yaml", want: "Rename config.yaml to settings.yaml"},
		{name: "heading marker", text: "## Add usage docs\n\nbody", want: "Add usage docs"},
		{name: "list marker", text: "- fix the login page", want: "fix the login page"},
		{name: "numbered marker", text: "1. Bump the Go version", want: "Bump the Go version"},
		{name: "issue ref kept", text: "#123 is broken again", want: "#123 is broken again"},
		{name: "code fence skipped", text: "```go\nfunc main() {}\n```", want: "func main() {}"},
		{name: "cut at a word boundary", text: long, want: "Refactor the authentication middleware so that…"},
		{name: "long word cut mid-word", text: strings.Repeat("a", 60), want: strings.Repeat("a", 47) + "…"},
		{name: "long second word cuts after the first", text: "Fix " + strings.Repeat("b", 60), want: "Fix…"},
		{name: "punctuation before the cut goes", text: "Fix the login, the signup, and the reset flows, all of them, today", want: "Fix the login, the signup, and the reset flows…"},
		{name: "exactly the limit is not cut", text: strings.Repeat("abcd ", 9) + "xyz", want: strings.Repeat("abcd ", 9) + "xyz"},
		{name: "unicode counted in runes", text: strings.Repeat("ü", 60), want: strings.Repeat("ü", 47) + "…"},
		{name: "unicode words", text: "Überarbeite die Anmeldung, damit Weiterleitungen nicht mehr endlos laufen", want: "Überarbeite die Anmeldung, damit…"},
		{name: "cjk sentence end", text: "修复登录重定向。然后运行测试", want: "修复登录重定向"},
		{name: "emoji", text: "🚀 Ship it", want: "🚀 Ship it"},
		{name: "control characters go", text: "Fix\x1b[31m the\x07 bug", want: "Fix [31m the bug"},

		{name: "image only", composer: "![shot.png](cf-attachment://a3)", text: "[Image: shot.png; ref=/tmp/a.png]", want: ""},
		{name: "images only", composer: "![a.png](cf-attachment://a1) ![b.pdf](cf-attachment://a2)\n", want: ""},
		{name: "image dropped", composer: "![shot.png](cf-attachment://a3) why is this red?", want: "why is this red?"},
		{name: "image mid-text", composer: "Match ![shot.png](cf-attachment://a3) this design", want: "Match this design"},
		{name: "skill keeps its label", composer: "[/deploy](cf-skill://~/deploy) to staging", want: "/deploy to staging"},
		{name: "project skill", composer: "[/review](cf-skill://p-1/review) PR 12", want: "/review PR 12"},
		{name: "file keeps its label", composer: "Fix [Composer.tsx](cf-file://p-1/src/Composer.tsx) crash", want: "Fix Composer.tsx crash"},
		{name: "directory label", composer: "Explain [api/](cf-file://p-1/internal/api/)", want: "Explain api/"},
		{name: "other cf link", composer: "See [run 4](cf-run://r/4) logs", want: "See run 4 logs"},
		{name: "other cf image link", composer: "![x](cf-thing://y) Look", want: "Look"},
		{name: "plain markdown link kept", composer: "Read [the docs](https://example.com) first", want: "Read [the docs](https://example.com) first"},
		{name: "composer wins over text", composer: "From the composer", text: "From the text", want: "From the composer"},
		{name: "empty composer falls back to text", composer: "  ", text: "From the text", want: "From the text"},

		{name: "projected image dropped", text: "[Image: shot.png; ref=/tmp/x/a.png] why is this red?", want: "why is this red?"},
		{name: "projected pdf dropped", text: "[PDF: spec.pdf; ref=/tmp/x/s.pdf]\nSummarize the spec", want: "Summarize the spec"},
		{name: "projected file ref", text: "Fix @cf-file://p-1/src/components/Composer.tsx crash", want: "Fix Composer.tsx crash"},
		{name: "projected file ref decoded", text: "Read @cf-file://p-1/docs/My%20Notes.md now", want: "Read My Notes.md now"},
		{name: "projected directory ref", text: "Explain @cf-file://p-1/internal/api/", want: "Explain api/"},
		{name: "projected skill", text: "/deploy to staging", want: "/deploy to staging"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := provisionalName(tt.composer, tt.text)
			if got != tt.want {
				t.Errorf("provisionalName(%q, %q) = %q, want %q", tt.composer, tt.text, got, tt.want)
			}
			if n := utf8.RuneCountInString(got); n > maxProvisionalName {
				t.Errorf("%q has %d runes, more than %d", got, n, maxProvisionalName)
			}
			if _, err := cleanName(got, true); err != nil {
				t.Errorf("%q is not a valid name: %v", got, err)
			}
		})
	}
}
