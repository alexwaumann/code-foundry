package thread

import "testing"

// renderedText: a reply's markdown as its rendered plain text reads (white space aside),
// what the GUI's citation finds a quote in.
func TestRenderedText(t *testing.T) {
	tests := []struct{ name, md, want string }{
		{"plain", "just words", "just words"},
		{"strong and emphasis", "**bold** and *it* and __b__ and _i_", "bold and it and b and i"},
		{"intraword underscores stay", "snake_case and a_b_c", "snake_case and a_b_c"},
		{"unpaired markers stay", "5 * 3 = 15 and a_ b", "5 * 3 = 15 and a_ b"},
		{"strikethrough", "~~gone~~ here", "gone here"},
		{"code span is literal", "use `a_b *c*` now", "use a_b *c* now"},
		{"double ticks", "``a ` b`` c", "a ` b c"},
		{"unclosed tick stays", "a ` b", "a ` b"},
		{"link", "see [the *note*](https://x/y_z) here", "see the note here"},
		{"image", "![alt text](i.png) after", "alt text after"},
		{"brackets that are no link", "a [x] b (y)", "a [x] b (y)"},
		{"autolink", "at <https://x.dev/a_b> now", "at https://x.dev/a_b now"},
		{"escapes", `a \*star\* and \_u\_`, "a *star* and _u_"},
		{"heading", "## Title\nbody", "Title\nbody"},
		{"hash that is no heading", "#12 is the item", "#12 is the item"},
		{"block quote", "> quoted\n> > deeper", "quoted\ndeeper"},
		{"lists", "- one\n* two\n1. three\n2) four\n- [x] done", "one\ntwo\nthree\nfour\ndone"},
		{"fenced code is literal", "before\n```go\nx := a_b * c // **no**\n```\nafter", "before\n\nx := a_b * c // **no**\n\nafter"},
		{"rule", "a\n\n---\n\nb", "a\n\n\n\nb"},
		{"setext", "Title\n=====\nbody", "Title\n\nbody"},
		{"table", "| a | b_c |\n|---|:-:|\n| x\\|y | **z** |", " a  b_c \n\n x|y  z "},
		{"pipe outside a table", "a | b", "a | b"},
		{"greater than mid line", "a > b", "a > b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := renderedText([]rune(tt.md)).String(); got != tt.want {
				t.Errorf("renderedText(%q) = %q, want %q", tt.md, got, tt.want)
			}
		})
	}
}

// The map points every rendered rune at the rune it came from.
func TestRenderedTextMap(t *testing.T) {
	src := []rune("x **bold** `c_d` [l](u)")
	m := renderedText(src)
	for i, r := range m.r {
		if src[m.at[i]] != r {
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
