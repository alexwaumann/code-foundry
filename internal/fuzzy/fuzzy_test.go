package fuzzy

import (
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
		{"one source: as typed", "ghostty  tree", "ghostty-playground", false, []Split{{Path: "ghostty  tree"}}},
		{"empty query", "", "ghostty-playground", true, []Split{{Path: ""}}},
		{"one word never takes the name", "ghostty", "ghostty-playground", true, []Split{{Path: "ghostty"}}},
		{"leading word", "ghostty tree", "ghostty-playground", true,
			[]Split{{Path: "ghostty tree"}, {Path: "tree", Name: []string{"ghostty"}}}},
		{"trailing word", "tree gp", "ghostty-playground", true,
			[]Split{{Path: "tree gp"}, {Path: "tree", Name: []string{"gp"}}}},
		{"name words not in the name", "ghostty tree", "code-foundry", true, []Split{{Path: "ghostty tree"}}},
		{"a run of words, joined", "code foundry readme", "code-foundry", true, []Split{
			{Path: "code foundry readme"}, {Path: "foundry readme", Name: []string{"code"}},
			{Path: "readme", Name: []string{"code", "foundry"}},
		}},
		{"a word in the middle stays on the path", "readme foundry tree", "code-foundry", true, []Split{{Path: "readme foundry tree"}}},
		{"words out of the name's order", "foundry code readme", "code-foundry", true, []Split{
			{Path: "foundry code readme"}, {Path: "code readme", Name: []string{"foundry"}},
		}},
		{"whitespace collapses", "  web\t index ", "web", true,
			[]Split{{Path: "web index"}, {Path: "index", Name: []string{"web"}}}},
		{"case-insensitive", "Ghostty tree", "ghostty-playground", true,
			[]Split{{Path: "Ghostty tree"}, {Path: "tree", Name: []string{"Ghostty"}}}},
		{"same path query listed once", "a a", "a", true, []Split{{Path: "a a"}, {Path: "a", Name: []string{"a"}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Splits(strings.TrimSpace(tt.query), tt.project, tt.multi)
			if !slices.EqualFunc(got, tt.want, func(a, b Split) bool { return a.Path == b.Path && slices.Equal(a.Name, b.Name) }) {
				t.Fatalf("Splits(%q, %q) = %q, want %q", tt.query, tt.project, got, tt.want)
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
				{src: 1, path: "src/tree.zig", pathPos: []int{4, 5, 6, 7}, namePos: []int{0, 1, 2, 3, 4, 5, 6}, pathPosOK: true},
				// code-foundry has no "ghostty" in its name, so the whole query goes to the
				// path, space included, and docs/ghostty-tree.md does not match it.
				{src: 1, path: "src/subtree/x.zig", pathPos: []int{7, 8, 9, 10}, namePos: []int{0, 1, 2, 3, 4, 5, 6}, pathPosOK: true},
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
			name:    "one source: a space is part of the query, the name is not used",
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
