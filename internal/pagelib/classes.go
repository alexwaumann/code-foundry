package pagelib

import (
	"strconv"
	"strings"
	"sync"
)

// uiClasses is every class name /cf/ui.css has a rule for, read once from the embedded
// stylesheet the daemon serves: view.inline's unknown-class check
// (docs/notes/pages-skill-trial.md) tests a page's classes against it, so the list cannot
// drift from what a page gets.
var uiClasses = sync.OnceValue(func() map[string]bool {
	return CSSClasses(string(files[UICSSPath].body))
})

// UIClass reports whether /cf/ui.css has a rule for class name (as a page writes it:
// hover:bg-cf-surface-raised, size-3.5, sm:grid-cols-2).
func UIClass(name string) bool {
	return uiClasses()[name]
}

// CSSClasses returns the class names the selectors of css name, unescaped (`.sm\:flex` is
// sm:flex, `.size-3\.5` is size-3.5). It reads every `.` followed by a name, so a number
// in a value (`0.5rem`) adds a name no page uses, which is harmless: the set answers only
// whether a page's class exists.
func CSSClasses(css string) map[string]bool {
	out := map[string]bool{}
	for i := 0; i < len(css); i++ {
		if css[i] != '.' {
			continue
		}
		name, end := cssIdent(css, i+1)
		if name != "" {
			out[name] = true
		}
		i = end - 1
	}
	return out
}

// cssIdent reads a CSS identifier at s[i:], resolving escapes: a backslash and one
// character, or up to six hex digits and an optional space (`\31 0` is "10"). It returns
// the name and the index after it.
func cssIdent(s string, i int) (string, int) {
	var b strings.Builder
	for i < len(s) {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			j := i + 1
			for j < len(s) && j-i <= 6 && isHex(s[j]) {
				j++
			}
			if j > i+1 {
				if r, err := strconv.ParseUint(s[i+1:j], 16, 32); err == nil {
					b.WriteRune(rune(r))
				}
				if j < len(s) && s[j] == ' ' {
					j++
				}
				i = j
				continue
			}
			b.WriteByte(s[i+1])
			i += 2
		case c == '-' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80:
			b.WriteByte(c)
			i++
		default:
			return b.String(), i
		}
	}
	return b.String(), i
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}
