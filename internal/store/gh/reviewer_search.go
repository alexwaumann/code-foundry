package gh

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"unicode"
)

// The reviewer picker's search of several words. GitHub's assignableUsers(query:)
// matches the whole string against the login and the stored profile name, so "jane doe"
// finds nobody whose name is stored as "Doe, Jane". ReviewerCandidates asks for each
// word as well (aliased fields of the same document) and keeps the users matching every
// word, best matches first.

// reviewerSearchMaxTokens caps the words a search asks for on their own: one aliased
// assignableUsers field each (t0..t3 in reviewer_candidates.graphql).
const reviewerSearchMaxTokens = 4

// reviewerSearchTokens splits a search into its words: on whitespace and commas, empty
// pieces dropped, at most reviewerSearchMaxTokens.
func reviewerSearchTokens(query string) []string {
	f := strings.FieldsFunc(query, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	if len(f) > reviewerSearchMaxTokens {
		f = f[:reviewerSearchMaxTokens]
	}
	return f
}

// foldSearch lowercases s and drops everything but letters and digits, so "Doe, Jane",
// "jane-doe" and "O'Brien" compare by their letters.
func foldSearch(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// foldTokens folds each token, dropping those with no letter or digit (they would
// match anyone).
func foldTokens(tokens []string) []string {
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if f := foldSearch(t); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// Match quality, best first.
const (
	rankLoginPrefix = iota // the login starts with one of the words
	rankNamePrefix         // every word starts a word of the name
	rankContains           // every word is somewhere in the login or the name
)

// reviewerSearchRank reports whether the login or the name contains every folded token
// (each in either one), and how well: one of the rank constants.
func reviewerSearchRank(login, name string, tokens []string) (int, bool) {
	l, n := foldSearch(login), foldSearch(name)
	for _, t := range tokens {
		if !strings.Contains(l, t) && !strings.Contains(n, t) {
			return 0, false
		}
	}
	for _, t := range tokens {
		if strings.HasPrefix(l, t) {
			return rankLoginPrefix, true
		}
	}
	// Name words split on whitespace and punctuation, apostrophes kept ("O'Brien").
	words := strings.FieldsFunc(name, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' })
	for i, w := range words {
		words[i] = foldSearch(w)
	}
	for _, t := range tokens {
		if !slices.ContainsFunc(words, func(w string) bool { return strings.HasPrefix(w, t) }) {
			return rankContains, true
		}
	}
	return rankNamePrefix, true
}

// filterReviewerSearch keeps the candidates matching every token, ordered by match
// quality, then by login (case-insensitive).
func filterReviewerSearch(cands []ReviewerCandidate, tokens []string) []ReviewerCandidate {
	folded := foldTokens(tokens)
	type ranked struct {
		c    ReviewerCandidate
		rank int
	}
	var keep []ranked
	for _, c := range cands {
		if r, ok := reviewerSearchRank(c.Login, c.Name, folded); ok {
			keep = append(keep, ranked{c, r})
		}
	}
	slices.SortStableFunc(keep, func(a, b ranked) int {
		return cmp.Or(cmp.Compare(a.rank, b.rank), strings.Compare(strings.ToLower(a.c.Login), strings.ToLower(b.c.Login)))
	})
	out := make([]ReviewerCandidate, 0, len(keep))
	for _, k := range keep {
		out = append(out, k.c)
	}
	return out
}

// reviewerCandidatesVars are the ReviewerCandidates document's variables: search is set
// only for a non-empty query, and s0..s3 (with q0..q3) only for a query of several
// words, one per word.
func reviewerCandidatesVars(owner, name string, number int, query string) map[string]any {
	v := map[string]any{"owner": owner, "name": name, "number": number, "query": query, "search": query != ""}
	tokens := reviewerSearchTokens(query)
	if len(tokens) < 2 {
		tokens = nil
	}
	for i := range reviewerSearchMaxTokens {
		q := ""
		if i < len(tokens) {
			q = tokens[i]
		}
		v[fmt.Sprintf("q%d", i)] = q
		v[fmt.Sprintf("s%d", i)] = q != ""
	}
	return v
}
