package fuzzy

import (
	"cmp"
	"slices"
	"strings"
	"testing"
)

func TestScoreTiers(t *testing.T) {
	tests := []struct {
		name, path, query string
		want              int // tier, or -1 for "matches (any tier)"
	}{
		{"empty query", "a/b.go", "", -1},
		{"exact base", "src/index.ts", "index.ts", tierBaseExact},
		{"exact base, case-insensitive", "src/README.md", "readme.md", tierBaseExact},
		{"base prefix", "src/index.ts", "ind", tierBasePrefix},
		{"base subsequence", "src/components/Composer.tsx", "cmpsr", tierBaseSubseq},
		{"path subsequence", "src/components/Composer.tsx", "srccomp", tierPath},
		{"query with slash", "src/components/Composer.tsx", "comp/comp", tierPath},
		{"directory", "docs/notes", "notes", tierBaseExact},
		{"no match", "src/index.ts", "xyz", tierNone},
		{"out of order", "src/index.ts", "xedni", tierNone},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Score(tt.path, tt.query)
			if tt.want == -1 {
				if got <= 0 {
					t.Fatalf("Score(%q, %q) = %d, want a match", tt.path, tt.query, got)
				}
				return
			}
			if tier := got >> 20; tier != tt.want {
				t.Fatalf("Score(%q, %q) tier = %d (score %d), want %d", tt.path, tt.query, tier, got, tt.want)
			}
		})
	}
}

func TestScoreBoundaryBonus(t *testing.T) {
	// "ct" at segment starts (components/tests) beats "ct" in the middle of a word.
	atBoundary := Score("src/components/tests.go", "ct")
	inside := Score("src/factory/x.go", "ct")
	if atBoundary <= inside {
		t.Fatalf("boundary %d <= inside %d", atBoundary, inside)
	}
}

func TestRankOneSource(t *testing.T) {
	paths := []string{
		"README.md",                      // 0
		"src",                            // 1
		"src/index.ts",                   // 2
		"src/components",                 // 3
		"src/components/Composer.tsx",    // 4
		"docs/notes/composer-tags-1.md",  // 5
		"docs",                           // 6
		"docs/notes",                     // 7
		"lib/composer.ts",                // 8
		"lib/very/deep/dir/composer.tsx", // 9
	}
	tests := []struct {
		name          string
		query         string
		limit         int
		want          []string
		wantTruncated bool
	}{
		{
			name:  "empty query: shallowest first, then by path",
			query: "", limit: 5,
			want:          []string{"README.md", "docs", "src", "docs/notes", "lib/composer.ts"},
			wantTruncated: true,
		},
		{
			name:  "base prefix beats base subsequence; shorter path wins ties",
			query: "composer",
			want: []string{
				"lib/composer.ts", "src/components/Composer.tsx", "docs/notes/composer-tags-1.md",
				"lib/very/deep/dir/composer.tsx",
			},
		},
		{
			name:  "exact base first",
			query: "composer.tsx",
			want:  []string{"src/components/Composer.tsx", "lib/very/deep/dir/composer.tsx"},
		},
		{
			name:  "path subsequence",
			query: "srcidx",
			want:  []string{"src/index.ts"},
		},
		{
			name:  "limit",
			query: "s", limit: 1,
			want:          []string{"src"},
			wantTruncated: true,
		},
		{
			name:  "no match",
			query: "zzz",
			want:  nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// One source: the query as typed, never split into words.
			ranked, truncated := RankSources([]Source{{Name: "composer", Paths: paths}}, tt.query, tt.limit)
			var got []string
			for _, r := range ranked {
				got = append(got, paths[r.Index])
				if r.NamePositions != nil {
					t.Fatalf("one source matched the name: %+v", r)
				}
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("Rank(%q) = %q, want %q", tt.query, got, tt.want)
			}
			if truncated != tt.wantTruncated {
				t.Fatalf("truncated = %v, want %v", truncated, tt.wantTruncated)
			}
		})
	}
}

