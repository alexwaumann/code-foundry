package fuzzy

import (
	"slices"
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

func TestRank(t *testing.T) {
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
			ranked, truncated := Rank(paths, tt.query, tt.limit)
			var got []string
			for _, r := range ranked {
				got = append(got, paths[r.Index])
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
