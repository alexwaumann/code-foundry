package fuzzy

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"
)

// benchPaths makes n repository-like paths, the same ones every run.
func benchPaths(n int) []string {
	r := rand.New(rand.NewPCG(1, 2))
	segs := []string{"src", "components", "internal", "store", "thread", "gui", "frontend", "api", "docs", "notes", "lib", "utils", "compose", "fuzzy", "terminal", "project", "mock", "gen", "codefoundry", "v1"}
	exts := []string{".go", ".ts", ".tsx", ".md", ".json", "_test.go"}
	out := make([]string, n)
	for i := range out {
		d := 1 + r.IntN(5)
		var b strings.Builder
		for range d {
			b.WriteString(segs[r.IntN(len(segs))])
			b.WriteByte('/')
		}
		fmt.Fprintf(&b, "%s%d%s", segs[r.IntN(len(segs))], i%97, exts[r.IntN(len(exts))])
		out[i] = b.String()
	}
	return out
}

// BenchmarkRankSources times one search over a 50,000-path checkout and over three,
// from one word to MaxWords (distinct one-letter words match almost every path).
func BenchmarkRankSources(b *testing.B) {
	paths := benchPaths(50000)
	one := []Source{{Name: "code-foundry", Paths: paths}}
	three := []Source{{Name: "code-foundry", Paths: paths}, {Name: "ghostty-playground", Paths: paths}, {Name: "src", Paths: paths}}
	for _, q := range []string{"composer", "comp tsx", "src comp tsx", "c o d e f", "c o d e f r s t", strings.Repeat("s ", 8)} {
		for _, c := range []struct {
			name string
			src  []Source
		}{{"1src", one}, {"3src", three}} {
			b.Run(fmt.Sprintf("%s/%s", c.name, strings.ReplaceAll(strings.TrimSpace(q), " ", "_")), func(b *testing.B) {
				for b.Loop() {
					RankSources(c.src, q, 50)
				}
			})
		}
	}
}
