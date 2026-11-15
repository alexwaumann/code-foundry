package textsearch

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxQueryChars bounds a query, in code points.
const MaxQueryChars = 500

// ErrInvalidQuery is a query text search refuses: too long, more than one line, a NUL, or
// a regular expression ripgrep cannot compile. The wrapping error's text says why in words
// a user can read.
var ErrInvalidQuery = errors.New("invalid query")

// invalidQuery is an ErrInvalidQuery whose Error is msg alone.
type invalidQuery struct{ msg string }

func (e invalidQuery) Error() string        { return e.msg }
func (e invalidQuery) Is(target error) bool { return target == ErrInvalidQuery }

// Query is what to look for.
type Query struct {
	// Text is literal text (spaces included), or a regular expression with Regex.
	Text string
	// MatchCase forces a case-sensitive search; otherwise the case is smart: text with an
	// upper-case letter matches case-sensitively, text without one ignores case.
	MatchCase bool
	// WholeWord matches only at word boundaries (ripgrep's --word-regexp).
	WholeWord bool
	// Regex reads Text as a regular expression (ripgrep's default Rust syntax).
	Regex bool
}

// CaseSensitive reports whether q matches case-sensitively: MatchCase, or an upper-case
// letter in the text. In a regular expression, a letter after a backslash is not text
// (\W, \S, \p{Lu}, \x41), as in ripgrep's own smart case.
func (q Query) CaseSensitive() bool {
	return q.MatchCase || hasUpper(q.Text, q.Regex)
}

func hasUpper(s string, regex bool) bool {
	if !regex {
		return strings.IndexFunc(s, unicode.IsUpper) >= 0
	}
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		if r != '\\' {
			if unicode.IsUpper(r) {
				return true
			}
			i += n
			continue
		}
		// An escape: skip the backslash and the letter after it, and a braced argument
		// (\p{Lu}, \x{41}, \u{41}).
		i += n
		if i >= len(s) {
			break
		}
		_, n = utf8.DecodeRuneInString(s[i:])
		i += n
		if i < len(s) && s[i] == '{' {
			if end := strings.IndexByte(s[i:], '}'); end >= 0 {
				i += end + 1
			}
		}
	}
	return false
}

// check refuses what ripgrep must never see: over MaxQueryChars, a line break (a query is
// one line; ripgrep does not match across lines here), a NUL (it cannot be an argument).
func (q Query) check() error {
	switch {
	case utf8.RuneCountInString(q.Text) > MaxQueryChars:
		return invalidQuery{fmt.Sprintf("the query is %d characters long, at most %d", utf8.RuneCountInString(q.Text), MaxQueryChars)}
	case strings.ContainsAny(q.Text, "\n\r"):
		return invalidQuery{"the query is more than one line"}
	case strings.ContainsRune(q.Text, 0):
		return invalidQuery{"the query holds a NUL character"}
	case !utf8.ValidString(q.Text):
		return invalidQuery{"the query is not valid UTF-8"}
	}
	return nil
}

// regexError turns ripgrep's stderr for a pattern it cannot compile into a sentence:
//
//	rg: regex parse error:
//	    (?:(foo)
//	    ^
//	error: unclosed group
//
// becomes "invalid regular expression: unclosed group". A pattern ending in a lone
// backslash reads "unclosed group" too (ripgrep wraps the pattern in a group, which the
// backslash then escapes), so that case is named for what it is.
func regexError(pattern, stderr string) error {
	if trailingBackslash(pattern) {
		return invalidQuery{`invalid regular expression: it ends with a lone \ (write \\ for a backslash)`}
	}
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if msg, ok := strings.CutPrefix(l, "error: "); ok && msg != "" {
			return invalidQuery{"invalid regular expression: " + msg}
		}
	}
	msg := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(stderr), "rg:"))
	if msg == "" {
		msg = "ripgrep refused it"
	}
	return invalidQuery{"invalid regular expression: " + msg}
}

// trailingBackslash: an odd run of backslashes ends s.
func trailingBackslash(s string) bool {
	n := 0
	for i := len(s) - 1; i >= 0 && s[i] == '\\'; i-- {
		n++
	}
	return n%2 == 1
}
