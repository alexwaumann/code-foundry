package thread

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"
)

// renderedCase is one case of testdata/rendered_text.json: markdown and the text the GUI's
// markdownText reads from it (gui/frontend/scripts/renderedTextFixture.ts writes the file;
// src/lib/markdownText.test.tsx checks it against the GUI).
type renderedCase struct {
	Name     string `json:"name"`
	Markdown string `json:"markdown"`
	Text     string `json:"text"`
}

func renderedCases(t *testing.T) []renderedCase {
	t.Helper()
	b, err := os.ReadFile("testdata/rendered_text.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []renderedCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	return cases
}

// renderedText reads every shared case as the GUI does, white space runs aside (the
// verifier and the GUI's locateQuote both ignore them).
func TestRenderedTextMatchesTheGUI(t *testing.T) {
	for _, c := range renderedCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			got := squeeze(renderedText([]rune(c.Markdown))).String()
			want := strings.Join(strings.Fields(c.Text), " ")
			if got != want {
				t.Errorf("renderedText(%q)\n got %q\nwant %q (the GUI's)", c.Markdown, got, want)
			}
		})
	}
}

// The map points every rendered rune that has a source rune at one that comes from it:
// the rune itself, or (an entity, an escape, a path chip, a footnote) its place.
func TestRenderedTextMap(t *testing.T) {
	for _, c := range renderedCases(t) {
		src := []rune(c.Markdown)
		m := renderedText(src)
		last := -1
		for i, r := range m.r {
			at := m.at[i]
			if at < 0 || at > len(src) {
				t.Errorf("%s: rune %d %q maps to %d, outside the source", c.Name, i, r, at)
				continue
			}
			// In source order, but for the footnotes moved to the end.
			if at < last && !strings.Contains(c.Markdown, "[^") {
				t.Errorf("%s: rune %d %q maps to %d, before %d", c.Name, i, r, at, last)
			}
			last = at
		}
	}
	src := []rune("x **bold** `c_d` [l](u) <kbd>k</kbd> a\\*b")
	m := renderedText(src)
	for i, r := range m.r {
		if r != '\n' && src[m.at[i]] != r {
			t.Errorf("rune %d %q maps to %q", i, r, src[m.at[i]])
		}
	}
}

// quoteForm is the old regexp form, now mapped.
func TestQuoteForm(t *testing.T) {
	for in, want := range map[string]string{
		"**Do not** refetch; see [the note](https://x/y).": "Do not refetch; see the note.",
		"`thread_items`  #12 > b":                          "threaditems 12 b",
		"[a] (b) [c](d":                                    "[a] (b) [c](d",
	} {
		if got := quoteForm(in); got != want {
			t.Errorf("quoteForm(%q) = %q, want %q", in, got, want)
		}
	}
}

// Path chips: the code strictness of pathChips.ts matchPath and linkPath.
func TestMatchAndLinkPath(t *testing.T) {
	paths := []struct {
		token string
		ok    bool
	}{
		{"src/a.ts", true}, {"src/a.ts:12", true}, {"src/a.ts:12:5", true}, {"src/a.ts:0", false},
		{"README.md", true}, {"Makefile", true}, {"Node.js", false}, {"main.go", true}, {"run", false},
		{"docs/", true}, {"internal/store", true}, {"origin/main", false}, {"application/json", false},
		{"/compact", false}, {"/usr/bin", true}, {"/a.go", true}, {"~/x", true}, {"~", false}, {"./...", false},
		{"main..cf/x", false}, {"github.com/a/b", false}, {"https://x.dev/a.go", false}, {"-flag", false},
		{"@scope/pkg", false}, {"1/2", false}, {"a*b.go", false}, {"docs/my report.pdf", true},
		{"cat docs/a.md", false}, {"screen shot.png", false}, {"/a/report (1).pdf", true},
	}
	for _, p := range paths {
		if text, ok := matchPath(p.token); ok != p.ok || ok && text != p.token {
			t.Errorf("matchPath(%q) = %q, %v; want %v", p.token, text, ok, p.ok)
		}
	}
	links := []struct{ href, want string }{
		{"internal/store/search/run.go", "internal/store/search/run.go"},
		{"internal/a.go#L12-L30", "internal/a.go:12"},
		{"./docs/a.md#intro", "./docs/a.md"},
		{"a/b.go?x=1#L5", "a/b.go:5"},
		{"a/b%2Fc.go", "a/b/c.go"},
		{"100%.md", "100%.md"},
		{"about", ""}, {"#top", ""}, {"//x.dev/a.go", ""}, {"https://x.dev/a.go", ""}, {"mailto:a@b.co", ""},
		{"docs/%E2%9C%85.md", ""}, {"a/%FF.go", ""},
	}
	for _, l := range links {
		got, ok := linkPath(l.href)
		if ok != (l.want != "") || got != l.want {
			t.Errorf("linkPath(%q) = %q, %v; want %q", l.href, got, ok, l.want)
		}
	}
}

// The extension, name and head lists are pathChips.ts's.
func TestPathChipListsMatchTheGUI(t *testing.T) {
	b, err := os.ReadFile("../../../gui/frontend/src/lib/pathChips.ts")
	if err != nil {
		t.Fatal(err)
	}
	words := regexp.MustCompile(`"([^"]+)"`)
	for name, set := range map[string]map[string]bool{"EXTENSIONS": pathExtensions, "NAMES": pathNames, "REF_HEADS": refHeads, "MIME_HEADS": mimeHeads} {
		m := regexp.MustCompile(`(?s)const ` + name + `: ReadonlySet<string> = new Set\(\[(.*?)\]\);`).FindSubmatch(b)
		if m == nil {
			t.Errorf("%s not found in pathChips.ts", name)
			continue
		}
		var gui, ours []string
		for _, w := range words.FindAllSubmatch(m[1], -1) {
			gui = append(gui, string(w[1]))
		}
		for w := range set {
			ours = append(ours, w)
		}
		sort.Strings(gui)
		sort.Strings(ours)
		if !slices.Equal(gui, ours) {
			t.Errorf("%s: pathChips.ts has %q, search_paths.go %q", name, gui, ours)
		}
	}
}
