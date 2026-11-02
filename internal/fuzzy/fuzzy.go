// Package fuzzy ranks relative paths against a typed query: a small case-insensitive
// subsequence matcher for the composer's "@" file completion and the file finder
// (FilesystemService.SearchFiles), over one checkout or several. It is pure: no
// filesystem access.
package fuzzy

import (
	"cmp"
	"slices"
	"strings"
	"unicode/utf8"
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
// consecutive runs add a smaller one. RankSources breaks remaining ties by path
// length. Characters are runes: a non-ASCII query never matches part of a rune.
func Score(path, query string) int {
	s, _ := match(path, query, false)
	return s
}

// Positions returns the rune indices of path that query matches under Score, ascending:
// the base name's leading runes for an exact or prefix match, else the alignment with
// the best bonus. Nil when query is empty or does not match.
func Positions(path, query string) []int {
	_, pos := match(path, query, true)
	return pos
}

// match is Score, plus the matched rune indices when positions is true.
func match(path, query string, positions bool) (score int, pos []int) {
	if query == "" {
		return 1, nil
	}
	lp, lq := strings.ToLower(path), strings.ToLower(query)
	cut := strings.LastIndexByte(lp, '/') + 1
	base := lp[cut:]
	tier := tierNone
	var bonus int
	switch {
	case base == lq:
		tier = tierBaseExact
	case strings.HasPrefix(base, lq):
		tier = tierBasePrefix
	default:
		if b, p, ok := subsequence(base, lq, positions); ok {
			tier, bonus, pos = tierBaseSubseq, b, p
		} else if b, p, ok := subsequence(lp, lq, positions); ok {
			tier, bonus, pos, cut = tierPath, b, p, 0
		}
	}
	if tier == tierNone {
		return 0, nil
	}
	if positions {
		// Lower-casing maps rune to rune, so rune indices of lp are those of path.
		off := utf8.RuneCountInString(lp[:cut])
		if tier >= tierBasePrefix {
			pos = make([]int, utf8.RuneCountInString(lq))
			for i := range pos {
				pos[i] = i
			}
		}
		for i := range pos {
			pos[i] += off
		}
	}
	// Tiers are spaced so no bonus can lift a path into the next tier.
	return tier<<20 + min(bonus, 1<<20-1), pos
}

// subsequence reports whether q is a subsequence of s (both lower-cased) and the best
// bonus over every alignment, plus that alignment's rune indices when positions is
// true. ASCII strings are matched byte by byte, anything else rune by rune.
func subsequence(s, q string, positions bool) (bonus int, pos []int, ok bool) {
	if q == "" {
		return 0, nil, true
	}
	// A rune subsequence is a byte subsequence too, so this rejects the common case on
	// a large tree without allocating.
	if !isSubsequence(s, q) {
		return 0, nil, false
	}
	if isASCII(s) && isASCII(q) {
		return align([]byte(s), []byte(q), positions)
	}
	return align([]rune(s), []rune(q), positions)
}

// align finds the alignment of q in s with the best bonus: boundaryBonus per character
// at a boundary, 1 per character right after the previous one. Without positions it
// keeps two rows, O(len(q)) memory; with them, the whole O(len(s)·len(q)) table to walk
// back through.
func align[T byte | rune](s, q []T, positions bool) (bonus int, pos []int, ok bool) {
	const none = -1 << 30
	n, m := len(s), len(q)
	// at[j]: best bonus with q[j] matched at the previous position of s;
	// best[j]: best bonus with q[:j+1] matched anywhere so far.
	at, best, next := make([]int, m), make([]int, m), make([]int, m)
	for j := range m {
		at[j], best[j] = none, none
	}
	var table []int // table[i*m+j]: best bonus with q[j] matched at s[i]
	if positions {
		table = make([]int, n*m)
	}
	for i := range n {
		b := boundary(s, i)
		for j := range m {
			next[j] = none
			if s[i] != q[j] {
				continue
			}
			if j == 0 {
				next[j] = b
				continue
			}
			if best[j-1] != none {
				next[j] = b + max(best[j-1], at[j-1]+1)
			}
		}
		for j := range m {
			best[j] = max(best[j], next[j])
		}
		if positions {
			copy(table[i*m:], next)
		}
		at, next = next, at
	}
	if best[m-1] == none {
		return 0, nil, false
	}
	if !positions {
		return best[m-1], nil, true
	}
	// Walk back: the first end that reaches the best bonus, then for each earlier query
	// character the nearest position that accounts for the rest.
	pos = make([]int, m)
	i := 0
	for table[i*m+m-1] != best[m-1] {
		i++
	}
	pos[m-1] = i
	for j := m - 1; j > 0; j-- {
		want := table[i*m+j] - boundary(s, i)
		k := i - 1
		for ; k >= 0; k-- {
			v := table[k*m+j-1]
			if v == none {
				continue
			}
			if k == i-1 {
				v++
			}
			if v == want {
				break
			}
		}
		i = k
		pos[j-1] = i
	}
	return best[m-1], pos, true
}

func boundary[T byte | rune](s []T, i int) int {
	if i == 0 || isBoundary(s[i-1]) {
		return boundaryBonus
	}
	return 0
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

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func isBoundary[T byte | rune](c T) bool {
	switch c {
	case '/', '.', '-', '_', ' ':
		return true
	}
	return false
}

// Source is one candidate list for RankSources: a checkout's relative paths, and the
// name of its project.
type Source struct {
	Name  string
	Paths []string
}

// Hit is one match of RankSources.
type Hit struct {
	Source int // into the sources passed to RankSources
	Index  int // into that source's Paths
	Score  int
	// PathPositions are the rune indices of the path the query matched, ascending; nil
	// for an empty query.
	PathPositions []int
	// NamePositions are the rune indices of the source's Name that query words matched
	// (see Splits), ascending; nil when the whole query matched the path.
	NamePositions []int
}

// Split is one way to share a query between a project name and a path: Path is
// matched against the path as a one-source query, and the words of Name, joined
// without spaces, as a subsequence of the project name (empty: the name is not used).
type Split struct {
	Path string
	Name []string
}

// Splits lists the ways query (already trimmed) may be shared with the project name.
// One source (multi false) or an empty query: the query as typed, matched against
// the path alone. Several sources: the query's whitespace-separated words, joined by
// single spaces, against the path; then, for each run of words at the start or at the
// end of the query that leaves at least one word for the path and whose words, in
// order, are a case-insensitive subsequence of name, that run against the name and
// the rest against the path. So one word never touches the name, and "ghostty tree"
// matches tree files of a project named ghostty-playground. Splits with the same path
// query are listed once; the order is the preference on equal scores (more of the query
// on the path first).
func Splits(query, name string, multi bool) []Split {
	if !multi || query == "" {
		return []Split{{Path: query}}
	}
	words := strings.Fields(query)
	out := []Split{{Path: strings.Join(words, " ")}}
	ln := strings.ToLower(name)
	seen := map[string]bool{out[0].Path: true}
	add := func(nameWords, rest []string) {
		path := strings.Join(rest, " ")
		if seen[path] {
			return
		}
		if _, _, ok := subsequence(ln, strings.ToLower(strings.Join(nameWords, "")), false); ok {
			seen[path] = true
			out = append(out, Split{Path: path, Name: nameWords})
		}
	}
	for k := 1; k < len(words); k++ {
		add(words[:k], words[k:])
		add(words[len(words)-k:], words[:len(words)-k])
	}
	return out
}

// RankSources matches query against every path of every source and returns the
// matches as one list, best first, at most limit (zero: all), and whether more
// matched. With several sources, words of the query may match a source's name
// instead of the path (Splits); a path's score is its best Score over its source's
// splits. Ties go to the shorter path, then the lexically smaller one, then the
// earlier source. An empty query ranks by depth instead: top-level entries first, then
// by path, then by source.
func RankSources(sources []Source, query string, limit int) (hits []Hit, truncated bool) {
	query = strings.TrimSpace(query)
	type scored struct {
		Hit
		split int // into splits[Source]: the one that scored the path
	}
	splits := make([][]Split, len(sources))
	var out []scored
	for si, src := range sources {
		splits[si] = Splits(query, src.Name, len(sources) > 1)
		for i, p := range src.Paths {
			best, which := 0, 0
			for k, sp := range splits[si] {
				if s := Score(p, sp.Path); s > best {
					best, which = s, k
				}
			}
			if best > 0 {
				out = append(out, scored{Hit{Source: si, Index: i, Score: best}, which})
			}
		}
	}
	path := func(h scored) string { return sources[h.Source].Paths[h.Index] }
	slices.SortFunc(out, func(a, b scored) int {
		pa, pb := path(a), path(b)
		var c int
		if query == "" {
			c = cmp.Or(cmp.Compare(strings.Count(pa, "/"), strings.Count(pb, "/")), cmp.Compare(pa, pb))
		} else {
			c = cmp.Or(cmp.Compare(b.Score, a.Score), cmp.Compare(len(pa), len(pb)), cmp.Compare(pa, pb))
		}
		return cmp.Or(c, cmp.Compare(a.Source, b.Source), cmp.Compare(a.Index, b.Index))
	})
	if limit > 0 && len(out) > limit {
		out, truncated = out[:limit], true
	}
	hits = make([]Hit, len(out))
	for i, h := range out {
		sp := splits[h.Source][h.split]
		h.PathPositions = Positions(path(h), sp.Path)
		if len(sp.Name) > 0 {
			name, words := strings.ToLower(sources[h.Source].Name), strings.ToLower(strings.Join(sp.Name, ""))
			_, h.NamePositions, _ = subsequence(name, words, true)
		}
		hits[i] = h.Hit
	}
	return hits, truncated
}
