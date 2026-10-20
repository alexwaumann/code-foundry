package marketplace

import (
	"cmp"
	"slices"
	"strings"
)

// Search limits.
const (
	// DefaultLimit is a Query's Limit when it is 0 or less.
	DefaultLimit = 50
	// MaxLimit bounds a Query's Limit: the whole catalogue never goes over the wire.
	MaxLimit = 500
)

// Query is a Browse search.
type Query struct {
	// Text is matched case-insensitively against name, description, keywords and by.
	// Each whitespace-separated word must match one of them. "" matches everything.
	Text string
	// Tier and Kind filter when set.
	Tier Tier
	Kind Kind
	// Limit caps Result.Entries: DefaultLimit when 0 or less, at most MaxLimit.
	Limit int
}

// Result is a page of matches.
type Result struct {
	// Entries are the first Limit matches, best first.
	Entries []Entry
	// Total is how many entries matched before the limit.
	Total int
}

// Search ranks entries against q. Matches on the name come first (the exact name, then
// a name that starts with the text, then one that contains it), then matches elsewhere;
// within a rank, by name. An empty text returns entries sorted by name.
func Search(entries []Entry, q Query) Result {
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	limit = min(limit, MaxLimit)
	text := strings.ToLower(strings.Join(strings.Fields(q.Text), " "))
	words := strings.Fields(text)
	type hit struct {
		e    Entry
		rank int
	}
	var hits []hit
	for _, e := range entries {
		if q.Tier != "" && e.Tier != q.Tier || q.Kind != "" && e.Kind != q.Kind {
			continue
		}
		if !matchesAll(e, words) {
			continue
		}
		hits = append(hits, hit{e, nameRank(strings.ToLower(e.Name), text)})
	}
	slices.SortStableFunc(hits, func(a, b hit) int {
		return cmp.Or(cmp.Compare(a.rank, b.rank), compareEntries(a.e, b.e), cmp.Compare(a.e.Registry, b.e.Registry))
	})
	out := Result{Total: len(hits)}
	for _, h := range hits[:min(limit, len(hits))] {
		out.Entries = append(out.Entries, h.e)
	}
	return out
}

// nameRank is 0 for the exact name, 1 for a name starting with text, 2 for a name
// containing it, 3 otherwise (and for an empty text, so everything sorts by name).
func nameRank(name, text string) int {
	switch {
	case text == "":
		return 3
	case name == text:
		return 0
	case strings.HasPrefix(name, text):
		return 1
	case strings.Contains(name, text):
		return 2
	}
	return 3
}

func matchesAll(e Entry, words []string) bool {
	for _, w := range words {
		if !matches(e, w) {
			return false
		}
	}
	return true
}

func matches(e Entry, w string) bool {
	if contains(e.Name, w) || contains(e.Description, w) || contains(e.By, w) {
		return true
	}
	return slices.ContainsFunc(e.Keywords, func(k string) bool { return contains(k, w) })
}

func contains(s, lowerSub string) bool { return strings.Contains(strings.ToLower(s), lowerSub) }