func TestPositions(t *testing.T) {
	tests := []struct {
		name, path, query string
		want              []int
	}{
		{"empty query", "a/b.go", "", nil},
		{"no match", "a/b.go", "zz", nil},
		{"exact base", "src/index.ts", "index.ts", []int{4, 5, 6, 7, 8, 9, 10, 11}},
		{"base prefix, case-insensitive", "src/Index.ts", "IND", []int{4, 5, 6}},
		{"base subsequence at boundaries", "src/components/Composer.tsx", "cmpsr", []int{15, 17, 18, 20, 22}},
		{"base subsequence prefers a boundary", "lib/tree-tests.go", "tt", []int{4, 9}},
		{"path subsequence across segments", "src/components/Composer.tsx", "srccomp", []int{0, 1, 4, 15, 16, 17, 18}},
		{"query with slash", "a/b/c.go", "a/c", []int{0, 3, 4}},
		{"directory", "docs/notes", "notes", []int{5, 6, 7, 8, 9}},
		// Rune indices, not bytes: "é" is two bytes but one position.
		{"non-ASCII base prefix", "docs/café/menu.md", "menu", []int{10, 11, 12, 13}},
		{"non-ASCII subsequence", "docs/résumé.md", "rsm", []int{5, 7, 12}},
		{"non-ASCII query", "docs/Résumé.md", "ÉSU", []int{6, 7, 8}},
		// A byte subsequence that is not a rune one ("é" is C3 A9, "©" is C2 A9).
		{"no match across runes", "a/Ã©", "é", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Positions(tt.path, tt.query)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("Positions(%q, %q) = %v, want %v", tt.path, tt.query, got, tt.want)
			}
			if (Score(tt.path, tt.query) > 0) != (tt.want != nil || tt.query == "") {
				t.Fatalf("Score(%q, %q) = %d disagrees with Positions", tt.path, tt.query, Score(tt.path, tt.query))
			}
		})
	}
}

// The positions are the alignment Score rated: their bonus is Score's.
func TestPositionsMatchScore(t *testing.T) {
	paths := []string{
		"src/components/Composer.tsx", "internal/fuzzy/fuzzy_test.go", "gui/frontend/mock/filesystem.ts",
		"docs/notes/file-finder-1-search.md", "a-b_c.d/e f", "aaaa/aaaa", "lib/résumé/Écrit.go",
	}
	queries := []string{"c", "cmp", "fz", "fft", "mock", "ffs", "abcdef", "aa", "aaa", "rsec", "é", "ffnd"}
	for _, p := range paths {
		for _, q := range queries {
			s := Score(p, q)
			pos := Positions(p, q)
			if s == 0 {
				if pos != nil {
					t.Fatalf("Positions(%q, %q) = %v without a match", p, q, pos)
				}
				continue
			}
			if tier := s >> 20; tier >= tierBasePrefix {
				continue // no bonus
			}
			rs, lq := []rune(strings.ToLower(p)), []rune(strings.ToLower(q))
			bonus := 0
			for j, i := range pos {
				if rs[i] != lq[j] {
					t.Fatalf("Positions(%q, %q) = %v: rune %d is %q, want %q", p, q, pos, i, rs[i], lq[j])
				}
				bonus += boundary(rs, i)
				if j > 0 && pos[j-1] == i-1 {
					bonus++
				}
			}
			if want := s & (1<<20 - 1); bonus != want {
				t.Fatalf("Positions(%q, %q) = %v has bonus %d, Score's is %d", p, q, pos, bonus, want)
			}
		}
	}
}

func TestSplits(t *testing.T) {
	tests := []struct {
		name, query, project string
		multi                bool
		want                 []Split
	}{
		{"one source: every word on the path", "ghostty  tree", "ghostty-playground", false, []Split{{0, 2}}},
		{"empty query", "", "ghostty-playground", true, []Split{{0, 0}}},
		{"one word never takes the name", "ghostty", "ghostty-playground", true, []Split{{0, 1}}},
		{"leading word", "ghostty tree", "ghostty-playground", true, []Split{{0, 2}, {1, 2}}},
		{"trailing word", "tree gp", "ghostty-playground", true, []Split{{0, 2}, {0, 1}}},
		{"name words not in the name", "ghostty tree", "code-foundry", true, []Split{{0, 2}}},
		{"a run of words", "code foundry readme", "code-foundry", true, []Split{{0, 3}, {1, 3}, {2, 3}}},
		{"a word in the middle stays on the path", "readme foundry tree", "code-foundry", true, []Split{{0, 3}}},
		// Each name word matches the name on its own, so their order doesn't matter.
		{"words out of the name's order", "foundry code readme", "code-foundry", true, []Split{{0, 3}, {1, 3}, {2, 3}}},
		{"a run stops at a word not in the name", "code src foundry", "code-foundry", true, []Split{{0, 3}, {1, 3}, {0, 2}}},
		{"whitespace collapses", "  web\t index ", "web", true, []Split{{0, 2}, {1, 2}}},
		{"case-insensitive", "Ghostty tree", "ghostty-playground", true, []Split{{0, 2}, {1, 2}}},
		{"both ends", "a a", "a", true, []Split{{0, 2}, {1, 2}, {0, 1}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Splits(Words(tt.query), tt.project, tt.multi)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("Splits(%q, %q) = %v, want %v", tt.query, tt.project, got, tt.want)
			}
		})
	}
}

