package thread

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Thread search's query language and matching (docs/notes/search-3-index.md). Pure.
//
// A query is terms separated by white space; "a phrase" in double quotes is one term with
// its spaces. Every term must occur in the text, in any order, as a substring. Smart case:
// the match ignores case unless the query has an upper-case letter, and then it is exact.
// The index (trigram, case-insensitive) finds the candidates by the terms of three
// characters and more; the store checks each candidate's own text here (case, shorter
// terms, and a document saved from another copy of the item). A query whose terms are all shorter than three
// characters matches thread names only.

// minIndexedTerm is the trigram tokenizer's shortest searchable term, in characters.
const minIndexedTerm = 3

// searchQuery is a parsed query.
type searchQuery struct {
	// terms as typed (phrases without their quotes), distinct, in order.
	terms []string
	// caseSensitive: the query has an upper-case letter.
	caseSensitive bool
	// match is terms as runes, lower-cased unless caseSensitive.
	match [][]rune
	// fts is the FTS5 expression of the terms of minIndexedTerm characters and more
	// ("" when there is none: names only).
	fts string
	// short: some term is shorter than minIndexedTerm (only the text check sees it).
	short bool
}

// parseSearch parses q.
func parseSearch(q string) searchQuery {
	var out searchQuery
	for _, t := range splitTerms(q) {
		if slices.Contains(out.terms, t) {
			continue
		}
		out.terms = append(out.terms, t)
	}
	out.caseSensitive = strings.IndexFunc(q, unicode.IsUpper) >= 0
	var fts []string
	for _, t := range out.terms {
		r := []rune(t)
		if !out.caseSensitive {
			r = lowerRunes(r)
		}
		out.match = append(out.match, r)
		if utf8.RuneCountInString(t) < minIndexedTerm {
			out.short = true
			continue
		}
		fts = append(fts, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
	}
	out.fts = strings.Join(fts, " AND ")
	return out
}

// splitTerms splits q at white space outside double quotes; a quoted run is one term
// (an unclosed quote runs to the end). Terms are trimmed; empty ones are dropped. Other
// control characters (a NUL, an escape) are dropped: FTS5 refuses a NUL in a string, and
// indexed text never holds one that a user could mean.
func splitTerms(q string) []string {
	var out []string
	var b strings.Builder
	quoted := false
	flush := func() {
		if t := strings.Join(strings.Fields(b.String()), " "); t != "" {
			out = append(out, t)
		}
		b.Reset()
	}
	for _, r := range q {
		switch {
		case r == '"':
			flush()
			quoted = !quoted
		case unicode.IsSpace(r) && !quoted:
			flush()
		case unicode.IsSpace(r):
			b.WriteRune(' ') // inside a phrase; flush makes a run one space
		case unicode.IsControl(r):
			// dropped
		default:
			b.WriteRune(r)
		}
	}
	flush()
	return out
}

// MatchRange is a match in a text: [Start, End) in code points (runes), not bytes.
type MatchRange struct {
	Start, End int
}

// matchRunes returns every occurrence of every term in text (sorted, overlaps merged),
// or nil when some term does not occur.
func (q searchQuery) matchRunes(text []rune) []MatchRange {
	if len(q.match) == 0 {
		return nil
	}
	hay := text
	if !q.caseSensitive {
		hay = lowerRunes(text)
	}
	var out []MatchRange
	for _, term := range q.match {
		found := false
		for i := 0; i+len(term) <= len(hay); {
			if slices.Equal(hay[i:i+len(term)], term) {
				out = append(out, MatchRange{i, i + len(term)})
				found = true
				i += len(term)
				continue
			}
			i++
		}
		if !found {
			return nil
		}
	}
	return mergeRanges(out)
}

// matchText is matchRunes over text on one line (searchLine).
func (q searchQuery) matchText(text string) []MatchRange { return q.matchRunes(searchLine(text)) }

// searchLine is text with every run of white space one space, trimmed, as runes.
func searchLine(text string) []rune { return []rune(strings.Join(strings.Fields(text), " ")) }

// mergeRanges sorts rs and merges overlapping or touching ranges.
func mergeRanges(rs []MatchRange) []MatchRange {
	slices.SortFunc(rs, func(a, b MatchRange) int {
		if a.Start != b.Start {
			return a.Start - b.Start
		}
		return a.End - b.End
	})
	var out []MatchRange
	for _, r := range rs {
		if n := len(out); n > 0 && r.Start <= out[n-1].End {
			out[n-1].End = max(out[n-1].End, r.End)
			continue
		}
		out = append(out, r)
	}
	return out
}

// lowerRunes lower-cases each rune (one rune for one, so positions hold).
func lowerRunes(r []rune) []rune {
	out := make([]rune, len(r))
	for i, c := range r {
		out[i] = unicode.ToLower(c)
	}
	return out
}

// Snippet sizes, in code points: a snippet shows up to snippetLen of the text, starting
// up to snippetBefore before its first match.
const (
	snippetLen    = 160
	snippetBefore = 48
)

// cutSnippet cuts r around the first of ranges (its matches, sorted) to snippetLen,
// starting and ending at words where it can, and returns the ranges inside it.
func cutSnippet(r []rune, ranges []MatchRange) (string, []MatchRange) {
	if len(r) <= snippetLen || len(ranges) == 0 {
		return string(r), ranges
	}
	first := ranges[0]
	start := max(0, first.Start-snippetBefore)
	if start > 0 {
		// Start at a word: after the next space, while that keeps the match.
		if i := slices.Index(r[start:first.Start], ' '); i >= 0 {
			start += i + 1
		}
	}
	end := min(len(r), start+snippetLen)
	if end-start < snippetLen {
		start = max(0, end-snippetLen)
	}
	if end < len(r) {
		// End at a word: before the last space, while that keeps the first match.
		if i := lastIndexRune(r[first.End:end], ' '); i >= 0 {
			end = first.End + i
		}
	}
	var b strings.Builder
	off := 0
	if start > 0 {
		b.WriteRune('…')
		off = 1
	}
	b.WriteString(string(r[start:end]))
	if end < len(r) {
		b.WriteRune('…')
	}
	var in []MatchRange
	for _, m := range ranges {
		if m.Start >= start && m.End <= end {
			in = append(in, MatchRange{m.Start - start + off, m.End - start + off})
		}
	}
	return b.String(), in
}

// Hit tiers, best first: how well the worst term of a query matches.
const (
	tierWord   = iota // a whole word somewhere
	tierPrefix        // the start of a word
	tierInside        // inside a word
)

// tier is how well line (searchLine runes, which q matches) matches q: each term's best
// occurrence, the worst term's.
func (q searchQuery) tier(line []rune) int {
	hay := line
	if !q.caseSensitive {
		hay = lowerRunes(line)
	}
	worst := tierWord
	for _, term := range q.match {
		best := tierInside
		for i := 0; i+len(term) <= len(hay) && best != tierWord; i++ {
			if !slices.Equal(hay[i:i+len(term)], term) {
				continue
			}
			startOK := i == 0 || !isWordRune(hay[i-1]) || !isWordRune(term[0])
			endOK := i+len(term) == len(hay) || !isWordRune(hay[i+len(term)]) || !isWordRune(term[len(term)-1])
			switch {
			case startOK && endOK:
				best = tierWord
			case startOK:
				best = min(best, tierPrefix)
			}
		}
		worst = max(worst, best)
	}
	return worst
}

// isWordRune reports whether c is part of a word (a letter, a digit or an underscore).
func isWordRune(c rune) bool { return c == '_' || unicode.IsLetter(c) || unicode.IsDigit(c) }

func lastIndexRune(r []rune, c rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if r[i] == c {
			return i
		}
	}
	return -1
}
