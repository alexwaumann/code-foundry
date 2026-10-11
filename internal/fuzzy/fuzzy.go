// Package fuzzy ranks relative paths against a typed query: a small case-insensitive
// subsequence matcher for the composer's "@" file completion
// (FilesystemService.SearchFiles). It is pure: no filesystem access.
package fuzzy

import (
	"cmp"
	"slices"
	"strings"
)

// Match tiers, best first. A path's tier is the best one the query reaches.
const (
	tierNone       = iota
	tierPath       // the query is a subsequence of the whole path
	tierBaseSubseq // ... of the base name
	tierBasePrefix // the base name starts with the query
	tierBaseExact  // the base name is the query
)

// boundaryBonus is added per query character that lands at the start of a segment or
// right after a separator; a consecutive hit adds 1.
const boundaryBonus = 4

// Score rates path (relative, "/"-separated) against query, case-insensitively. Zero
// means no match; higher is better. An empty query matches everything with score 1.
//
// The tier dominates (exact base name > base name prefix > base name subsequence >
// whole-path subsequence). Within a tier, query characters that land at the start of
// a segment or after a separator ("/", ".", "-", "_", " ") add a bonus, and
// consecutive runs add a smaller one. Rank breaks remaining ties by path length.
func Score(path, query string) int {
	if query == "" {
		return 1
	}
	lp, lq := strings.ToLower(path), strings.ToLower(query)
	base := lp[strings.LastIndexByte(lp, '/')+1:]
	tier := tierNone
	var bonus int
	switch {
	case base == lq:
		tier = tierBaseExact
	case strings.HasPrefix(base, lq):
		tier = tierBasePrefix
	default:
		if b, ok := subsequence(base, lq); ok {
			tier, bonus = tierBaseSubseq, b
		} else if b, ok := subsequence(lp, lq); ok {
			tier, bonus = tierPath, b
		}
	}
	if tier == tierNone {
		return 0
	}
	// Tiers are spaced so no bonus can lift a path into the next tier.
	return tier<<20 + min(bonus, 1<<20-1)
}

// subsequence reports whether q is a subsequence of s (both lower-cased) and the best
// bonus over every alignment: boundaryBonus per character at a boundary, 1 per
// character right after the previous one. O(len(s)·len(q)) with two rows.
func subsequence(s, q string) (bonus int, ok bool) {
	const none = -1 << 30
	m := len(q)
	if m == 0 {
		return 0, true
	}
	if !isSubsequence(s, q) { // the common case on a large tree: no allocation
		return 0, false
	}
	// at[j]: best bonus with q[j] matched at the previous position of s;
	// best[j]: best bonus with q[:j+1] matched anywhere so far.
	at, best, next := make([]int, m), make([]int, m), make([]int, m)
	for j := range m {
		at[j], best[j] = none, none
	}
	for i := 0; i < len(s); i++ {
		b := 0
		if i == 0 || isBoundary(s[i-1]) {
			b = boundaryBonus
		}
		for j := range m {
			next[j] = none
			if s[i] != q[j] {
				continue
			}
			if j == 0 {
				next[j] = b
				continue
			}
			from := max(best[j-1], at[j-1]+1)
			if best[j-1] != none {
				next[j] = b + from
			}
		}
		for j := range m {
			best[j] = max(best[j], next[j])
		}
		at, next = next, at
	}
	if best[m-1] == none {
		return 0, false
	}
	return best[m-1], true
}

func isSubsequence(s, q string) bool {
	j := 0
	for i := 0; i < len(s) && j < len(q); i++ {
		if s[i] == q[j] {
			j++
		}
	}
	return j == len(q)
}

func isBoundary(c byte) bool {
	switch c {
	case '/', '.', '-', '_', ' ':
		return true
	}
	return false
}

// Ranked is one match of Rank.
type Ranked struct {
	Index int // into the candidates passed to Rank
	Score int
}

// Rank returns the indexes of the paths that match query, best first, at most limit
// (zero: all), and whether more matched. Ties go to the shorter path, then the
// lexically smaller one. An empty query ranks by depth instead: top-level entries
// first, then by path.
func Rank(paths []string, query string, limit int) (out []Ranked, truncated bool) {
	for i, p := range paths {
		if s := Score(p, query); s > 0 {
			out = append(out, Ranked{Index: i, Score: s})
		}
	}
	if query == "" {
		slices.SortFunc(out, func(a, b Ranked) int {
			pa, pb := paths[a.Index], paths[b.Index]
			return cmp.Or(cmp.Compare(strings.Count(pa, "/"), strings.Count(pb, "/")), cmp.Compare(pa, pb))
		})
	} else {
		slices.SortFunc(out, func(a, b Ranked) int {
			pa, pb := paths[a.Index], paths[b.Index]
			return cmp.Or(cmp.Compare(b.Score, a.Score), cmp.Compare(len(pa), len(pb)), cmp.Compare(pa, pb))
		})
	}
	if limit > 0 && len(out) > limit {
		return out[:limit], true
	}
	return out, false
}