func TestScoreWords(t *testing.T) {
	// One word: the same order as Score, whatever the tier.
	paths := []string{"src/index.ts", "src/components/Composer.tsx", "lib/composer.ts", "docs/notes/x.md", "a/b/c"}
	for _, q := range []string{"index.ts", "comp", "cmpsr", "srccomp", "s", "x", "zz"} {
		for _, a := range paths {
			for _, b := range paths {
				want := cmp.Compare(Score(a, q), Score(b, q))
				if got := cmp.Compare(ScoreWords(a, []string{q}), ScoreWords(b, []string{q})); got != want {
					t.Fatalf("%q: ScoreWords orders %q, %q as %d, Score as %d", q, a, b, got, want)
				}
			}
		}
	}
	tests := []struct {
		name          string
		better, worse string
		query         string
	}{
		// Composer.tsx: "comp" a base prefix, "tsx" a base subsequence. Thread.tsx: "comp"
		// only across directories.
		{"every word in the base name beats one in a directory", "x/compose/Composer.tsx", "src/components/Thread.tsx", "comp tsx"},
		{"even an exact base word doesn't lift a directory-only word",
			"x/y/Composer.tsx", "src/components/tsx", "comp tsx"},
		{"then more exact and prefix words", "x/comp.tsx", "x/c-o-m-p.tsx", "comp tsx"},
		{"then the bonus", "x/a-b.go", "x/xab.go", "a b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, w := ScoreWords(tt.better, Words(tt.query)), ScoreWords(tt.worse, Words(tt.query))
			if w == 0 || b <= w {
				t.Fatalf("%q: %q scores %d, %q scores %d", tt.query, tt.better, b, tt.worse, w)
			}
		})
	}
}

func TestPositionsWords(t *testing.T) {
	tests := []struct {
		name, path, query string
		want              []int
	}{
		{"no words", "a/b.go", "", nil},
		{"one word: Positions", "src/components/Composer.tsx", "cmpsr", []int{15, 17, 18, 20, 22}},
		{"across words", "gui/compose/Composer.tsx", "comp tsx", []int{12, 13, 14, 15, 21, 22, 23}},
		{"word order doesn't matter", "gui/compose/Composer.tsx", "tsx comp", []int{12, 13, 14, 15, 21, 22, 23}},
		{"a directory word and a base word", "src/tree/x.zig", "tree zig", []int{4, 5, 6, 7, 11, 12, 13}},
		{"overlapping words, merged", "src/index.ts", "ind index", []int{4, 5, 6, 7, 8}},
		{"one word missing: no positions", "src/index.ts", "index zz", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PositionsWords(tt.path, Words(tt.query)); !slices.Equal(got, tt.want) {
				t.Fatalf("PositionsWords(%q, %q) = %v, want %v", tt.path, tt.query, got, tt.want)
			}
			if (ScoreWords(tt.path, Words(tt.query)) > 0) != (tt.want != nil || tt.query == "") {
				t.Fatalf("ScoreWords(%q, %q) disagrees with PositionsWords", tt.path, tt.query)
			}
		})
	}
}

