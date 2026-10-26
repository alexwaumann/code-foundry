package command

import (
	"regexp"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/pagelib"
)

// The arbitrary-value check of view.inline's page warnings (docs/notes/page-library-fixes-a.md),
// kept apart from commands_view_inline.go's table: /cf/ui.css carries utilities on the scale
// only, so `min-h-[420px]` without /cf/tailwind.js does nothing, silently.

// WarnArbitraryClass is for a class like min-h-[420px] in a page without the runtime.
const WarnArbitraryClass = "page uses Tailwind arbitrary values (classes like min-h-[420px]) without /cf/tailwind.js, and " +
	"/cf/ui.css has none, so they do nothing; use the scale (sizes go in 4px steps: min-h-112 is 448px, max-h-96 is 384px), " +
	`a style attribute, or add <script src="/cf/tailwind.js"></script>`

// The check joins pageChecks, last, from this file: commands_view_inline.go's table stays as
// it is.
func init() {
	pageChecks = append(pageChecks, pageCheck{WarnArbitraryClass, arbitraryWithoutRuntime})
}

// classAttr is a class or className attribute's value, quoted or a JSX expression's first string.
var classAttr = regexp.MustCompile(`\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:cn\()?["'` + "`" + `]([^"'` + "`" + `]*))`)

// firstArbitraryClass is the first arbitrary class in a class attribute of text, or "".
func firstArbitraryClass(text string) string {
	for _, m := range classAttr.FindAllStringSubmatch(text, -1) {
		// A utility, variant or property with an arbitrary value: min-h-[420px],
		// md:grid-cols-[2fr_1fr], data-[state=open]:flex, [mask-type:alpha]. The components'
		// own are in ui.css, a page's are not.
		for _, c := range strings.Fields(m[1] + m[2] + m[3]) {
			if i := strings.IndexByte(c, '['); i >= 0 && strings.IndexByte(c[i:], ']') > 0 {
				return c
			}
		}
	}
	return ""
}

// arbitraryWithoutRuntime reports whether the page uses an arbitrary class and does not load
// the Tailwind runtime, which alone makes them.
func arbitraryWithoutRuntime(p page) bool {
	return !strings.Contains(p.text, pagelib.TailwindPath) && firstArbitraryClass(p.text) != ""
}
