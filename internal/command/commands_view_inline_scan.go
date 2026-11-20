package command

import "strings"

// Small JavaScript scanning for view.inline's page checks (the polling and class checks):
// enough to find where a call's parentheses or a block's braces close in a page's script
// without being fooled by a bracket inside a string or a comment. Not a parser: a regular
// expression literal holding a quote or bracket can still mislead it, which costs a hint.

// skipJS returns the index after the string, template or comment starting at s[i], or i
// when none starts there. A template is skipped whole, its ${…} included.
func skipJS(s string, i int) int {
	switch c := s[i]; {
	case c == '"' || c == '\'' || c == '`':
		for j := i + 1; j < len(s); j++ {
			switch s[j] {
			case '\\':
				j++
			case c:
				return j + 1
			case '\n':
				if c != '`' {
					return j + 1 // an unclosed quote ends with its line
				}
			}
		}
		return len(s)
	case c == '/' && i+1 < len(s) && s[i+1] == '/':
		if j := strings.IndexByte(s[i:], '\n'); j >= 0 {
			return i + j + 1
		}
		return len(s)
	case c == '/' && i+1 < len(s) && s[i+1] == '*':
		if j := strings.Index(s[i+2:], "*/"); j >= 0 {
			return i + 2 + j + 2
		}
		return len(s)
	}
	return i
}

// closeOf returns the index of the bracket that closes the one at s[open] ((, { or [),
// skipping strings and comments, or -1 when it does not close.
func closeOf(s string, open int) int {
	depth := 0
	for i := open; i < len(s); {
		if j := skipJS(s, i); j != i {
			i = j
			continue
		}
		switch s[i] {
		case '(', '{', '[':
			depth++
		case ')', '}', ']':
			depth--
			if depth == 0 {
				return i
			}
		}
		i++
	}
	return -1
}

// isIdentByte reports whether c may be part of a JavaScript identifier (ASCII only).
func isIdentByte(c byte) bool {
	return c == '_' || c == '$' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// identBefore returns the identifier ending at s[:end] (after trailing spaces), or "".
func identBefore(s string, end int) string {
	for end > 0 && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	start := end
	for start > 0 && isIdentByte(s[start-1]) {
		start--
	}
	return s[start:end]
}