func TestRankWords(t *testing.T) {
	paths := []string{
		"README.md", // 0
		"gui/frontend/src/components/compose/Composer.tsx", // 1
		"gui/frontend/src/components/Thread.tsx",           // 2
		"gui/frontend/src/components/compose/Tags.ts",      // 3
		"internal/compose/compose.go",                      // 4
		"docs/notes/composer-tags-1.md",                    // 5
	}
	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{"comp tsx", "comp tsx", []string{
			"gui/frontend/src/components/compose/Composer.tsx", // both words in the base name
			"gui/frontend/src/components/Thread.tsx",           // "comp" only in a directory
		}},
		{"word order is irrelevant", "tsx comp", []string{
			"gui/frontend/src/components/compose/Composer.tsx", "gui/frontend/src/components/Thread.tsx",
		}},
		{"a word that matches nowhere: no result", "comp zzz", nil},
		{"base-name words beat directory-only words", "compose tags", []string{
			"docs/notes/composer-tags-1.md",               // both in the base name
			"gui/frontend/src/components/compose/Tags.ts", // "compose" a directory
		}},
		{"extra spaces are ignored", "  comp   tsx ", []string{
			"gui/frontend/src/components/compose/Composer.tsx", "gui/frontend/src/components/Thread.tsx",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hits, _ := RankSources([]Source{{Name: "code-foundry", Paths: paths}}, tt.query, 0)
			var got []string
			for _, h := range hits {
				got = append(got, paths[h.Index])
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("RankSources(%q) = %q, want %q", tt.query, got, tt.want)
			}
		})
	}
}

