package thread

import (
	"net/url"
	"regexp"
	"strings"
)

// A sent prompt's text as the composer shows it, for prompt history (prompts.go).
//
// A user_message item keeps what the user typed (Item.Text) and, when the GUI composer
// sent it with tags, the composer's own text with its tag tokens (Item.ComposerText; gui
// lib/prompt.ts). The send-time additions Claude got (the resume note, the seed prefix,
// the app memory refresh, attachment lines, completed thread references) live in other
// fields or only in the prompt, never in either text. promptText reads the composer text
// when there is one, else the typed text, and turns each tag into what its chip shows:
//
//	![shot.png](cf-attachment://0)           dropped, with one adjacent space
//	[/deploy](cf-skill://~/deploy)           /deploy
//	[a.ts](cf-file://r-1/src/a.ts)           src/a.ts (the path, decoded)
//	[Fix race](cf-thread://s-1)              the thread's current name, else the label
//	[#12](cf-pr://owner/repo/12)             #12
//	[Assistant quote](cf-cite://v1/…)        "<quote>" <comment>
//
// Typed text without composer text (the CLI) can hold the projections instead: a file
// reference "@cf-file://r-1/src/a.ts" becomes "@src/a.ts" (stripFileRefs), a thread line
// `[Thread "Fix race" (id s-1)]` the thread's current name, and a citation link reads as
// above. Pull request projections (owner/repo#12) are left as typed.

// composerTag matches one composer tag token (gui lib/prompt.ts TOKEN, plus the sent
// citation link): an image chip (no group) | 1 label, 2 skill|file, 3 project slot, 4 the
// rest | 5 thread label, 6 thread id | 7 pull request number | 8 a citation link's query.
var composerTag = regexp.MustCompile(`!\[[^\[\]\n]*\]\(cf-attachment://[A-Za-z0-9_-]+\)` +
	`|\[([^\[\]\n]*)\]\(cf-(skill|file)://([A-Za-z0-9_.~-]+)/([^\s()]+)\)` +
	`|\[([^\[\]\n]*)\]\(cf-thread://([A-Za-z0-9_-]{1,64})\)` +
	`|\[[^\[\]\n]*\]\(cf-pr://[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/([1-9][0-9]{0,9})\)` +
	`|` + citeLinkPattern)

// citeLinkPattern is a sent citation link (gui lib/citation.ts citeLink); its group is
// the query.
const citeLinkPattern = `\[[^\[\]\n]*\]\(cf-cite://v1/[^\s/?()]+/[^\s?()]+\?([^\s()]*)\)`

// citeLink matches a citation link alone (typed text).
var citeLink = regexp.MustCompile(citeLinkPattern)

// promptText returns the prompt's display text (trimmed; "" for an attachment-only
// prompt) and its composer text without image and PDF chips ("" without composer text).
// name returns a thread's current name ("" or false when unknown).
func promptText(text, composer string, name func(id string) (string, bool)) (display, restore string) {
	if strings.TrimSpace(composer) == "" {
		return strings.TrimSpace(typedText(text, name)), ""
	}
	return strings.TrimSpace(renderTags(composer, func(m []string) string { return tagText(m, name) })),
		strings.TrimSpace(renderTags(composer, func(m []string) string {
			if strings.HasPrefix(m[0], "!") {
				return ""
			}
			return m[0]
		}))
}

// renderTags replaces every composer tag with what with returns for its submatches; a
// tag replaced by "" goes with one adjacent space (the following one, else the
// preceding one), like the composer's removeReferences.
func renderTags(s string, with func(m []string) string) string {
	var b strings.Builder
	last := 0
	for _, loc := range composerTag.FindAllStringSubmatchIndex(s, -1) {
		m := make([]string, len(loc)/2)
		for i := range m {
			if loc[2*i] >= 0 {
				m[i] = s[loc[2*i]:loc[2*i+1]]
			}
		}
		start, end := loc[0], loc[1]
		rep := with(m)
		if rep == "" {
			if end < len(s) && s[end] == ' ' {
				end++
			} else if start > last && s[start-1] == ' ' {
				start--
			}
		}
		b.WriteString(s[last:start])
		b.WriteString(rep)
		last = end
	}
	b.WriteString(s[last:])
	return b.String()
}

// tagText is what one composer tag's chip shows (see the file comment).
func tagText(m []string, name func(string) (string, bool)) string {
	switch {
	case strings.HasPrefix(m[0], "!"):
		return ""
	case m[2] == "skill":
		if n, err := url.PathUnescape(m[4]); err == nil {
			return "/" + n
		}
		return "/" + m[4]
	case m[2] == "file":
		rel, _ := decodeRel(m[4])
		return rel
	case m[6] != "":
		if n, ok := name(m[6]); ok && n != "" {
			return n
		}
		if l := strings.TrimSpace(m[5]); l != "" {
			return l
		}
		return m[6]
	case m[7] != "":
		return "#" + m[7]
	case strings.Contains(m[0], "cf-cite://"):
		return citeText(m[8])
	}
	return m[0]
}

// citeText is a citation link's query as `"<quote>" <comment>`.
func citeText(query string) string {
	v, err := url.ParseQuery(query)
	if err != nil {
		return ""
	}
	out := `"` + strings.TrimSpace(v.Get("text")) + `"`
	if c := strings.TrimSpace(v.Get("comment")); c != "" {
		out += " " + c
	}
	return out
}

// typedText is typed text (no composer text) with its projections read back.
func typedText(text string, name func(string) (string, bool)) string {
	text = stripFileRefs(text)
	text = threadRefPattern.ReplaceAllStringFunc(text, func(line string) string {
		m := threadRefPattern.FindStringSubmatch(line)
		if n, ok := name(m[2]); ok && n != "" {
			return n
		}
		if m[1] != "" {
			return m[1]
		}
		return m[2]
	})
	return citeLink.ReplaceAllStringFunc(text, func(link string) string {
		return citeText(citeLink.FindStringSubmatch(link)[1])
	})
}