func TestRankSources(t *testing.T) {
	cf := Source{Name: "code-foundry", Paths: []string{
		"README.md", "internal/tree/tree.go", "docs/ghostty-tree.md", "src/index.ts",
	}}
	gh := Source{Name: "ghostty-playground", Paths: []string{
		"README.md", "src/tree.zig", "src/subtree/x.zig", "build.zig",
	}}
	web := Source{Name: "web", Paths: []string{"src/index.ts", "src/app.tsx"}}
	index := Source{Name: "index", Paths: []string{"src/index.ts"}}
	src := Source{Name: "src", Paths: []string{"src/index.ts", "lib/index.ts"}}
	type hit struct {
		src       int
		path      string
		pathPos   []int
		namePos   []int
		pathPosOK bool // compare pathPos
	}
	tests := []struct {
		name          string
		sources       []Source
		query         string
		limit         int
		want          []hit
		wantTruncated bool
	}{
		{
			name:    "one word: the path only, across sources by score",
			sources: []Source{cf, gh}, query: "tree",
			want: []hit{
				{src: 1, path: "src/tree.zig"}, // base prefix, then the shorter path
				{src: 0, path: "internal/tree/tree.go"},
				{src: 0, path: "docs/ghostty-tree.md"}, // base subsequence
				{src: 1, path: "src/subtree/x.zig"},    // path subsequence
			},
		},
		{
			name:    "a project word: that project's tree files first",
			sources: []Source{cf, gh}, query: "ghostty tree",
			want: []hit{
				// Only "tree" is left for the path, a base prefix.
				{src: 1, path: "src/tree.zig", pathPos: []int{4, 5, 6, 7}, namePos: []int{0, 1, 2, 3, 4, 5, 6}, pathPosOK: true},
				// code-foundry has no "ghostty" in its name, so both words match the path:
				// both in the base name, but "tree" only as a subsequence.
				{src: 0, path: "docs/ghostty-tree.md", pathPos: []int{5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16}, pathPosOK: true},
				// "tree" only in a directory.
				{src: 1, path: "src/subtree/x.zig", pathPos: []int{7, 8, 9, 10}, namePos: []int{0, 1, 2, 3, 4, 5, 6}, pathPosOK: true},
			},
		},
		{
			name:    "a project word and two path words, in any order",
			sources: []Source{cf, gh}, query: "gh zig tree",
			want: []hit{
				{src: 1, path: "src/tree.zig", pathPos: []int{4, 5, 6, 7, 9, 10, 11}, namePos: []int{0, 1}, pathPosOK: true},
				{src: 1, path: "src/subtree/x.zig", pathPos: []int{7, 8, 9, 10, 14, 15, 16}, namePos: []int{0, 1}, pathPosOK: true},
			},
		},
		{
			name:    "a word in the name and the base name stays on the path",
			sources: []Source{cf, index}, query: "index ts",
			// Moving "index" to the name would leave the weakest word ("ts", a base
			// subsequence) where it is and drop a prefix word: worse.
			want: []hit{
				{src: 0, path: "src/index.ts", pathPos: []int{4, 5, 6, 7, 8, 10, 11}, pathPosOK: true},
				{src: 1, path: "src/index.ts", pathPos: []int{4, 5, 6, 7, 8, 10, 11}, pathPosOK: true},
			},
		},
		{
			name:    "a word in the name and only a directory goes to the name",
			sources: []Source{cf, src}, query: "src index",
			// In the source named src, "src" on the path would be the weakest word (a
			// directory); on the name, only the base prefix "index" is left.
			want: []hit{
				{src: 1, path: "lib/index.ts", pathPos: []int{4, 5, 6, 7, 8}, namePos: []int{0, 1, 2}, pathPosOK: true},
				{src: 1, path: "src/index.ts", pathPos: []int{4, 5, 6, 7, 8}, namePos: []int{0, 1, 2}, pathPosOK: true},
				{src: 0, path: "src/index.ts", pathPos: []int{0, 1, 2, 4, 5, 6, 7, 8}, pathPosOK: true},
			},
		},
		{
			name:    "a project word that is also in the path: the path keeps it when it is as strong",
			sources: []Source{cf, gh}, query: "ghostty readme",
			// code-foundry's docs/ghostty-tree.md has no "readme"; ghostty-playground's
			// README.md has no "ghostty", so the name takes it.
			want: []hit{{src: 1, path: "README.md", pathPos: []int{0, 1, 2, 3, 4, 5}, namePos: []int{0, 1, 2, 3, 4, 5, 6}, pathPosOK: true}},
		},
		{
			name:    "every word in the name: one must still match the path",
			sources: []Source{cf, gh}, query: "code foundry",
		},
		{
			name:    "a run of project words, each on its own",
			sources: []Source{cf, gh}, query: "foundry code tree",
			want: []hit{
				{src: 0, path: "internal/tree/tree.go", pathPos: []int{14, 15, 16, 17}, namePos: []int{0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11}, pathPosOK: true},
				{src: 0, path: "docs/ghostty-tree.md"},
			},
		},
		{
			name:    "a trailing project word, initials",
			sources: []Source{cf, gh}, query: "readme gp",
			want: []hit{{src: 1, path: "README.md", pathPos: []int{0, 1, 2, 3, 4, 5}, namePos: []int{0, 8}, pathPosOK: true}},
		},
		{
			name:    "ties go to the earlier source",
			sources: []Source{web, cf}, query: "index",
			want: []hit{{src: 0, path: "src/index.ts"}, {src: 1, path: "src/index.ts"}},
		},
		{
			name:    "ties go to the earlier source, the other order",
			sources: []Source{cf, web}, query: "index",
			want: []hit{{src: 0, path: "src/index.ts"}, {src: 1, path: "src/index.ts"}},
		},
		{
			name:    "the limit spans sources",
			sources: []Source{cf, gh}, query: "readme", limit: 1,
			want:          []hit{{src: 0, path: "README.md"}},
			wantTruncated: true,
		},
		{
			name:    "empty query: shallowest first, then path, then source",
			sources: []Source{gh, cf}, query: "", limit: 3,
			want:          []hit{{src: 0, path: "README.md"}, {src: 1, path: "README.md"}, {src: 0, path: "build.zig"}},
			wantTruncated: true,
		},
		{
			name:    "one source: the name is not used, every word must match the path",
			sources: []Source{gh}, query: "ghostty tree",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hits, truncated := RankSources(tt.sources, tt.query, tt.limit)
			var got []hit
			for _, h := range hits {
				g := hit{src: h.Source, path: tt.sources[h.Source].Paths[h.Index]}
				got = append(got, g)
				i := len(got) - 1
				if i < len(tt.want) && tt.want[i].pathPosOK {
					if !slices.Equal(h.PathPositions, tt.want[i].pathPos) || !slices.Equal(h.NamePositions, tt.want[i].namePos) {
						t.Fatalf("hit %d %q: positions path %v name %v, want %v %v", i, g.path, h.PathPositions, h.NamePositions, tt.want[i].pathPos, tt.want[i].namePos)
					}
				}
			}
			if !slices.EqualFunc(got, tt.want, func(a, b hit) bool { return a.src == b.src && a.path == b.path }) {
				t.Fatalf("RankSources(%q) = %v, want %v", tt.query, got, tt.want)
			}
			if truncated != tt.wantTruncated {
				t.Fatalf("truncated = %v, want %v", truncated, tt.wantTruncated)
			}
		})
	}
}
